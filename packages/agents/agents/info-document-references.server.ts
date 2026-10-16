/** R1 flow 4: sandbox deliverables remain available to document/user routes,
 * but cannot become info references through a subsequent stash retrieval. */
import {
  createEventView,
  type ConfiguredPattern,
  type ContextEvent,
  type RetrieverResult,
  type ToolResultEventData,
  type UnifiedContext,
} from '@hames-ai/harness-patterns'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'

assertServerOnImport()

function infoEvent(event: ContextEvent): ContextEvent[] {
  if (event.type !== 'tool_result') return [event]
  const data = event.data as ToolResultEventData
  if (data.tool !== 'retriever') return [event]
  const result = data.result as RetrieverResult
  if (!Array.isArray(result?.matches)) return [event]
  // The private host can rewrite string VALUES while preserving object keys.
  // Presence is the boundary: a rewritten provenance must still be excluded.
  const matches = result.matches.filter((hit) => hit.provenance === undefined)
  if (matches.length === result.matches.length) return [event]
  if (matches.length === 0) return []
  const allowed = new Set(matches.map((hit) => hit.docId))
  return [
    {
      ...event,
      data: {
        ...data,
        // Rebuild the preview: an earlier summary may contain excluded text.
        summary: `${matches.length} document match(es)`,
        result: {
          ...result,
          matches,
          references: result.references.filter((ref) => allowed.has(ref.docId)),
        },
      },
    },
  ]
}

/** Place OUTSIDE withReferences, inside the web pseudonymisation wrapper.
 * Copy the visible backing context so selectors, previews and expansion all
 * consume the same filtered events, even through unfiltered(). */
export function withInfoDocumentReferences<T>(pattern: ConfiguredPattern<T>): ConfiguredPattern<T> {
  return {
    ...pattern,
    name: `withInfoDocumentReferences(${pattern.name})`,
    children: [pattern],
    fn: (scope, view) => {
      const ctx = (view as unknown as { ctx: UnifiedContext }).ctx
      const filtered = { ...ctx, events: view.fromAll().get().flatMap(infoEvent) }
      return pattern.fn(scope, createEventView(filtered, pattern.config.viewConfig, scope.id))
    },
  }
}
