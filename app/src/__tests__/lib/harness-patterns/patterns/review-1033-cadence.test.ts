/** rv-1033 review evidence (proposed test edit for #1032, term 7): under
 * `criticCadence` > 1 (general-next's office route runs 3) one critic covers
 * several actor steps, and actorCritic stamps its rejection on the LAST step
 * only (`actorCritic.server.ts`, "Stamp the rejection reason onto the attempt
 * the critic just judged"). The trace must not label an earlier data step
 * `rejected`, which the writer is told never to present. Red at e4e17bfc. */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

import { createEvent } from '@hames-ai/harness-patterns/context.server'
import {
  renderRouteTrace,
  routeTraceRef,
} from '@hames-ai/harness-patterns/patterns/decisionLoop-trace.server'
import type { ControllerAction } from '@hames-ai/harness-patterns/types'

const step = (turn: number, tool: string, is_final = false) => [
  createEvent('controller_action', 'doc', {
    action: {
      reasoning: `step ${turn}`,
      tool_name: tool,
      tool_args: '{}',
      is_final,
    } as ControllerAction,
    turn,
    maxTurns: 6,
  }),
  createEvent('tool_call', 'doc', { callId: `c${turn}`, tool, args: {} }),
  createEvent('tool_result', 'doc', {
    callId: `c${turn}`,
    tool,
    result: `${tool} result ${turn}`,
    success: true,
  }),
]
const critic = (is_sufficient: boolean) =>
  createEvent('critic_result', 'doc', { result: { is_sufficient, explanation: 'e' } })

describe('actorCritic trace under a critic cadence', () => {
  it('gives a verdict only to the step the critic was run on', () => {
    const events = [
      ...step(1, 'graph_files_shared'), // the data, not judged on its own
      ...step(2, 'sandbox_bash', true), // is_final: the critic runs and rejects
      critic(false),
      ...step(3, 'sandbox_bash', true),
      critic(true),
    ]
    const trace = renderRouteTrace(
      routeTraceRef('actorCritic', events, undefined),
      new Map(events.map((e) => [e.id!, e])),
      { route: 'office-data', status: 's' },
    )
    const attempts = trace.steps.filter((s) => 'attempt' in s) as Array<{ verdict?: string }>
    expect(attempts.map((a) => a.verdict)).toEqual(['not judged', 'rejected', 'accepted'])
  })
})
