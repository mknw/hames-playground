/** rv-1033 review evidence (proposed test edits for #1032): two trace behaviours
 * the PR states and no test pins. Green at e4e17bfc; each turns red under the
 * mutation named on it (verified by the reviewer). */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

import { createEvent } from '@hames-ai/harness-patterns/context.server'
import {
  renderRouteTrace,
  routeTraceRef,
} from '@hames-ai/harness-patterns/patterns/decisionLoop-trace.server'
import type { ControllerAction } from '@hames-ai/harness-patterns/types'

const action = (tool_name: string, reasoning: string, turn = 0) => ({
  action: { reasoning, tool_name, tool_args: '{}', is_final: false } as ControllerAction,
  turn,
  maxTurns: 5,
})

const render = (events: ReturnType<typeof createEvent>[]) =>
  renderRouteTrace(
    routeTraceRef('simpleLoop', events, undefined),
    new Map(events.map((e) => [e.id!, e])),
    { route: 'office-data', status: 's' },
  )

describe('route trace: what the guard attached rides along (issue #1032, untrusted content)', () => {
  // MUTATION: drop `ingress` from `shownCall` in decisionLoop-trace.server.ts → red.
  it('keeps the ingress classification marks of a result', () => {
    const ingress = [{ tool: 'graph_mail_recent', item: 'm1', label: 'suspicious', safe: false }]
    const trace = render([
      createEvent('controller_action', 'office', action('graph_mail_recent', 'read mail')),
      createEvent('tool_call', 'office', { callId: 'm1', tool: 'graph_mail_recent', args: {} }),
      createEvent('tool_result', 'office', {
        callId: 'm1',
        tool: 'graph_mail_recent',
        result: 'fenced mail body',
        success: true,
        ingress,
      }),
    ])
    expect(trace.steps[0]).toMatchObject({ calls: [{ ingress }] })
  })
})

describe('route trace: a held call released by a person (slice 10)', () => {
  // MUTATION: drop the callId match in the tool_result case (match on the tool name
  // only) → the held marker and the released result both appear. Red.
  it('shows the released result once, in place of the held marker', () => {
    const trace = render([
      createEvent('controller_action', 'office', action('graph_files_shared', 'list shares')),
      createEvent('tool_call', 'office', { callId: 'c1', tool: 'graph_files_shared', args: {} }),
      createEvent('tool_result', 'office', {
        callId: 'c1',
        tool: 'graph_files_shared',
        result: 'HELD: waiting for the person',
        success: true,
      }),
      createEvent('tool_result', 'office', {
        callId: 'c1',
        tool: 'graph_files_shared',
        result: 'RELEASED: two files',
        success: true,
      }),
    ])
    const step = trace.steps[0]
    if (!('calls' in step)) throw new Error('the first step is not a call')
    expect(step.calls).toHaveLength(1)
    expect(step.calls[0].result).toBe('RELEASED: two files')
  })
})
