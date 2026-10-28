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
import { resumableStep, wrapperResumable } from '@hames-ai/harness-patterns/resume.server'

assertServerOnImport()

function infoEvent(event: ContextEvent): ContextEvent[] {
  if (event.type !== 'tool_result') return [event]
  const data = event.data as ToolResultEventData
  if (data.tool !== 'retriever') return [event]
  const result = data.result as RetrieverResult
  if (!Array.isArray(result?.matches)) return [event]
  // Presence is the boundary, not the value. `general-next` composes no input
  // pseudonymiser (boundary guards slice 5), but a library composition that
  // wraps this in one can rewrite string VALUES while preserving object keys,
  // and a rewritten provenance must still be excluded.
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

/** Place OUTSIDE withReferences (and inside any input pseudonymiser a library
 * composition adds; `general-next` adds none since boundary guards slice 5).
 * Copy the visible backing context so selectors, previews and expansion all
 * consume the same filtered events, even through unfiltered(). */
export function withInfoDocumentReferences<T>(pattern: ConfiguredPattern<T>): ConfiguredPattern<T> {
  // A filter over the view and nothing else, so a resume passes straight
  // through it to the info loop (resume inside a route).
  const resumable = wrapperResumable('withInfoDocumentReferences', pattern)
  return {
    ...pattern,
    name: `withInfoDocumentReferences(${pattern.name})`,
    children: [pattern],
    capabilities: { ...pattern.capabilities, resumable },
    fn: (scope, view) =>
      resumableStep('withInfoDocumentReferences', resumable, () => {
        const ctx = (view as unknown as { ctx: UnifiedContext }).ctx
        const filtered = { ...ctx, events: view.fromAll().get().flatMap(infoEvent) }
        return pattern.fn(scope, createEventView(filtered, pattern.config.viewConfig, scope.id))
      }),
  }
}
