import type { ContextEvent, ErrorEventData, ToolResultEventData } from './types'

/** The obsolete record and budget error after an authorized route retry
 * succeeds. Shared by synthesis and transcript projections; no event is edited.
 * Links are scoped to the same turn, loop and route, never inferred from text. */
export function supersededRouteEventIds(events: readonly ContextEvent[]): Set<string> {
  const obsolete = new Set<string>()
  const turn = new Map<string, ContextEvent>()
  for (const event of events) {
    if (event.type === 'user_message') turn.clear()
    if (event.type === 'tool_result') {
      const data = event.data as ToolResultEventData
      const link = data.routeRecord?.supersedes
      const record = link && turn.get(link.recordId)
      const error = link && turn.get(link.budgetErrorId)
      const prior = record?.data as ToolResultEventData | undefined
      if (
        data.success === true &&
        record?.type === 'tool_result' &&
        record.patternId === event.patternId &&
        prior?.success === false &&
        prior.tool === data.tool &&
        prior.routeRecord?.budgetErrorId === link?.budgetErrorId &&
        error?.type === 'error' &&
        (error.data as ErrorEventData).kind === 'budget_exhausted'
      ) {
        obsolete.add(record.id!)
        obsolete.add(error.id!)
      }
    }
    if (event.id) turn.set(event.id, event)
  }
  return obsolete
}
