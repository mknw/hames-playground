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
 * References from the **most recent** retriever `tool_result` in the stream
 * (one retriever call per turn). Returns `[]` when there's no retriever result.
 */
export function extractReferences(events: ContextEvent[]): RetrievalReference[] {
  for (let i = events.length - 1; i >= 0; i--) {
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
