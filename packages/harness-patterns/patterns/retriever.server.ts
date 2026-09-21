/**
 * retriever Pattern
 *
 * A low-latency alternative to a tool-calling `simpleLoop`: instead of an LLM
 * loop deciding which DB tool to call (often >30s for a Neo4j loop), the
 * retriever forms ONE search query from context and fans it out to one or more
 * injected DB **backends**, returning normalized matches-with-references (or
 * none) for a downstream `compactExecution`.
 *
 * Typical composition (the query is pre-compacted by `compactIntent`):
 *
 *   harness(
 *     router(),
 *     routes({
 *       retriever: chain(compactIntent(), retriever({ backends: [redisBackend] })),
 *       neo4j: simpleLoop(neo4jController, tools.neo4j),
 *       web:   simpleLoop(webController, tools.web),
 *     }),
 *     compactExecution(),
 *   )
 *
 * Framework-pure: the concrete backends (redis vector, Supabase, …) are app-side
 * and injected via config, so this file has no app dependencies. Each backend
 * self-describes its `type` and owns its query transform — a `vector` backend
 * embeds internally (local) or sends text for server-side embedding (Supabase).
 *
 * Query source: the previous pattern's compacted `scope.data.intent` if present,
 * else the last user message; optionally widened with the last-N user turns.
 * The matches are written to `scope.data.matches` AND emitted as a `tool_result`
 * event so the compactExecution consumes them via `view.fromLastPattern()`.
 */

import { assertServerOnImport } from '../assert.server'
import type {
  PatternScope,
  EventView,
  ConfiguredPattern,
  PatternCapabilities,
  PatternConfig,
  UserMessageEventData,
  AssistantMessageEventData,
  ToolResultEventData,
  ErrorEventData,
  LLMCallData,
  RetrieveQueryFn,
} from '../types'
import { trackEvent, resolveConfig } from '../context.server'
import { getActiveInjectionGuard } from '../injection-guard-scope.server'
import { getErrorHint } from '../error-hints'
import { trimToFit } from '../token-budget.server'
import { LLMCallError } from '../types'

assertServerOnImport()

// ============================================================================
// Public contract — the backend interface + result shape
// ============================================================================

/** A normalized retrieval result. `score` is a distance (lower = closer) when
 *  the backend reports one; cross-backend comparability is best-effort. */
export interface RetrievalHit {
  /** Which backend produced this hit (e.g. 'redis', 'supabase'). */
  backend: string
  /** Stable id/reference for the match within its backend. */
  id: string
  /** The matched text. */
  content: string
  /** Optional human-facing source label (filename, table, url, …). */
  source?: string
  /** Distance (lower = closer) when available. */
  score?: number
  /**
   * Locator into the source document, when the backend can provide one — char
   * offsets into the doc's stored text (`content === docText.slice(start,end)`).
   * Promotes what was backend-specific `metadata` to a typed, first-class shape
   * so the retriever can build {@link RetrievalReference}s generically and the UI
   * can open an inline file viewer at the right place. Absent for backends with
   * no locatable source (e.g. web).
   */
  docId?: string
  chunkIndex?: number
  startOffset?: number
  endOffset?: number
  /** Anything else a backend wants to attach (non-standard, untyped). */
  metadata?: Record<string, unknown>
}

/**
 * A locatable pointer into a source document — the UI-facing projection of a
 * {@link RetrievalHit} that carries a locator. Char offsets are into the doc's
 * stored text; line numbers are derived on open (the viewer fetches the doc).
 */
export interface RetrievalReference {
  /** Human-facing source label (filename). */
  source: string
  /** Stash document id — fetch its text to render the viewer. */
  docId: string
  chunkIndex: number
  startOffset: number
  endOffset: number
  /** Distance (lower = closer) when available. */
  score?: number
}

/**
 * The `result` payload of the retriever's `tool_result` event — the typed
 * envelope consumers narrow to (compactExecution prompt, reference chips, viewer).
 * `matches` carry the full text (for the compactExecution); `references` are the
 * locatable subset for the UI.
 */
export interface RetrieverResult {
  query: string
  backends: string[]
  matches: RetrievalHit[]
  references: RetrievalReference[]
}

/**
 * A retrieval backend. The retriever fans the query out to each. Backends own
 * their query transform: `vector` backends embed (locally or server-side),
 * others (future: keyword/web/graph) use the text directly.
 */
export interface RetrieverBackend {
  name: string
  type: 'vector' | 'keyword' | 'graph' | 'web'
  search(query: { text: string; intent?: string }, opts: { k: number }): Promise<RetrievalHit[]>
}

export interface RetrieverConfig extends PatternConfig {
  /** DB backends to query (injected by the agent at construction). */
  backends: RetrieverBackend[]
  /** Max hits to return (per backend cap + final cap). Default 5. */
  k?: number
  /**
   * REQUIRED (Lane A6 seam): the query-rewrite implementation —
   * `bamlPatterns().retrieveQuery` from `harness-baml`, or your own. Core
   * hosts no BAML default any more, so there is no fallback. Invoked only
   * when `generateQuery` is set AND the conversation has history.
   */
  rewrite: RetrieveQueryFn
  /**
   * Rewrite the query with the injected rewrite fn **only when the
   * conversation has history** — to resolve back-references ("more on that",
   * "those sections") into a self-contained search query. Turn-1 messages are
   * already standalone, so they're searched verbatim (no call). Off by default:
   * the raw last user message is the query. Mutually exclusive with `turnWindow`
   * (this wins when both are set and history exists).
   */
  generateQuery?: boolean
  /** No-LLM alternative to `generateQuery`: build the query from the last N user
   *  turns joined, instead of just the last message. Default: last message. */
  turnWindow?: number
}

export interface RetrieverData {
  /** Optional context hint (e.g. the router's classified intent) passed through
   *  to backends alongside the query — NOT the query itself. */
  intent?: string
  /** Output: the normalized matches (also emitted as a tool_result). */
  matches?: RetrievalHit[]
}

// ============================================================================
// Pattern
// ============================================================================

export function retriever<T extends RetrieverData>(config: RetrieverConfig): ConfiguredPattern<T> {
  const {
    backends = [],
    k = 5,
    turnWindow,
    rewrite,
    generateQuery = false,
    ...patternConfig
  } = config
  const backendKinds = backends.map((b) => b.name)

  const resolved = resolveConfig('retriever', { patternId: 'retriever', ...patternConfig })
  // The backends this pattern will query, declared for static introspection —
  // it lets a host answer "is there a retriever wired to backend X in here"
  // (`harnessHasRedisRetriever`, the upload auto-ingest gate) without running
  // the harness. Typed, so a rename of the field is a compile error here and in
  // every probe that reads it; it used to be a `backendKinds` key cast onto the
  // resolved config, which is a rename nothing would have caught.
  const capabilities: PatternCapabilities = { retrievalBackends: backendKinds }

  const fn = async (scope: PatternScope<T>, view: EventView): Promise<PatternScope<T>> => {
    try {
      // The query is the raw last user message by default — we want the user's
      // own words against the embedding index, not a verbose paraphrase. Two
      // opt-in overrides: `generateQuery` (LLM rewrite, only with history) and
      // `turnWindow` (no-LLM concat of recent turns).
      const msgs = view.fromAll().messages().get()
      const lastUser = [...msgs].reverse().find((e) => e.type === 'user_message')
      const latest = lastUser ? (lastUser.data as UserMessageEventData).content : ''

      let text = latest
      let llmCall: LLMCallData | undefined

      if (latest && generateQuery) {
        const rawHistory = msgs
          .filter((e) => e !== lastUser)
          .map((e) => ({
            role: e.type === 'user_message' ? 'user' : 'assistant',
            content: (
              (e.data as UserMessageEventData | AssistantMessageEventData).content ?? ''
            ).replace(/<think>[\s\S]*?<\/think>\s*/g, ''),
          }))
          .filter((m) => m.content.trim().length > 0)
        // Only rewrite when there's history to resolve against — turn 1 is
        // already a standalone query, so it's searched verbatim (no LLM call).
        if (rawHistory.length > 0) {
          // Trim against the window of the client the rewrite call will
          // actually take — read off the INJECTED fn's own `limits()` (Lane A6).
          const contextWindow = rewrite.limits?.().contextWindow ?? 16_384
          const trimmedHistory = trimToFit(rawHistory, (h) => JSON.stringify(h), 300, contextWindow)
          try {
            const { value: rewritten, call } = await rewrite({
              history: trimmedHistory,
              latest,
            })
            text = rewritten
            llmCall = call as LLMCallData | undefined
          } catch (err) {
            // Recoverable by contract: a failed rewrite falls back to the raw
            // message so retrieval still runs. The injected implementation
            // carries the record on `LLMCallError` (the throw contract).
            const msg = err instanceof Error ? err.message : String(err)
            trackEvent(
              scope,
              'error',
              {
                error: `retriever query rewrite: ${msg}`,
                severity: resolved.errorSeverity,
                hint: getErrorHint(msg),
                kind: 'llm_call' as const,
              } as ErrorEventData,
              true,
              err instanceof LLMCallError ? (err.llmCall as LLMCallData) : undefined,
            )
            text = latest
          }
        }
      } else if (latest && turnWindow && turnWindow > 0) {
        const recent = view
          .fromLastNTurns(turnWindow)
          .ofType('user_message')
          .get()
          .map((e) => (e.data as UserMessageEventData).content)
          .filter(Boolean)
        text = (recent.length ? recent.join('\n') : latest).trim()
      }

      if (!text || backends.length === 0) {
        scope.data = { ...scope.data, matches: [] }
        emitMatches(scope, [], backendKinds, text, resolved.trackHistory, llmCall)
        return scope
      }

      // Optional context hint passed to backends alongside the query.
      const intent = (scope.data as RetrieverData).intent

      // Fan out to all backends concurrently; a failing backend yields [] and an
      // error event rather than sinking the whole retrieval.
      const perBackend = await Promise.all(
        backends.map(async (backend) => {
          try {
            return await backend.search({ text, intent }, { k })
          } catch (err) {
            trackEvent(
              scope,
              'error',
              {
                error: `retriever backend "${backend.name}": ${err instanceof Error ? err.message : String(err)}`,
                severity: resolved.errorSeverity,
              } as ErrorEventData,
              true,
            )
            return [] as RetrievalHit[]
          }
        }),
      )

      // Merge, closest-first (hits without a score sort last), capped at k.
      const merged = perBackend
        .flat()
        .sort((a, b) => (a.score ?? Infinity) - (b.score ?? Infinity))
        .slice(0, k)

      // Injection guard, second coverage path. Retrieved chunks NEVER pass
      // through `callTool` — the backends are injected app-side objects called
      // directly above — so the primary chokepoint cannot see them. Yet stash
      // content is ingested from documents (SharePoint included), which is
      // exactly the untrusted class this guard exists for. Sanitizing here, at
      // write-time, is what puts it under the same control: it happens before
      // `scope.data.matches` is set and before the `tool_result` event exists,
      // so no LLM-visible surface (synthesizer prompt, ref: expansion, UI) ever
      // holds the raw text. A read-time `contentTransform` would have covered
      // only the views that opt into it, and not `scope.data`.
      const matches = await sanitizeHits(merged)

      scope.data = { ...scope.data, matches }
      emitMatches(scope, matches, backendKinds, text, resolved.trackHistory, llmCall)
      return scope
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      trackEvent(
        scope,
        'error',
        { error: msg, severity: resolved.errorSeverity, hint: getErrorHint(msg) } as ErrorEventData,
        true,
      )
      // `scope.data` survives the turn boundary, so returning it untouched
      // would leave the PREVIOUS turn's matches for the synthesizer to cite as
      // if they answered this question. Mirror the no-query/no-backend early
      // return above and hand downstream an honest empty result. (No
      // `emitMatches` here: the error event is the report for this path.)
      scope.data = { ...scope.data, matches: [] }
      return scope
    }
  }

  return { name: 'retriever', fn, config: resolved, capabilities, estimateTurns: () => 0 }
}

/**
 * Sanitize the untrusted text of each hit through the active
 * `withInjectionGuard`, if any. Outside a guard wrapper this is an identity
 * function and the hits are returned by reference.
 *
 * Only `content` and `source` are scanned: those are the free-text fields an
 * ingested document controls. Ids, offsets and scores are structural — a
 * retriever hit's `docId` and offsets must stay byte-exact or the inline file
 * viewer would open at the wrong place.
 *
 * The guard is keyed on the tool name `'retriever'` (so an agent opts in with
 * `tools: ['retriever']` — an exact-name declaration, #242 item 4: it is this
 * pattern's own sanitize key, never a namespace any tool name infers to), and
 * each hit is sanitized separately so a
 * single poisoned chunk is neutralized and reported without touching the rest.
 * Emitting the `content_sanitized` event is the guard's own contract, so there
 * is nothing to track here.
 */
async function sanitizeHits(hits: RetrievalHit[]): Promise<RetrievalHit[]> {
  const guard = getActiveInjectionGuard()
  if (!guard || hits.length === 0 || !guard.isUntrusted('retriever')) return hits

  const out: RetrievalHit[] = []
  let changed = false
  for (const hit of hits) {
    // `content` gets the full treatment. `source` is a FILENAME, and it is
    // scanned separately with the fence switched off: a benign document called
    // "New instructions for expenses.docx" matches `instruction-new-directive`,
    // and wrapping a filename in a multi-line spotlight fence would break the
    // citation label AND the filename-to-docId match that drives the inline
    // viewer (see ChatMessages.tsx). Marker-only keeps it a single line, so a
    // poisoned filename is still neutralized without collateral damage.
    const scannedContent = await guard.sanitize('retriever', hit.content)
    const scannedSource =
      hit.source === undefined
        ? undefined
        : await guard.sanitize('retriever', hit.source, { spotlight: 'off' })

    // Compare by REFERENCE, not by `summary` presence: `spotlight: 'always'`
    // fences a chunk on which nothing was detected, and that fence must reach
    // `scope.data.matches` even though there is no finding to annotate.
    if (scannedContent.data === hit.content && scannedSource?.data === hit.source) {
      out.push(hit)
      continue
    }
    changed = true
    out.push({
      ...hit,
      content: scannedContent.data as string,
      ...(scannedSource ? { source: scannedSource.data as string } : {}),
    })
  }
  return changed ? out : hits
}

/** Project a hit to a locatable reference, or null when it has no source
 *  locator (e.g. a web hit) — those can't drive the inline file viewer. */
function toReference(h: RetrievalHit): RetrievalReference | null {
  if (
    !h.source ||
    h.docId === undefined ||
    h.startOffset === undefined ||
    h.endOffset === undefined
  ) {
    return null
  }
  return {
    source: h.source,
    docId: h.docId,
    chunkIndex: h.chunkIndex ?? 0,
    startOffset: h.startOffset,
    endOffset: h.endOffset,
    score: h.score,
  }
}

/** Emit the retrieval as a `tool_result` so the compactExecution reads it via
 *  `view.fromLastPattern()` (same channel a simpleLoop tool call uses). The
 *  result is a typed {@link RetrieverResult}. The optional `llmCall` carries
 *  `RetrieveQuery` observability when the query was rewritten. */
function emitMatches<T>(
  scope: PatternScope<T>,
  matches: RetrievalHit[],
  backendKinds: string[],
  query: string,
  trackHistory: Parameters<typeof trackEvent>[3],
  llmCall?: LLMCallData,
): void {
  const references = matches.map(toReference).filter((r): r is RetrievalReference => r !== null)
  const result: RetrieverResult = { query, backends: backendKinds, matches, references }
  trackEvent(
    scope,
    'tool_result',
    {
      tool: 'retriever',
      result,
      success: true,
      summary: matches.length
        ? `${matches.length} match(es) from ${backendKinds.join(', ') || 'no backends'}`
        : 'no matches',
    } as ToolResultEventData,
    trackHistory,
    llmCall,
  )
}
