import { describe, expect, it } from 'vitest'
import { supersededRouteEventIds } from '../route-records'
import type { CompactExecutionInput, ContextEvent, ToolResultEventData } from '../types'
import { createContext, createScope } from '../context.server'
import { createEventView } from '../patterns/event-view.server'
import { compactExecution } from '../patterns/compactExecution.server'

const fixture = (): ContextEvent[] => [
  { id: 'budget', ts: 1, type: 'error', patternId: 'work', data: { kind: 'budget_exhausted' } },
  {
    id: 'record',
    ts: 2,
    type: 'tool_result',
    patternId: 'loop',
    data: {
      tool: 'work',
      success: false,
      result: null,
      routeRecord: { iteration: 1, budgetErrorId: 'budget' },
    },
  },
  {
    id: 'other-error',
    ts: 3,
    type: 'error',
    patternId: 'other',
    data: { kind: 'budget_exhausted' },
  },
  {
    id: 'other-record',
    ts: 4,
    type: 'tool_result',
    patternId: 'loop',
    data: {
      tool: 'other',
      success: false,
      result: null,
      routeRecord: { iteration: 2, budgetErrorId: 'other-error' },
    },
  },
  {
    id: 'success',
    ts: 5,
    type: 'tool_result',
    patternId: 'loop',
    data: {
      tool: 'work',
      success: true,
      result: 'Invented output',
      routeRecord: { iteration: 3, supersedes: { recordId: 'record', budgetErrorId: 'budget' } },
    },
  },
]

describe('effective route records', () => {
  it.each([false, true])(
    'synthesis retains unrelated records and errors (%s)',
    async (unrelated) => {
      const ctx = createContext('Invented task', {})
      ctx.events = fixture().filter((e) => unrelated || !e.id?.startsWith('other'))
      // Real loop record pairs: the obsolete action becomes unpaired and is
      // dropped, while another route's failed result keeps its own action.
      ctx.events = ctx.events.flatMap((event) =>
        event.type === 'tool_result'
          ? [
              {
                type: 'controller_action' as const,
                ts: event.ts,
                patternId: event.patternId,
                data: {
                  action: {
                    tool_name: (event.data as ToolResultEventData).tool,
                    tool_args: '',
                    reasoning: '',
                    is_final: false,
                  },
                },
              },
              event,
            ]
          : [event],
      )
      const error = ctx.events.find((e) => e.id === 'other-error')
      if (error) error.data = { kind: 'budget_exhausted', error: 'Another route failed' }
      let seen: CompactExecutionInput | undefined
      const synth = compactExecution({
        mode: 'thread',
        viewConfig: { fromPatterns: ['loop', 'work', 'other'] },
        synthesize: async (input) => {
          seen = input
          return { value: 'Synthetic answer' }
        },
      })
      await synth.fn(createScope('synth', {}), createEventView(ctx, synth.config.viewConfig))
      expect(seen?.hasError).toBe(unrelated)
      expect(seen?.errorMessage).toBe(unrelated ? 'Another route failed' : undefined)
      expect(seen?.loopHistory?.iterations.map((i) => i.result)).toEqual(
        unrelated ? [{ __error: 'Tool call failed' }, 'Invented output'] : ['Invented output'],
      )
    },
  )

  it('supersedes only the explicitly linked failure, preserving other routes and history', () => {
    const events = fixture()
    const saved = JSON.stringify(events)
    expect([...supersededRouteEventIds(events)]).toEqual(['record', 'budget'])
    expect(JSON.stringify(events)).toBe(saved)
  })

  it.each([
    'failed-retry',
    'ordinary-repeat',
    'other-loop',
    'other-route',
    'wrong-error',
    'not-budget',
    'succeeded-original',
    'later-turn',
  ])('does not replace a failure for %s', (mutation) => {
    const events = fixture()
    const retry = events.at(-1)!
    const data = retry.data as ToolResultEventData
    const prior = events[1].data as ToolResultEventData
    if (mutation === 'failed-retry') data.success = false
    if (mutation === 'ordinary-repeat') delete data.routeRecord!.supersedes
    if (mutation === 'other-loop') retry.patternId = 'another-loop'
    if (mutation === 'other-route') data.tool = 'another-route'
    if (mutation === 'wrong-error') data.routeRecord!.supersedes!.budgetErrorId = 'other-error'
    if (mutation === 'not-budget') events[0].data = { kind: 'llm_call' }
    if (mutation === 'succeeded-original') prior.success = true
    if (mutation === 'later-turn')
      events.splice(-1, 0, {
        type: 'user_message',
        ts: 5,
        patternId: 'harness',
        data: { content: 'Next task' },
      })
    expect([...supersededRouteEventIds(events)]).toEqual([])
  })
})
