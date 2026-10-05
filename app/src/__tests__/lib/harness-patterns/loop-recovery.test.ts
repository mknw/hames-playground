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
 * classify), a `callTool` that throws, and a critic that throws — and, since
 * the #450 review's §3, the answer that reaches the consecutive-recovery cap.
 *
 * Each `it` names the mutation that turns it red.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import { mockAction, mockFinalAction, mockCriticResult } from '../../mocks/baml'
import type {
  ActorCriticConfig,
  ActorInput,
  ContextEvent,
  ControllerInput,
  ErrorEventData,
  LLMCallRecord,
  LoopRecoveryEventData,
  SimpleLoopConfig,
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

async function run(
  pattern: { fn: (s: never, v: never) => Promise<{ events: ContextEvent[] }> },
  frame: Parameters<typeof withRunFrame>[0] = {},
) {
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
  return (await withRunFrame(frame, () => pattern.fn(scope as never, view as never))).events
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
  async function loop(
    controller: ReturnType<typeof vi.fn>,
    maxTurns = 4,
    extra: SimpleLoopConfig = {},
  ) {
    const { simpleLoop } = await import('@hames-ai/harness-patterns/patterns/simpleLoop.server')
    return run(
      simpleLoop(controller as never, TOOLS, { patternId: 'rec', maxTurns, ...extra }) as never,
    )
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
    // ...and its own answer, which the turn log cannot replay: no action was
    // parsed out of it, so the assistant message for that round is empty.
    // Mutation: drop the raw-output excerpt from `unparseableOutputFeedback`.
    expect(seen.tool_result?.error).toContain(`as you wrote it:\n${RAW}\n`)
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
    // A cut-off is told to be smaller, not shown its own oversized answer.
    // Mutation: put the raw-output excerpt on this branch too.
    expect(error).not.toContain(RAW)
    expect(error).not.toContain('as you wrote it')
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
  // never ends; or skip the exhaustion marker when the last round failed. The
  // consecutive-recovery cap is switched off here, so the budget is the bound
  // under test (the cap has its own suite below).
  it('a model that never recovers is stopped by its budget, and says so', async () => {
    const controller = vi.fn().mockRejectedValue(await parseFailure())

    const events = await loop(controller, 3, { maxConsecutiveRecoveries: Infinity })

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
    // The attempt log replays an empty action for this attempt, so the ERROR
    // is the only place the actor can see what it wrote. Mutation: drop the
    // raw-output excerpt from `unparseableOutputFeedback`.
    expect(attempt.error).toContain(`as you wrote it:\n${RAW}\n`)
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
  // `allowlistHasContent` guard. It does NOT count toward the consecutive-
  // recovery cap (the #450 delta review's finding 2): the actor had no valid
  // name to choose, so only the budget ends this one. Mutation: drop
  // `!surfaceEmpty(...) &&` from the singular refusal's cap check → red.
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
// The consecutive-recovery cap (#450 review §3, owner decision 2026-10-03)
// ============================================================================

const errorsOf = (events: ContextEvent[]) =>
  ofType(events, 'error').map((e) => e.data as ErrorEventData)

/** The record a real adapter returns with an answer that parsed. */
const ANSWERED: LLMCallRecord = { functionName: 'LoopController', variables: {}, rawOutput: '{}' }

/** The three ways a round's ANSWER can be unusable, as a controller/actor mock
 *  produces each: `[label, arrange the mock, what the cap's error says]`. */
async function unusableAnswers() {
  const failure = await parseFailure()
  return [
    [
      'an unparseable answer',
      (m: ReturnType<typeof vi.fn>) => m.mockRejectedValueOnce(failure),
      failure.message,
    ],
    [
      'a tool off the allowlist',
      (m: ReturnType<typeof vi.fn>) =>
        m.mockResolvedValueOnce({
          action: mockAction({ tool_name: 'run_command', tool_args: '{}' }),
          llmCall: ANSWERED,
        }),
      'Tool not allowed: run_command',
    ],
    [
      'unparseable tool_args',
      (m: ReturnType<typeof vi.fn>) =>
        m.mockResolvedValueOnce({
          action: mockAction({ tool_name: 'read_neo4j_cypher', tool_args: 'not json' }),
          llmCall: ANSWERED,
        }),
      'Invalid tool_args JSON for read_neo4j_cypher: not json',
    ],
  ] as const
}

const dispatch = (tool_args = '{"query":"q"}') => ({
  action: mockAction({ tool_name: 'read_neo4j_cypher', tool_args }),
})

describe('simpleLoop: the consecutive-recovery cap', () => {
  async function loop(controller: ReturnType<typeof vi.fn>, extra: SimpleLoopConfig = {}) {
    const { simpleLoop } = await import('@hames-ai/harness-patterns/patterns/simpleLoop.server')
    return run(
      simpleLoop(controller as never, TOOLS, { patternId: 'rec', maxTurns: 8, ...extra }) as never,
    )
  }

  // Mutations, each red here: the default set to 2 (a third round is played);
  // the cap check removed from any one of the three sites (the loop runs on to
  // its budget instead); the marker dropped from the error.
  it.each([0, 1, 2])('the second unusable answer in a row ends the loop (class %i)', async (i) => {
    const [, arrange, message] = (await unusableAnswers())[i]
    const controller = vi.fn()
    arrange(controller)
    arrange(controller)
    controller.mockResolvedValue({ action: mockFinalAction('done') })

    const events = await loop(controller)

    expect(controller).toHaveBeenCalledTimes(2)
    expect(callToolMock).not.toHaveBeenCalled()
    // The first is fed back; the second is not one more recovery.
    expect(recoveries(events).map((r) => r.turn)).toEqual([0])
    // Fatal exactly as before #437 — the failure's own message, the pattern's
    // severity, the failed answer's llmCall — and marked as the cap's doing.
    const errors = errorsOf(events)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      kind: 'recovery_exhausted',
      maxConsecutiveRecoveries: 1,
      severity: 'recoverable',
      turn: 1,
    })
    expect(errors[0].error).toContain(message)
    expect(errors[0].hint).toContain('consecutive-recovery cap: after 1 recovery in a row')
    expect(errors[0].hint).toContain('`maxConsecutiveRecoveries` on the `rec` pattern')
    expect(ofType(events, 'error')[0].llmCall).toBeDefined()
  })

  // Mutation: drop `streak.dispatched()` before the singular `callTool` → the
  // second unparseable answer is counted as the second in a row, red. The tool
  // FAILS here on purpose: a tool error is never counted, and a dispatch resets
  // the count whatever the tool returned.
  it('a round that dispatches a tool resets the count, even when the tool fails', async () => {
    callToolMock.mockResolvedValue({ success: false, data: null, error: 'row limit' })
    const controller = vi
      .fn()
      .mockRejectedValueOnce(await parseFailure())
      .mockResolvedValueOnce(dispatch())
      .mockRejectedValueOnce(await parseFailure())
      .mockResolvedValueOnce({ action: mockFinalAction('done') })

    const events = await loop(controller)

    expect(controller).toHaveBeenCalledTimes(4)
    expect(recoveries(events).map((r) => r.failure)).toEqual([
      'unparseable_output',
      'tool_error',
      'unparseable_output',
    ])
    expect(errorsOf(events)).toEqual([])
  })

  // Mutation: count a tool error toward the cap → red. Fail, fix, fail is how a
  // loop debugs; only an unusable ANSWER is capped. Run at the strictest cap:
  // at the default, each dispatch resets the count before a tool error could
  // add to it, so the default alone cannot tell whether tool errors count.
  it('tool errors in a row never reach the cap, even at its strictest', async () => {
    callToolMock.mockResolvedValue({ success: false, data: null, error: 'row limit' })
    const controller = vi
      .fn()
      .mockResolvedValueOnce(dispatch())
      .mockResolvedValueOnce(dispatch())
      .mockResolvedValueOnce(dispatch())
      .mockResolvedValueOnce({ action: mockFinalAction('done') })

    const events = await loop(controller, { maxConsecutiveRecoveries: 0 })

    expect(controller).toHaveBeenCalledTimes(4)
    expect(errorsOf(events)).toEqual([])
  })

  // Mutation: drop the batch branch's `streak.dispatched()` → red.
  it('a multi-call turn that dispatched a call resets the count', async () => {
    callToolMock.mockResolvedValue({ success: false, data: null, error: 'row limit' })
    const controller = vi
      .fn()
      .mockRejectedValueOnce(await parseFailure())
      .mockResolvedValueOnce({
        action: mockAction({
          tool_name: 'read_neo4j_cypher',
          tool_args: '{"query":"a"}',
          additional_calls: [{ tool_name: 'read_neo4j_cypher', tool_args: '{"query":"b"}' }],
        }),
      })
      .mockRejectedValueOnce(await parseFailure())
      .mockResolvedValueOnce({ action: mockFinalAction('done') })

    const events = await loop(controller)

    expect(controller).toHaveBeenCalledTimes(4)
    expect(errorsOf(events)).toEqual([])
  })

  // A turn that dispatched nothing holds only unusable answers, so it COUNTS
  // (the #450 delta review's finding 1): here it is the second in a row, and
  // ends the loop. Mutations, each red here: replace simpleLoop's batch cap
  // check with `if (false)`; or make `if (dispatched) streak.dispatched()`
  // unconditional.
  it('a multi-call turn of which nothing was dispatched counts toward the cap', async () => {
    const controller = vi
      .fn()
      .mockRejectedValueOnce(await parseFailure())
      .mockResolvedValueOnce({
        action: mockAction({
          tool_name: 'run_command',
          tool_args: '{}',
          additional_calls: [{ tool_name: 'read_neo4j_cypher', tool_args: 'not json' }],
        }),
      })
      .mockRejectedValueOnce(await parseFailure())
      .mockResolvedValue({ action: mockFinalAction('done') })

    const events = await loop(controller)

    expect(controller).toHaveBeenCalledTimes(2)
    expect(callToolMock).not.toHaveBeenCalled()
    expect(recoveries(events).map((r) => r.failure)).toEqual(['unparseable_output'])
    expect(errorsOf(events)).toEqual([
      expect.objectContaining({ kind: 'recovery_exhausted', turn: 1 }),
    ])
  })

  // Probe P2 of the delta review: before finding 1, this ran all 8 rounds.
  // Mutations, each red here: simpleLoop's batch cap check → `if (false)`;
  // `if (dispatched) streak.dispatched()` made unconditional.
  it('a wholly refused batch every round is capped like a singular refusal', async () => {
    const controller = vi.fn().mockResolvedValue({
      action: mockAction({
        tool_name: 'run_command',
        tool_args: '{}',
        additional_calls: [{ tool_name: 'delete_everything', tool_args: '{}' }],
      }),
      llmCall: ANSWERED,
    })

    const events = await loop(controller)

    expect(controller).toHaveBeenCalledTimes(2)
    expect(callToolMock).not.toHaveBeenCalled()
    expect(recoveries(events).map((r) => [r.failure, r.turn])).toEqual([['batch_failed', 0]])
    const errors = errorsOf(events)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ kind: 'recovery_exhausted', turn: 1 })
    expect(errors[0].error).toContain('All 2 calls of the multi-call turn failed')
    expect(ofType(events, 'error')[0].llmCall).toEqual(ANSWERED)
  })

  // The two boundaries of the knob, which counts RECOVERIES (owner decision A).
  // Mutations, one per boundary: the clamp `Math.max(0, …)` → `Math.max(1, …)`
  // reddens the `0` row; `++run > cap` → `>=` reddens the `1` row.
  it.each([
    [0, 1],
    [1, 2],
  ])('maxConsecutiveRecoveries: %i → the loop ends on unusable answer %i', async (cap, ends) => {
    const controller = vi.fn().mockRejectedValue(await parseFailure())

    const events = await loop(controller, { maxConsecutiveRecoveries: cap })

    expect(controller).toHaveBeenCalledTimes(ends)
    expect(recoveries(events)).toHaveLength(cap)
    expect(errorsOf(events)).toEqual([
      expect.objectContaining({ kind: 'recovery_exhausted', maxConsecutiveRecoveries: cap }),
    ])
  })

  it('the knob: 0 is the pre-#437 behaviour, Infinity leaves only the budget', async () => {
    const none = vi.fn().mockRejectedValue(await parseFailure())
    const first = await loop(none, { maxConsecutiveRecoveries: 0 })
    expect(none).toHaveBeenCalledTimes(1)
    expect(recoveries(first)).toEqual([])
    expect(errorsOf(first)).toEqual([
      expect.objectContaining({ kind: 'recovery_exhausted', maxConsecutiveRecoveries: 0 }),
    ])

    const off = vi.fn().mockRejectedValue(await parseFailure())
    const budget = await loop(off, { maxTurns: 3, maxConsecutiveRecoveries: Infinity })
    expect(off).toHaveBeenCalledTimes(3)
    expect(errorsOf(budget).map((e) => e.kind)).toEqual(['budget_exhausted'])
  })
})

describe('actorCritic: the consecutive-recovery cap', () => {
  async function loop(
    actor: ReturnType<typeof vi.fn>,
    extra: ActorCriticConfig = {},
    tools: string[] = TOOLS,
    frame: Parameters<typeof withRunFrame>[0] = {},
  ) {
    const { actorCritic } = await import('@hames-ai/harness-patterns/patterns/actorCritic.server')
    const critic = vi.fn().mockResolvedValue({ result: mockCriticResult({ is_sufficient: true }) })
    const events = await run(
      actorCritic(actor as never, critic as never, tools, {
        patternId: 'rec',
        maxRetries: 6,
        ...extra,
      }) as never,
      frame,
    )
    return { critic, events }
  }

  const refusedBatch = {
    action: mockAction({
      tool_name: 'run_command',
      tool_args: '{}',
      additional_calls: [{ tool_name: 'delete_everything', tool_args: '{}' }],
    }),
    llmCall: ANSWERED,
  }

  // Mutations, each red here: the default set to 2; the cap check removed from
  // any one of the three sites. A refused tool and bad `tool_args` never ended
  // this loop before #437, so for those two the cap is a NEW fatal path.
  it.each([0, 1, 2])('the second unusable answer in a row ends the loop (class %i)', async (i) => {
    const [, arrange, message] = (await unusableAnswers())[i]
    const actor = vi.fn()
    arrange(actor)
    arrange(actor)
    actor.mockResolvedValue(dispatch())

    const { events, critic } = await loop(actor)

    expect(actor).toHaveBeenCalledTimes(2)
    expect(critic).not.toHaveBeenCalled()
    expect(recoveries(events).map((r) => r.turn)).toEqual([0])
    const errors = errorsOf(events)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      kind: 'recovery_exhausted',
      maxConsecutiveRecoveries: 1,
      severity: 'recoverable',
      iteration: 1,
    })
    expect(errors[0].error).toContain(message)
    expect(ofType(events, 'error')[0].llmCall).toBeDefined()
  })

  // Mutation: drop actorCritic's singular `streak.dispatched()` → red.
  it('an attempt that dispatches a tool resets the count, even when the tool fails', async () => {
    callToolMock
      .mockResolvedValueOnce({ success: false, data: null, error: 'row limit' })
      .mockResolvedValue({ success: true, data: { rows: 1 } })
    const actor = vi
      .fn()
      .mockRejectedValueOnce(await parseFailure())
      .mockResolvedValueOnce(dispatch())
      .mockRejectedValueOnce(await parseFailure())
      .mockResolvedValue(dispatch())

    const { events, critic } = await loop(actor)

    expect(actor).toHaveBeenCalledTimes(4)
    expect(critic).toHaveBeenCalledTimes(1)
    expect(errorsOf(events)).toEqual([])
  })

  // Mutation: drop actorCritic's batch `streak.dispatched()` → red.
  it('a multi-call attempt that dispatched a call resets the count', async () => {
    callToolMock
      .mockResolvedValueOnce({ success: false, data: null, error: 'row limit' })
      .mockResolvedValueOnce({ success: false, data: null, error: 'timeout' })
      .mockResolvedValue({ success: true, data: { rows: 1 } })
    const actor = vi
      .fn()
      .mockRejectedValueOnce(await parseFailure())
      .mockResolvedValueOnce({
        action: mockAction({
          tool_name: 'read_neo4j_cypher',
          tool_args: '{"query":"a"}',
          additional_calls: [{ tool_name: 'read_neo4j_cypher', tool_args: '{"query":"b"}' }],
        }),
      })
      .mockRejectedValueOnce(await parseFailure())
      .mockResolvedValue(dispatch())

    const { events, critic } = await loop(actor)

    expect(actor).toHaveBeenCalledTimes(4)
    expect(critic).toHaveBeenCalledTimes(1)
    expect(errorsOf(events)).toEqual([])
  })

  // Probe P2 of the delta review, actorCritic's half: before finding 1, this ran
  // all 6 attempts. Mutations, each red here: actorCritic's batch cap check →
  // `if (false)`; its `if (dispatched) streak.dispatched()` made unconditional
  // (the review's O8).
  it('a wholly refused batch every attempt is capped like a singular refusal', async () => {
    const actor = vi.fn().mockResolvedValue(refusedBatch)

    const { events, critic } = await loop(actor)

    expect(actor).toHaveBeenCalledTimes(2)
    expect(critic).not.toHaveBeenCalled()
    expect(callToolMock).not.toHaveBeenCalled()
    expect(recoveries(events).map((r) => [r.failure, r.turn])).toEqual([['batch_failed', 0]])
    const errors = errorsOf(events)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ kind: 'recovery_exhausted', iteration: 1 })
    expect(errors[0].error).toContain('All 2 calls of the multi-call attempt failed')
    // Mutation (the round-3 delta review's X2): pass `undefined` instead of
    // `actorLlmCall` to this `endOnRecoveryCap` call → red.
    expect(ofType(events, 'error')[0].llmCall).toEqual(ANSWERED)
  })

  // Probe P1 of the delta review (finding 2): the dynamic allowlist resolves to
  // nothing for two attempts — a gateway symptom — then recovers. The actor
  // named the right tool every time, so those refusals must not count.
  // Mutation: drop `!surfaceEmpty(...) &&` from the singular refusal's check →
  // capped at attempt 2 with the tool never dispatched, red.
  it('a refusal against a tool surface that resolved to nothing does not count', async () => {
    const dynamicToolAllowlist = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue(['read_neo4j_cypher'])
    const actor = vi.fn().mockResolvedValue({ ...dispatch(), llmCall: ANSWERED })

    const { events, critic } = await loop(actor, { maxRetries: 5, dynamicToolAllowlist }, [])

    expect(actor).toHaveBeenCalledTimes(3)
    expect(callToolMock).toHaveBeenCalledTimes(1)
    expect(critic).toHaveBeenCalledTimes(1)
    expect(recoveries(events).map((r) => r.failure)).toEqual([
      'tool_not_allowed',
      'tool_not_allowed',
    ])
    expect(errorsOf(events)).toEqual([])
  })

  // P1b: the same, through a multi-call attempt. Mutation: drop the
  // `!surfaceEmpty(...)` conjunct from the batch cap check → red.
  it('a batch refused against a tool surface that resolved to nothing does not count', async () => {
    const dynamicToolAllowlist = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValue(['read_neo4j_cypher'])
    const actor = vi.fn().mockResolvedValue({
      action: mockAction({
        tool_name: 'read_neo4j_cypher',
        tool_args: '{"query":"a"}',
        additional_calls: [{ tool_name: 'read_neo4j_cypher', tool_args: '{"query":"b"}' }],
      }),
      llmCall: ANSWERED,
    })

    const { events, critic } = await loop(actor, { maxRetries: 5, dynamicToolAllowlist }, [])

    expect(actor).toHaveBeenCalledTimes(3)
    expect(callToolMock).toHaveBeenCalledTimes(2)
    expect(critic).toHaveBeenCalledTimes(1)
    expect(recoveries(events).map((r) => r.failure)).toEqual(['batch_failed', 'batch_failed'])
    expect(errorsOf(events)).toEqual([])
  })

  // The control for finding 2: the sandbox shape — `tools: []` INSIDE a scoped
  // transport — has a real surface (the box's tools), so naming a tool it does
  // not own is an answer defect and counts. Mutation: drop
  // `scoped.length === 0 &&` from `surfaceEmpty` → this runs to its budget, red.
  it('the sandbox shape still counts: tools [] inside a scoped transport', async () => {
    const transport = {
      id: 'scoped:sandbox',
      ownsTool: (name: string) => name.startsWith('sandbox_'),
      callTool: vi.fn(async () => ({ success: true, data: 'ok' })),
      listTools: async () => [],
    }
    const actor = vi.fn().mockResolvedValue({
      action: mockAction({ tool_name: 'bash', tool_args: '{"script":"ls"}' }),
      llmCall: ANSWERED,
    })

    const { events, critic } = await loop(actor, {}, [], { transports: [transport] })

    expect(actor).toHaveBeenCalledTimes(2)
    expect(critic).not.toHaveBeenCalled()
    expect(transport.callTool).not.toHaveBeenCalled()
    expect(errorsOf(events)).toEqual([
      expect.objectContaining({ kind: 'recovery_exhausted', iteration: 1 }),
    ])
  })

  // A `dynamicToolPattern` is a tool surface too: names it matches are allowed,
  // so a refusal beside one is an answer defect and counts. Mutation (the
  // round-3 delta review's X1): drop `!config?.dynamicToolPattern` from
  // `surfaceEmpty` → this runs to its budget, red.
  it('a dynamicToolPattern is a surface: tools [] with a pattern still counts', async () => {
    const actor = vi.fn().mockResolvedValue({
      action: mockAction({ tool_name: 'bash', tool_args: '{}' }),
      llmCall: ANSWERED,
    })
    const { events } = await loop(actor, { dynamicToolPattern: /^sandbox_/ }, [])
    expect(actor).toHaveBeenCalledTimes(2)
    expect(errorsOf(events)).toEqual([
      expect.objectContaining({ kind: 'recovery_exhausted', iteration: 1 }),
    ])
  })

  // The knob's boundaries, actorCritic's half. Mutations: the clamp → `Math.max(1, …)`
  // reddens the `0` row; `++run > cap` → `>=` reddens the `1` row.
  it.each([
    [0, 1],
    [1, 2],
    [2, 3],
  ])('maxConsecutiveRecoveries: %i → the loop ends on unusable answer %i', async (cap, ends) => {
    const actor = vi.fn().mockRejectedValue(await parseFailure())
    const { events } = await loop(actor, { maxConsecutiveRecoveries: cap })
    expect(actor).toHaveBeenCalledTimes(ends)
    expect(recoveries(events)).toHaveLength(cap)
    expect(errorsOf(events)).toEqual([
      expect.objectContaining({ kind: 'recovery_exhausted', maxConsecutiveRecoveries: cap }),
    ])
  })
})

describe('resolveMaxConsecutiveRecoveries', () => {
  it.each([
    [undefined, 1],
    [Number.NaN, 1],
    [0, 0],
    [-3, 0],
    [2.7, 2],
    [Infinity, Infinity],
  ] as const)('%s → %s', async (declared, expected) => {
    const { resolveMaxConsecutiveRecoveries } =
      await import('@hames-ai/harness-patterns/loop-recovery.server')
    expect(resolveMaxConsecutiveRecoveries(declared)).toBe(expected)
  })
})

// ============================================================================
// The model sees its own unparseable answer (owner question, 2026-10-03)
// ============================================================================

describe('unparseableOutputFeedback: what the model reads back', () => {
  async function feedback(record: Partial<LLMCallRecord>) {
    const { unparseableOutputFeedback } =
      await import('@hames-ai/harness-patterns/loop-recovery.server')
    return unparseableOutputFeedback(await parseFailure(record))
  }

  // The documented case: a brace-less `key: value` envelope. The model needs
  // to see the shape it produced, and the parser's message does not show it.
  it('quotes the head of its own answer, labelled as its own', async () => {
    const braceless = 'reasoning: count the rows\ntool_name: read_neo4j_cypher\ntool_args: {}'
    const text = await feedback({ rawOutput: braceless })
    expect(text).toContain('Missing required field: tool_args')
    expect(text).toContain(`This is your previous response, as you wrote it:\n${braceless}\n`)
    expect(text.endsWith('Respond with exactly one JSON object in the required format.')).toBe(true)
  })

  // Mutation: drop the bound (quote `raw` whole) → red.
  it('bounds the quote to a 400-character head', async () => {
    const long = 'x'.repeat(399) + 'HEAD_END' + 'y'.repeat(2000)
    const text = await feedback({ rawOutput: long })
    expect(text).toContain(`${long.slice(0, 400)}…[truncated]`)
    expect(text).not.toContain(long.slice(0, 401))
    expect(text).not.toContain('yyyy')
  })

  it('quotes nothing when no response was captured', async () => {
    const text = await feedback({ rawOutput: undefined })
    expect(text).not.toContain('as you wrote it')
    expect(text).toContain('). Respond with exactly one JSON object')
  })

  // The other two branches stay exactly as they were. Mutation: put the quote
  // on the cut-off branch → red.
  it('a cut-off or an empty answer is not quoted back', async () => {
    const cut = await feedback({ hitOutputCap: true })
    expect(cut).not.toContain(RAW)
    expect(cut).toContain('CUT OFF at the output-token limit')
    expect(await feedback({ rawOutput: '  \n' })).toBe(
      'Your previous response was empty. Respond with exactly one JSON action object.',
    )
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

// ============================================================================
// json-repair's length bound reaches the model (#463 review, finding 1)
// ============================================================================

describe("json-repair's over-length refusal is forwarded to the model (#463)", () => {
  /** Relaxed syntax the chain would repair at any smaller size. */
  const TOO_LONG = '{q: ' + 'x'.repeat(16_400) + '}'

  const accept = () =>
    vi.fn().mockResolvedValue({ result: mockCriticResult({ is_sufficient: true }) })

  async function simple(controller: ReturnType<typeof vi.fn>) {
    const { simpleLoop } = await import('@hames-ai/harness-patterns/patterns/simpleLoop.server')
    return run(simpleLoop(controller as never, TOOLS, { patternId: 'rec', maxTurns: 4 }) as never)
  }

  async function actorLoop(actor: ReturnType<typeof vi.fn>) {
    const { actorCritic } = await import('@hames-ai/harness-patterns/patterns/actorCritic.server')
    return run(
      actorCritic(actor as never, accept() as never, TOOLS, {
        patternId: 'rec',
        maxRetries: 3,
      }) as never,
    )
  }

  /** A single call: the recovery record carries what the model is fed back. */
  const recoveryError = (events: ContextEvent[]) => recoveries(events)[0]?.error ?? ''
  /** A batch: the failed call's own `tool_result` carries its precheck error. */
  const failedCallError = (events: ContextEvent[]) =>
    ofType(events, 'tool_result')
      .map((e) => e.data as { success: boolean; error?: string })
      .find((d) => !d.success)?.error ?? ''

  const single = { action: mockAction({ tool_name: 'read_neo4j_cypher', tool_args: TOO_LONG }) }
  const batch = {
    action: mockAction({
      tool_name: 'read_neo4j_cypher',
      tool_args: '{"query":"a"}',
      additional_calls: [{ tool_name: 'read_neo4j_cypher', tool_args: TOO_LONG }],
    }),
  }
  const done = { action: mockFinalAction('done') }

  // Mutations, each red: `throw new SyntaxError(` restored in the bound → all
  // four rows; `err` dropped at a single-call site → that row; the
  // `TooLongToRepairError` ternary dropped at a precheck → that row.
  it.each([
    [
      'simpleLoop, single call',
      () => simple(vi.fn().mockResolvedValueOnce(single).mockResolvedValue(done)),
      recoveryError,
    ],
    [
      'simpleLoop, batch precheck',
      () => simple(vi.fn().mockResolvedValueOnce(batch).mockResolvedValue(done)),
      failedCallError,
    ],
    [
      'actorCritic, single call',
      () => actorLoop(vi.fn().mockResolvedValueOnce(single).mockResolvedValue(dispatch())),
      recoveryError,
    ],
    [
      'actorCritic, batch precheck',
      () => actorLoop(vi.fn().mockResolvedValueOnce(batch).mockResolvedValue(dispatch())),
      failedCallError,
    ],
  ] as const)('%s', async (_site, runSite, recorded) => {
    const events = await runSite()
    expect(recorded(events)).toContain('too long to repair')
  })
})
