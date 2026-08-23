/**
 * Reference Extractor (client-safe)
 *
 * Pulls the retriever's typed `references` out of the event stream, mirroring
 * `graph-extractor.ts` (which pulls graph nodes from tool_results). The retriever
 * emits a {@link RetrieverResult} as its `tool_result.result`, carrying
 * `references: RetrievalReference[]` (source + docId + char offsets) — the
 * locatable subset the chat citations + inline file viewer consume.
 *
 * Types are imported type-only, so this stays client-safe (no server import).
 */
import type {
  ContextEvent,
  ToolResultEventData,
  RetrievalReference,
  RetrieverResult,
} from '~/lib/harness-patterns'
// Value import: the turn boundary is shared with the Data Stash partition, so
// both derive "this turn" from one definition (see SA-H7).
import { findLastUserMessageIndex } from '~/lib/turn-utils'

/**
 * The payload a chat citation passes across panes to open the inline viewer.
 * `docId` is required; the optional offsets focus a specific chunk (footer chips
 * pass them; an inline filename superscript omits them → opens at chunk 0).
 */
export interface OpenReferenceTarget {
  docId: string
  startOffset?: number
  endOffset?: number
}

/**
 * References from the retriever `tool_result` of the **current turn** — the
 * scan runs backwards from the end of the stream and stops at the last
 * `user_message`. Returns `[]` when this turn had no retriever result.
 *
 * The turn bound is the whole point (SA-H7): `events` is the *accumulated*
 * stream, so an unbounded scan let a neo4j-only or web-only turn inherit the
 * previous turn's citations. Those render as clickable provenance on an answer
 * that was never derived from them, and open the wrong chunks — fabricated
 * sourcing, which is worse than no sourcing.
 */
export function extractReferences(events: ContextEvent[]): RetrievalReference[] {
  const turnStart = findLastUserMessageIndex(events)
  for (let i = events.length - 1; i > turnStart; i--) {
    const e = events[i]
    if (e.type !== 'tool_result') continue
    const data = e.data as ToolResultEventData
    if (data?.tool !== 'retriever') continue
    const result = data.result as Partial<RetrieverResult> | undefined
    return Array.isArray(result?.references) ? result.references : []
  }
  return []
}

/** References for a single document, sorted by position in the source text. */
export function referencesForDoc(
  events: ContextEvent[],
  docId: string,
): RetrievalReference[] {
  return extractReferences(events)
    .filter((r) => r.docId === docId)
    .sort((a, b) => a.startOffset - b.startOffset)
}
