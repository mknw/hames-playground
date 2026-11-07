import type { ContextEvent } from '@hames-ai/harness-patterns'

/** Invented route records shared by transcript projection tests. */
export function routeRecoveryEvents(
  outcome: 'success' | 'failure' | 'answer' | 'later-turn' = 'success',
): ContextEvent[] {
  const event = (
    id: string,
    type: ContextEvent['type'],
    data: unknown,
    patternId = 'orchestrator',
  ): ContextEvent => ({ id, type, ts: 1, patternId, data })
  return [
    event('user', 'user_message', { content: 'Synthetic lookup' }, 'harness'),
    event(
      'budget',
      'error',
      { error: 'Invented attempt limit', kind: 'budget_exhausted', severity: 'recoverable' },
      'work',
    ),
    event('failed', 'tool_result', {
      tool: 'work',
      success: false,
      result: null,
      error: 'Invented attempt limit',
      routeRecord: { iteration: 1, budgetErrorId: 'budget' },
    }),
    event(
      'unrelated',
      'error',
      { error: 'An unrelated lookup failed', severity: 'recoverable' },
      'other',
    ),
    ...(outcome === 'later-turn'
      ? [event('next-user', 'user_message', { content: 'Another task' }, 'harness')]
      : []),
    ...(outcome === 'answer'
      ? []
      : [
          event('replacement', 'tool_result', {
            tool: 'work',
            success: outcome !== 'failure',
            result: 'Invented complete result',
            routeRecord: {
              iteration: 2,
              supersedes: { recordId: 'failed', budgetErrorId: 'budget' },
            },
          }),
        ]),
  ]
}
