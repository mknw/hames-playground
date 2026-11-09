/** rv-1033 delta-review evidence (proposed test edit for #1032, delta term 1):
 * under a critic cadence above 1, actorCritic does not re-dispatch an `is_final`
 * repeat of the newest successful call (#784 item 7, `actorCritic.server.ts`): the
 * repeat records a controller_action with no tool_call/tool_result, and the critic
 * judges the ORIGINAL call's result. The record reads it that way
 * (`extractActorCritic`: `results.length > 0 ? results : previous`). The trace must
 * put the critic's verdict on the step that holds the judged result. Red at 53e34998. */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

import { createEvent } from '@hames-ai/harness-patterns/context.server'
import {
  renderRouteTrace,
  routeTraceRef,
} from '@hames-ai/harness-patterns/patterns/decisionLoop-trace.server'
import type { ControllerAction } from '@hames-ai/harness-patterns/types'

const act = (turn: number, is_final: boolean) =>
  createEvent('controller_action', 'doc', {
    action: {
      reasoning: `step ${turn}`,
      tool_name: 'graph_files_shared',
      tool_args: '{}',
      is_final,
    } as ControllerAction,
    turn,
    maxTurns: 6,
  })

describe('actorCritic trace: a skipped is_final repeat', () => {
  it('gives the verdict to the step whose result the critic judged', () => {
    const events = [
      act(1, false),
      createEvent('tool_call', 'doc', { callId: 'c1', tool: 'graph_files_shared', args: {} }),
      createEvent('tool_result', 'doc', {
        callId: 'c1',
        tool: 'graph_files_shared',
        result: 'an incomplete list',
        success: true,
      }),
      act(2, true), // the repeat: nothing dispatched, the critic judges c1's result
      createEvent('critic_result', 'doc', { result: { is_sufficient: false, explanation: 'e' } }),
    ]
    const trace = renderRouteTrace(
      routeTraceRef('actorCritic', events, undefined),
      new Map(events.map((e) => [e.id!, e])),
      { route: 'office-data', status: 's' },
    )
    const attempts = trace.steps.filter((s) => 'attempt' in s) as Array<{ verdict?: string }>
    expect(attempts[0].verdict).toBe('rejected')
  })
})
