/**
 * retriever Pattern
 *
 * A low-latency alternative to a tool-calling `simpleLoop`: instead of an LLM
 * loop deciding which DB tool to call (often >30s for a Neo4j loop), the
 * retriever forms ONE search query from context and fans it out to one or more
 * injected DB **backends**, returning normalized matches-with-references (or
 * none) for a downstream `synthesizer`.
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
 *     synthesizer(),
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
 * event so the synthesizer consumes them via `view.fromLastPattern()`.
 */

import { assertServerOnImport } from '../assert.server'
import { Collector } from '@boundaryml/baml'
import type {
  PatternScope,
  EventView,
  ConfiguredPattern,
  PatternConfig,
  UserMessageEventData,
  AssistantMessageEventData,
  ToolResultEventData,
  ErrorEventData,
  LLMCallData,
} from '../types'
import { trackEvent, resolveConfig } from '../context.server'
import { getErrorHint } from '../error-hints'
import { trimToFit, getContextWindow } from '../token-budget.server'
import { extractLLMCallData, extractFailureLLMCallData } from '../baml-adapters.server'
import { clientOverrideFor, resolveClientForRole } from '../clients.server'

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
 * envelope consumers narrow to (synthesizer prompt, reference chips, viewer).
 * `matches` carry the full text (for the synthesizer); `references` are the
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
  search(
    query: { text: string; intent?: string },
    opts: { k: number },
  ): Promise<RetrievalHit[]>
}

export interface RetrieverConfig extends PatternConfig {
  /** DB backends to query (injected by the agent at construction). */
  backends: RetrieverBackend[]
  /** Max hits to return (per backend cap + final cap). Default 5. */
  k?: number
  /**
   * Rewrite the query with a cheap `RetrieveQuery` LLM call **only when the
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

/** Marker the resolved config carries so `pattern-capabilities` can answer
 *  "does this harness contain a retriever wired to backend X" without running
 *  it (mirrors the code-mode `dynamicToolPattern` probe). */
export interface RetrieverConfigMarker extends PatternConfig {
  backendKinds?: string[]
}

// ============================================================================
// Pattern
// ============================================================================

export function retriever<T extends RetrieverData>(
  config: RetrieverConfig,
): ConfiguredPattern<T> {
  const { backends = [], k = 5, turnWindow, generateQuery = false, ...patternConfig } = config
  const backendKinds = backends.map((b) => b.name)

  const resolved = resolveConfig('retriever', { patternId: 'retriever', ...patternConfig })
  // Stamp the backend kinds onto the resolved config for static introspection.
  ;(resolved as RetrieverConfigMarker).backendKinds = backendKinds

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
          const rewritten = await rewriteQuery(scope, rawHistory, latest, resolved)
          text = rewritten.text
          llmCall = rewritten.llmCall
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
      const matches = perBackend
        .flat()
        .sort((a, b) => (a.score ?? Infinity) - (b.score ?? Infinity))
        .slice(0, k)

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
      return scope
    }
  }

  return { name: 'retriever', fn, config: resolved, estimateTurns: () => 0 }
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

/** Emit the retrieval as a `tool_result` so the synthesizer reads it via
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
  const references = matches
    .map(toReference)
    .filter((r): r is RetrievalReference => r !== null)
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

/**
 * Rewrite the latest message into a concise search query via the `RetrieveQuery`
 * BAML call (cheap describe-tier client). Best-effort: on failure it returns the
 * raw latest text and tracks a recoverable error, so retrieval still runs.
 */
async function rewriteQuery<T>(
  scope: PatternScope<T>,
  history: Array<{ role: string; content: string }>,
  latest: string,
  resolved: ReturnType<typeof resolveConfig>,
): Promise<{ text: string; llmCall?: LLMCallData }> {
  const collector = new Collector('retriever')
  const startTime = Date.now()
  const contextWindow = getContextWindow(resolveClientForRole('describe'))
  const trimmed = trimToFit(history, (h) => JSON.stringify(h), 300, contextWindow)
  const variables = { history: trimmed, latest }
  try {
    const { b } = await import('../../../../baml_client')
    const opts = { collector, ...clientOverrideFor('describe') }
    const raw = await b.RetrieveQuery(trimmed, latest, opts)
    const text = raw.trim() || latest
    return { text, llmCall: extractLLMCallData(collector, 'RetrieveQuery', variables, startTime, text) }
  } catch (err) {
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
      extractFailureLLMCallData(collector, 'RetrieveQuery', variables, startTime),
    )
    return { text: latest }
  }
}
