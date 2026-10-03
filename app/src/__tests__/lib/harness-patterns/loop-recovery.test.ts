/**
 * A single failure no longer ends a tool loop (#437 slice 1, from #425 C1/C2).
 *
 * `simpleLoop` used to `break` on the first failed tool call, the first tool
 * name off its allowlist, the first unparseable `tool_args` and the first
 * controller answer that would not parse; `actorCritic` ended on the first actor
 * answer that would not parse. Each with rounds or attempts left. Now each is
 * fed back as the round's observation and recorded as a `loop_recovery`.
 *
 * What stays FATAL is pinned here just as hard, because "recover from more
 * things" drifts into "recover from everything": the gateway-outage refusal, an
 * LLM call that never answered (and any failure the implementation did not
 * classify), a `callTool` that throws, and a critic that throws.
 *
 * Each `it` names the mutation that turns it red.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import { mockAction, mockFinalAction, mockCriticResult } from '../../mocks/baml'
import type {
  ActorInput,
  ContextEvent,
  ControllerInput,
  LLMCallRecord,
  LoopRecoveryEventData,
} from '@hames-ai/harness-patterns/types'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const callToolMock = vi.fn()
vi.mock('@hames-ai/harness-patterns/mcp-client.server', () => ({
  callTool: callToolMock,
  listTools: vi.fn().mockResolvedValue([]),
}))

const mockLoopController = vi.fn()
vi.mock('@hames-ai/harness-baml/baml_client', () => ({
  b: { LoopController: mockLoopController },
}))

const runInFrame = <T>(fn: () => Promise<T>): Promise<T> => withRunFrame({}, fn)

const TOOLS = ['read_neo4j_cypher']
const RAW = '{"reasoning": "query the graph", "tool_name": "read_neo4j_cypher"'

/** A parse failure as the BAML adapters throw it: the model ANSWERED. */
async function parseFailure(record: Partial<LLMCallRecord> = {}) {
  const { LLMCallError } = await import('@hames-ai/harness-patterns/types')
  return new LLMCallError(
    'BamlValidationError: Failed to coerce value: <root>: Missing required field: tool_args',
    { functionName: 'LoopController', variables: {}, rawOutput: RAW, ...record },
    undefined,
    { recoverable: true },
  )
}

async function run(pattern: { fn: (s: never, v: never) => Promise<{ events: ContextEvent[] }> }) {
  const { createScope } = await import('@hames-ai/harness-patterns/context.server')
  const { createEventView } = await import('@hames-ai/harness-patterns/patterns')
  const scope = createScope('rec', { intent: 'q' })
  const view = createEventView({
    sessionId: 'rec',
    createdAt: 1,
    events: [{ type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'q' } }],
    status: 'running',
    data: {},
    input: 'q',
  })
  return (await runInFrame(() => pattern.fn(scope as never, view as never))).events
}

const ofType = (events: ContextEvent[], type: ContextEvent['type']) =>
  events.filter((e) => e.type === type)

const recoveries = (events: ContextEvent[]) =>
  ofType(events, 'loop_recovery').map((e) => e.data as LoopRecoveryEventData)

beforeEach(() => {
  vi.clearAllMocks()
  callToolMock.mockResolvedValue({ success: true, data: { rows: 1 } })
})

afterEach(async () => {
  const health = await import('@hames-ai/harness-patterns/gateway-health.server')
  health.__resetGatewayHealth()
})

// ============================================================================
// simpleLoop
// ============================================================================

describe('simpleLoop: recoverable failures are fed back', () => {
  async function loop(controller: ReturnType<typeof vi.fn>, maxTurns = 4) {
    const { simpleLoop } = await import('@hames-ai/harness-patterns/patterns/simpleLoop.server')
    return run(simpleLoop(controller as never, TOOLS, { patternId: 'rec', maxTurns }) as never)
  }

  // Mutation: delete the `isRecoverableLLMFailure` branch in the controller
  // catch → the answer ends the loop with an error event, as it used to.
  it('an unparseable answer becomes the round result and the loop goes on', async () => {
    const failure = await parseFailure()
    const controller = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({
        action: mockAction({ tool_name: 'read_neo4j_cypher', tool_args: '{"query":"q"}' }),
      })
      .mockResolvedValueOnce({ action: mockFinalAction('done') })

    const events = await loop(controller)

    expect(controller).toHaveBeenCalledTimes(3)
    // The second round saw the failure: no tool call, an ERROR result.
    const [seen] = (controller.mock.calls[1][0] as ControllerInput).turns
    expect(seen.n).toBe(0)
    expect(seen.tool_call).toBeUndefined()
    expect(seen.tool_result).toMatchObject({ tool: '', success: false })
    expect(seen.tool_result?.error).toContain('could not be parsed')
    expect(seen.tool_result?.error).toContain('Missing required field: tool_args')
    expect(callToolMock).toHaveBeenCalledTimes(1)

    expect(recoveries(events)).toEqual([
      { failure: 'unparseable_output', error: failure.message, turn: 0, maxTurns: 4 },
    ])
    // The raw answer rides the recovery — the only record of what was said.
    expect(ofType(events, 'loop_recovery')[0].llmCall?.rawOutput).toBe(RAW)
    expect(ofType(events, 'error')).toEqual([])
  })

  // Mutation: drop the `hitOutputCap` branch of `unparseableOutputFeedback` →
  // the model gets generic parse advice and regenerates the same oversized
  // answer.
  it('a cut-off answer is told it was cut off and how to split the work', async () => {
    const controller = vi
      .fn()
      .mockRejectedValueOnce(await parseFailure({ hitOutputCap: true }))
      .mockResolvedValueOnce({ action: mockFinalAction('done') })

    await loop(controller)

    const error = (controller.mock.calls[1][0] as ControllerInput).turns[0].tool_result?.error
    expect(error).toContain('CUT OFF at the output-token limit')
    expect(error).toContain('CONTINUE BY APPENDING')
  })

  // Mutation: drop the empty-output branch → "could not be parsed" with a
  // parser excerpt, for a response that had nothing in it to parse.
  it('an empty answer is told it was empty', async () => {
    const controller = vi
      .fn()
      .mockRejectedValueOnce(await parseFailure({ rawOutput: '  \n' }))
      .mockResolvedValueOnce({ action: mockFinalAction('done') })

    await loop(controller)

    const error = (controller.mock.calls[1][0] as ControllerInput).turns[0].tool_result?.error
    expect(error).toBe(
      'Your previous response was empty. Respond with exactly one JSON action object.',
    )
  })

  // Mutation: pass `controllerLlmCall?.hitOutputCap` as `false` in the
  // tool_args branch → the cut-off guidance never reaches simpleLoop's model
  // (before #437 this branch ended the loop, so it carried none).
  it('cut-off tool_args carry the same append guidance', async () => {
    const controller = vi
      .fn()
      .mockResolvedValueOnce({
        action: mockAction({ tool_name: 'read_neo4j_cypher', tool_args: '{"query": "MATCH' }),
        llmCall: { functionName: 'LoopController', variables: {}, hitOutputCap: true },
      })
      .mockResolvedValueOnce({ action: mockFinalAction('done') })

    const events = await loop(controller)

    const seen = (controller.mock.calls[1][0] as ControllerInput).turns[0]
    expect(seen.tool_call).toEqual({ tool: 'read_neo4j_cypher', args: '{"query": "MATCH' })
    expect(seen.tool_result?.error).toContain('CUT OFF')
    expect(seen.tool_result?.error).toContain('CONTINUE BY APPENDING')
    expect(recoveries(events)[0].failure).toBe('invalid_tool_args')
    expect(callToolMock).not.toHaveBeenCalled()
  })

  // Mutation: restore the `break` in the refused-tool branch.
  it('a refused tool name is fed back and never dispatched', async () => {
    const controller = vi
      .fn()
      .mockResolvedValueOnce({ action: mockAction({ tool_name: 'run_command', tool_args: '{}' }) })
      .mockResolvedValueOnce({ action: mockFinalAction('done') })

    const events = await loop(controller)

    expect(controller).toHaveBeenCalledTimes(2)
    expect(callToolMock).not.toHaveBeenCalled()
    const seen = (controller.mock.calls[1][0] as ControllerInput).turns[0]
    expect(seen.tool_call?.tool).toBe('run_command')
    expect(seen.tool_result?.error).toContain('Tool not allowed: run_command')
    expect(recoveries(events)).toEqual([
      expect.objectContaining({ failure: 'tool_not_allowed', tool: 'run_command', turn: 0 }),
    ])
  })

  // Mutation: count recoveries as `turns` without consuming a round → the loop
  // never ends; or skip the exhaustion marker when the last round failed.
  it('a model that never recovers is stopped by its budget, and says so', async () => {
    const controller = vi.fn().mockRejectedValue(await parseFailure())

    const events = await loop(controller, 3)

    expect(controller).toHaveBeenCalledTimes(3)
    expect(recoveries(events).map((r) => r.turn)).toEqual([0, 1, 2])
    const errors = ofType(events, 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].data).toMatchObject({ kind: 'budget_exhausted', maxTurns: 3 })
  })
})

describe('simpleLoop: fatal failures stay fatal', () => {
  async function loop(controller: ReturnType<typeof vi.fn>, tools = TOOLS) {
    const { simpleLoop } = await import('@hames-ai/harness-patterns/patterns/simpleLoop.server')
    return run(simpleLoop(controller as never, tools, { patternId: 'rec', maxTurns: 4 }) as never)
  }

  // Mutation: make `isRecoverableLLMFailure` read `err instanceof LLMCallError`
  // (i.e. infer recoverability instead of reading the flag) → this loops.
  it('an LLMCallError the implementation did not mark recoverable ends the loop', async () => {
    const { LLMCallError } = await import('@hames-ai/harness-patterns/types')
    const controller = vi.fn().mockRejectedValue(
      new LLMCallError('BamlTimeoutError: request timed out', {
        functionName: 'LoopController',
        variables: {},
      }),
    )

    const events = await loop(controller)

    expect(controller).toHaveBeenCalledTimes(1)
    expect(recoveries(events)).toEqual([])
    expect(ofType(events, 'error')[0].data).toMatchObject({
      error: 'BamlTimeoutError: request timed out',
      kind: 'llm_call',
    })
  })

  it('a plain Error from a custom controller ends the loop', async () => {
    const controller = vi.fn().mockRejectedValue(new Error('fetch failed'))

    const events = await loop(controller)

    expect(controller).toHaveBeenCalledTimes(1)
    expect(recoveries(events)).toEqual([])
    expect(ofType(events, 'error')).toHaveLength(1)
  })

  // The deterministic sanitizer throws out of `callTool` (#206 D1, an owner
  // decision this slice does not take). Mutation: catch `callTool` throws and
  // record them as recoveries → this loops instead of ending.
  it('a callTool that throws ends the loop through the outer catch', async () => {
    callToolMock.mockRejectedValue(new Error('sanitizer rule threw'))
    const controller = vi.fn().mockResolvedValue({
      action: mockAction({ tool_name: 'read_neo4j_cypher', tool_args: '{"query":"q"}' }),
    })

    const events = await loop(controller)

    expect(controller).toHaveBeenCalledTimes(1)
    expect(recoveries(events)).toEqual([])
    expect(ofType(events, 'error')[0].data).toMatchObject({ error: 'sanitizer rule threw' })
  })

  // The same throw inside a multi-call turn. `runBatch` catches a `run()` that
  // throws and returns it as a failed outcome, so without the `threw` marker
  // an all-failed batch of throws read as an ordinary failed batch and was fed
  // back every round until the budget ran out (review of #450). Mutations, each
  // red here: drop `threw: true` from `runBatch`'s catch; or drop the
  // `outcomes.some((o) => o.threw)` break in simpleLoop's batch branch.
  it.each([
    ['every call threw', () => callToolMock.mockRejectedValue(new Error('sanitizer rule threw'))],
    [
      'one threw, one returned a failure',
      () =>
        callToolMock
          .mockRejectedValueOnce(new Error('sanitizer rule threw'))
          .mockResolvedValueOnce({ success: false, data: null, error: 'row limit' }),
    ],
  ])('a batch whose calls all failed and %s ends the loop', async (_label, arrange) => {
    arrange()
    const controller = vi.fn().mockResolvedValue({
      action: mockAction({
        tool_name: 'read_neo4j_cypher',
        tool_args: '{"query":"a"}',
        additional_calls: [{ tool_name: 'read_neo4j_cypher', tool_args: '{"query":"b"}' }],
      }),
    })

    const events = await loop(controller)

    expect(controller).toHaveBeenCalledTimes(1)
    expect(callToolMock).toHaveBeenCalledTimes(2)
    expect(recoveries(events)).toEqual([])
    const errors = ofType(events, 'error')
    expect(errors).toHaveLength(1)
    expect((errors[0].data as { error: string }).error).toContain('All 2 calls')
    expect((errors[0].data as { error: string }).error).toContain('sanitizer rule threw')
  })

  // The other side of the same line, so the fix cannot over-reach: an
  // all-failed batch with NO throw is still a recovery. Mutation: make every
  // all-failed batch fatal (drop the `threw` condition) → red.
  it('a batch whose calls all RETURNED failures is still fed back', async () => {
    callToolMock.mockResolvedValue({ success: false, data: null, error: 'row limit' })
    const controller = vi
      .fn()
      .mockResolvedValueOnce({
        action: mockAction({
          tool_name: 'read_neo4j_cypher',
          tool_args: '{"query":"a"}',
          additional_calls: [{ tool_name: 'read_neo4j_cypher', tool_args: '{"query":"b"}' }],
        }),
      })
      .mockResolvedValueOnce({ action: mockFinalAction('done') })

    const events = await loop(controller)

    expect(controller).toHaveBeenCalledTimes(2)
    expect(recoveries(events).map((r) => r.failure)).toEqual(['batch_failed'])
    expect(ofType(events, 'error')).toEqual([])
  })

  // Mutation: delete the `toolSurfaceOutage` refusal at the top of the loop.
  it('the gateway-outage refusal still refuses before any controller call', async () => {
    const health = await import('@hames-ai/harness-patterns/gateway-health.server')
    health.markGatewayUnreachable('ECONNREFUSED 127.0.0.1:8811')
    const controller = vi.fn()

    const events = await loop(controller, [])

    expect(controller).not.toHaveBeenCalled()
    expect(ofType(events, 'error')[0].data).toMatchObject({ severity: 'irrecoverable' })
  })
})

// ============================================================================
// actorCritic
// ============================================================================

describe('actorCritic: an unparseable actor answer is fed back (#425 C2)', () => {
  async function loop(
    actor: ReturnType<typeof vi.fn>,
    critic: ReturnType<typeof vi.fn>,
    tools = TOOLS,
  ) {
    const { actorCritic } = await import('@hames-ai/harness-patterns/patterns/actorCritic.server')
    return run(
      actorCritic(actor as never, critic as never, tools, {
        patternId: 'rec',
        maxRetries: 3,
      }) as never,
    )
  }

  const accept = () =>
    vi.fn().mockResolvedValue({ result: mockCriticResult({ is_sufficient: true }) })

  // Mutation: rethrow every actor failure (the pre-#437 shape) → the outer
  // catch ends the loop on attempt 1 of 3.
  it('the next attempt sees the failure and the loop finishes', async () => {
    const failure = await parseFailure({ functionName: 'ActorController' })
    const actor = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce({
        action: mockAction({ tool_name: 'read_neo4j_cypher', tool_args: '{"query":"q"}' }),
      })
    const critic = accept()

    const events = await loop(actor, critic)

    expect(actor).toHaveBeenCalledTimes(2)
    const [attempt] = (actor.mock.calls[1][0] as ActorInput).previousAttempts
    expect(attempt).toMatchObject({ toolName: '', script: '', output: '' })
    expect(attempt.error).toContain('could not be parsed')
    expect(recoveries(events)).toEqual([
      { failure: 'unparseable_output', error: failure.message, turn: 0, maxTurns: 3 },
    ])
    expect(ofType(events, 'loop_recovery')[0].llmCall?.rawOutput).toBe(RAW)
    expect(critic).toHaveBeenCalledTimes(1)
    expect(ofType(events, 'error')).toEqual([])
  })

  // Mutation: same as the simpleLoop twin — infer recoverability.
  it('an unclassified actor failure still ends the loop with attempts left', async () => {
    const { LLMCallError } = await import('@hames-ai/harness-patterns/types')
    const actor = vi.fn().mockRejectedValue(
      new LLMCallError('BamlClientHttpError: 401', {
        functionName: 'ActorController',
        variables: {},
      }),
    )

    const events = await loop(actor, accept())

    expect(actor).toHaveBeenCalledTimes(1)
    expect(recoveries(events)).toEqual([])
    expect(ofType(events, 'error')[0].data).toMatchObject({ kind: 'llm_call' })
  })

  // Out of this slice's scope, and pinned so a widening is a decision rather
  // than a side effect: the critic is the loop's sole exit authority.
  it('a critic that throws still ends the loop', async () => {
    const actor = vi.fn().mockResolvedValue({
      action: mockAction({ tool_name: 'read_neo4j_cypher', tool_args: '{"query":"q"}' }),
    })
    const critic = vi.fn().mockRejectedValue(await parseFailure({ functionName: 'Critic' }))

    const events = await loop(actor, critic)

    expect(actor).toHaveBeenCalledTimes(1)
    expect(ofType(events, 'error')).toHaveLength(1)
  })

  // Mutation: delete the `trackLoopRecovery` call on the tool-failure branch →
  // the loop still recovers (it always did here) but the panel cannot show it.
  it('a failed tool call is recorded as a recovery', async () => {
    callToolMock.mockResolvedValueOnce({ success: false, data: null, error: 'row limit' })
    const actor = vi.fn().mockResolvedValue({
      action: mockAction({ tool_name: 'read_neo4j_cypher', tool_args: '{"query":"q"}' }),
    })

    const events = await loop(actor, accept())

    expect(recoveries(events)[0]).toEqual({
      failure: 'tool_error',
      error: 'row limit',
      tool: 'read_neo4j_cypher',
      turn: 0,
      maxTurns: 3,
    })
  })

  // The multi-call attempt always continued here when every call failed;
  // #437 adds the record. Mutation (the review's O3): delete actorCritic's
  // `batch_failed` `trackLoopRecovery` → no record, red.
  it('a multi-call attempt whose calls all failed is recorded as a recovery', async () => {
    callToolMock
      .mockResolvedValueOnce({ success: false, data: null, error: 'row limit' })
      .mockResolvedValueOnce({ success: false, data: null, error: 'timeout' })
    const actor = vi
      .fn()
      .mockResolvedValueOnce({
        action: mockAction({
          tool_name: 'read_neo4j_cypher',
          tool_args: '{"query":"a"}',
          additional_calls: [{ tool_name: 'read_neo4j_cypher', tool_args: '{"query":"b"}' }],
        }),
      })
      .mockResolvedValue({
        action: mockAction({ tool_name: 'read_neo4j_cypher', tool_args: '{"query":"c"}' }),
      })

    const events = await loop(actor, accept())

    const [record] = ofType(events, 'loop_recovery')
    expect(record.data).toEqual({
      failure: 'batch_failed',
      error:
        'All 2 calls of the multi-call attempt failed: ' +
        '[1] read_neo4j_cypher: row limit; [2] read_neo4j_cypher: timeout',
      turn: 0,
      maxTurns: 3,
    })
    // Tool-level failures: the actor's answer was fine, so no call record.
    expect(record.llmCall).toBeUndefined()
    expect(actor).toHaveBeenCalledTimes(2)
  })

  // Mutation: drop the `hitOutputCap` ternary on that record (always
  // `undefined`) → the cut-off answer, the only evidence, is lost.
  it('a multi-call attempt cut off at the cap carries the response on its record', async () => {
    const llmCall = { functionName: 'ActorController', variables: {}, hitOutputCap: true }
    const actor = vi
      .fn()
      .mockResolvedValueOnce({
        action: mockAction({
          tool_name: 'read_neo4j_cypher',
          tool_args: '{"query":"a"',
          additional_calls: [{ tool_name: 'read_neo4j_cypher', tool_args: '{"query": "b' }],
        }),
        llmCall,
      })
      .mockResolvedValue({
        action: mockAction({ tool_name: 'read_neo4j_cypher', tool_args: '{"query":"c"}' }),
      })

    const events = await loop(actor, accept())

    const [record] = ofType(events, 'loop_recovery')
    expect((record.data as LoopRecoveryEventData).failure).toBe('batch_failed')
    expect(record.llmCall).toEqual(llmCall)
    expect(callToolMock).toHaveBeenCalledTimes(1) // only the recovery attempt ran
  })

  // Behaviour change, pinned: a refusal against an EMPTY allowlist used to be
  // suppressed, because as an `error` it flooded the synthesizer's view. A
  // `loop_recovery` reaches no such reader. Mutation: restore the
  // `allowlistHasContent` guard.
  it('a refusal is recorded even when the gateway allowlist is empty', async () => {
    const actor = vi
      .fn()
      .mockResolvedValueOnce({ action: mockAction({ tool_name: 'web_search', tool_args: '{}' }) })
      .mockResolvedValue({ action: mockAction({ tool_name: 'nope', tool_args: '{}' }) })

    const events = await loop(actor, accept(), [])

    expect(recoveries(events)[0]).toMatchObject({ failure: 'tool_not_allowed', tool: 'web_search' })
    expect(ofType(events, 'error').map((e) => (e.data as { kind?: string }).kind)).toEqual([
      'budget_exhausted',
    ])
  })
})

// ============================================================================
// The classification lives with the implementation
// ============================================================================

describe('wrapAsLLMCallError marks only a parse failure recoverable', () => {
  // Mutation: `recoverable: true` unconditionally → the HTTP/timeout/abort rows
  // turn red; `false` unconditionally → the validation row does.
  it.each([
    ['BamlValidationError', true],
    ['BamlClientHttpError', false],
    ['BamlTimeoutError', false],
    ['BamlAbortError', false],
    ['Error', false],
  ] as const)('%s → recoverable %s', async (kind, expected) => {
    const baml = await import('@boundaryml/baml')
    const { wrapAsLLMCallError } = await import('@hames-ai/harness-baml/baml-adapters.server')
    const err =
      kind === 'BamlValidationError'
        ? new baml.BamlValidationError('prompt', RAW, 'missing tool_args', 'missing tool_args')
        : kind === 'BamlClientHttpError'
          ? new baml.BamlClientHttpError('VerdaQwen', '401', 401, '401')
          : kind === 'BamlTimeoutError'
            ? new baml.BamlTimeoutError('VerdaQwen', 'timed out')
            : kind === 'BamlAbortError'
              ? new baml.BamlAbortError('aborted')
              : new Error('fetch failed')

    const wrapped = wrapAsLLMCallError(err, 'LoopController', {}, Date.now(), undefined)

    expect(wrapped.recoverable).toBe(expected)
  })
})
