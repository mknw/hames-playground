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
  ContextEvent,
  PatternScope,
  EventView,
  ConfiguredPattern,
  PatternCapabilities,
  PatternConfig,
  UserMessageEventData,
  AssistantMessageEventData,
  ToolResultEventData,
  ErrorEventData,
  WarningEventData,
  LLMCallData,
  RetrieveQueryFn,
} from '../types'
import { trackEvent, resolveConfig } from '../context.server'
import { currentRunFrame } from '../run-frame.server'
import { getErrorHint } from '../error-hints'
import { trimToFit } from '../token-budget.server'
import { removeThinkBlocks } from '../content-transforms'
import type { IngressMark } from '../injection-guard'
import { LLMCallError } from '../types'

assertServerOnImport()

// ============================================================================
// Public contract — the backend interface + result shape
// ============================================================================

/** A normalized retrieval result. `score` semantics depend on the backend and
 *  on whether the multi-backend RRF merge ran — see the field's own comment. */
export interface RetrievalHit {
  /** Persisted non-content origin of the source document, when promoted. */
  provenance?: 'sandbox-output'
  /** Which backend produced this hit (e.g. 'redis', 'supabase'). */
  backend: string
  /** Stable id/reference for the match within its backend. */
  id: string
  /** The matched text. */
  content: string
  /** Optional human-facing source label (filename, table, url, …). */
  source?: string
  /**
   * Per-backend score. The vector backends report a distance (lower = closer);
   * the keyword backend reports BM25 relevance (higher = more relevant). After
   * the multi-backend RRF merge (#928 slice 1) a match's score is its RRF score
   * (higher = better) — never comparable with a raw per-backend score, and
   * never comparable ACROSS backends, which is why the merge is rank-based.
   */
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
  /**
   * Total chunk count of this hit's source document, when the backend knows it
   * (#927). Absent for a document with no recorded count — never fabricated
   * as 0.
   */
  docChunks?: number
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
  search(
    query: { text: string; intent?: string },
    opts: { k: number; excludeIds?: string[] },
  ): Promise<RetrievalHit[]>
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
  /**
   * Opt-in paging (#927 slice 2): when true, the retriever excludes the chunk
   * ids it already returned for this route in this turn — the decision loop
   * exposes earlier same-route events to a re-dispatched route — so a repeat
   * dispatch of the same route advances through a long document instead of
   * returning the same k chunks. The exclusion is a search-time filter
   * (`searchDocuments`' `excludeIds`), so hidden documents never shrink a page
   * below k.
   */
  page?: boolean
}

export interface RetrieverData {
  /** Optional context hint (e.g. the router's classified intent) passed through
   *  to backends alongside the query — NOT the query itself. */
  intent?: string
  /** Output: the normalized matches (also emitted as a tool_result). */
  matches?: RetrievalHit[]
}
// ============================================================================
// Reciprocal-rank fusion — the multi-backend merge (#928 slice 1)
// ============================================================================

/**
 * Each backend's ranking contributes `1 / (K + rank)` per hit (rank is 1-based
 * within that backend's list); a hit's fused score is the SUM of its
 * contributions across the lists it appears in, and the merged order is by
 * fused score, descending. Rank-based fusion needs no cross-backend score
 * comparability — a vector backend reports a distance while a keyword one
 * reports BM25 relevance — which is exactly why it replaces the distance-only
 * sort the moment more than one backend is configured.
 *
 * Duplicate ids (the same chunk found by more than one backend) collapse into
 * ONE merged hit that keeps the FIRST occurrence's fields (backend order is
 * list order) and sums the rank contributions — agreement between backends
 * raises a hit, it does not duplicate it. Ties in the fused score keep
 * first-encountered order: `Array.prototype.sort` is stable, so a tie sorts by
 * whichever hit appeared first across the backends in list order — a
 * deterministic order, never a run-to-run coin flip.
 *
 * K — the classic constant, kept at its canonical value. Source: Cormack,
 * Clarke & Buettcher (2009), "Reciprocal Rank Fusion Outperforms Condorcet and
 * Individual Rank Learning Methods" (SIGIR), which reports its best results at
 * k=60 and whose experiments showed ranking quality insensitive to k across
 * 0 < k ≤ 60; the value is also the default `rank_constant` of the RRF
 * rankers in Elasticsearch and OpenSearch. Larger k flattens the head of each
 * list (one backend's rank-1 hit counts less against another list's rank-3).
 *
 * On the fused path each returned hit's `score` is its RRF score — higher is
 * better, and NOT the per-backend distance it carried coming in.
 */
export const RRF_K = 60

export function reciprocalRankFusion(
  lists: RetrievalHit[][],
  k: number,
  constant: number = RRF_K,
): RetrievalHit[] {
  const byId = new Map<string, { hit: RetrievalHit; rrf: number }>()
  for (const list of lists) {
    for (let i = 0; i < list.length; i++) {
      const hit = list[i]
      const rrf = 1 / (constant + i + 1)
      const seen = byId.get(hit.id)
      if (seen) {
        seen.rrf += rrf
      } else {
        byId.set(hit.id, { hit, rrf })
      }
    }
  }
  return [...byId.values()]
    .sort((a, b) => b.rrf - a.rrf)
    .slice(0, k)
    .map(({ hit, rrf }) => ({ ...hit, score: rrf }))
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
    page = false,
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
            content: removeThinkBlocks(
              (e.data as UserMessageEventData | AssistantMessageEventData).content ?? '',
            ),
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
            // message so retrieval still runs. A `warning`, not an `error`
            // (#420): the search itself is unaffected, so nothing about it may
            // reach the error readers (the synthesizer's apology, the
            // failed-turn rule). The injected implementation carries the record
            // on `LLMCallError` (the throw contract).
            const msg = err instanceof Error ? err.message : String(err)
            trackEvent(
              scope,
              'warning',
              {
                task: 'query_rewrite',
                message: 'The search query could not be rewritten from the conversation.',
                fallback: 'The documents were searched with your message as written.',
                error: msg,
              } satisfies WarningEventData,
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

      // With paging enabled, exclude the chunk ids this route already returned
      // in this turn: the decision loop exposes earlier same-route events to a
      // re-dispatched route, so a repeat dispatch advances instead of repeating
      // (#927 slice 2). The ids ride to `searchDocuments` as a search-time
      // filter, so hidden documents never shrink a page below k. Scoping keys
      // on the route (patternId), not the tool name, and on the CURRENT TURN —
      // the slice starting at the last `user_message` event, the same boundary
      // rule `sliceByLastNTurns` derives turns by (event-view.server.ts). No
      // event carries a `turn` field (`createEvent` sets none), so the boundary
      // is derived from the stream, never read off an event: an earlier turn's
      // results stay eligible for re-retrieval, so a fresh question starts from
      // the top of the document again.
      const excludeIds =
        page && view.exists()
          ? (() => {
              const contextEvents = view.unfiltered().get()
              let turnStart = 0
              for (let i = contextEvents.length - 1; i >= 0; i--) {
                if (contextEvents[i]!.type === 'user_message') {
                  turnStart = i
                  break
                }
              }
              return contextEvents.slice(turnStart).flatMap((e) => {
                if (e.patternId !== scope.id) return []
                const d = e.data as ToolResultEventData
                const r = d.result as RetrieverResult | undefined
                return (r?.matches ?? []).map((m) => m.id)
              })
            })()
          : undefined

      // Fan out to all backends concurrently; a failing backend yields [] and an
      // error event rather than sinking the whole retrieval.
      const perBackend = await Promise.all(
        backends.map(async (backend) => {
          try {
            return await backend.search({ text, intent }, { k, excludeIds })
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

      // Merge. One backend keeps the distance-only sort — the behaviour the
      // single-backend case has always had, unchanged (#928 slice 1). More
      // than one backend is fused by reciprocal rank, which needs no
      // cross-backend score comparability; see {@link reciprocalRankFusion}.
      const merged =
        backends.length > 1
          ? reciprocalRankFusion(perBackend, k)
          : perBackend
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
      const { hits: matches, ingress } = await sanitizeHits(merged)

      scope.data = { ...scope.data, matches }
      emitMatches(scope, matches, backendKinds, text, resolved.trackHistory, llmCall, ingress)
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
 * `withInjectionGuard`, if any. Outside a guard wrapper the hits are
 * returned by reference and nothing is classified.
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
async function sanitizeHits(hits: RetrievalHit[]): Promise<{
  hits: RetrievalHit[]
  /** One `ingress` mark per classified hit — the classification is one
   *  Decide call per hit's CONTENT (O37: the screen would have been two, and
   *  the filename opts out, like every non-content field). */
  ingress: IngressMark[]
}> {
  const guard = currentRunFrame()?.guard
  if (!guard || hits.length === 0 || !guard.isUntrusted('retriever')) return { hits, ingress: [] }

  // The hits are sanitized CONCURRENTLY (security review SHOULD-8): each
  // classification can wait up to its own deadline, so one after another a
  // k-hit retrieval would wait up to k × that deadline while the decisions
  // host is slow or down. The results keep the hits' order.
  const scanned = await Promise.all(
    hits.map(async (hit) => {
      // `content` gets the full treatment. `source` is a FILENAME, and it is
      // scanned separately with the fence switched off: a benign document called
      // "New instructions for expenses.docx" matches `instruction-new-directive`,
      // and wrapping a filename in a multi-line spotlight fence would break the
      // citation label AND the filename-to-docId match that drives the inline
      // viewer (see ChatMessages.tsx). Marker-only keeps it a single line, so a
      // poisoned filename is still neutralized without collateral damage. The
      // content's fence names the hit's `docId` as its item id; a hit with none
      // (a web hit) names no item, and the filename is never one (it is content).
      // The classification follows the same split (`ingress: false` on the
      // filename): ONE classification call per hit.
      const [scannedContent, scannedSource] = await Promise.all([
        guard.sanitize('retriever', hit.content, { item: hit.docId }),
        hit.source === undefined
          ? undefined
          : guard.sanitize('retriever', hit.source, {
              spotlight: 'off',
              ingress: false,
            }),
      ])
      return { hit, scannedContent, scannedSource }
    }),
  )

  const out: RetrievalHit[] = []
  const ingress: IngressMark[] = []
  let changed = false
  for (const { hit, scannedContent, scannedSource } of scanned) {
    if (scannedContent.ingress) ingress.push(scannedContent.ingress)
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
  return { hits: changed ? out : hits, ingress }
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
 *  `RetrieveQuery` observability when the query was rewritten. The `ingress`
 *  marks ride the event as metadata, one per classified hit (O37: a cited
 *  chunk can be marked at the chip — slice 18 reads them from here). */
function emitMatches<T>(
  scope: PatternScope<T>,
  matches: RetrievalHit[],
  backendKinds: string[],
  query: string,
  trackHistory: Parameters<typeof trackEvent>[3],
  llmCall?: LLMCallData,
  ingress: readonly IngressMark[] = [],
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
      ...(ingress.length ? { ingress: [...ingress] } : {}),
    } as ToolResultEventData,
    trackHistory,
    llmCall,
  )
}
