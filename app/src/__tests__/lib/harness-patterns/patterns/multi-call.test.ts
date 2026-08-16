/**
 * Multi-call turn tests — simpleLoop batch path + the shared runBatch executor.
 *
 * Semantics under test (decisions 2026-08-02):
 *  - 'parallel': concurrent sub-calls (≤ MAX_PARALLEL_TOOL_CALLS in flight),
 *    per-call errors, others still run.
 *  - 'sequential'/'off': strict in-order, stop on first failure, rest skipped.
 *  - Partial failure → loop continues; ALL sub-calls failed → break path.
 *  - Return / expandPreviousResult cannot be batched (per-call error).
 *  - One LoopTurn per batch (additional_calls + index-keyed combined result);
 *    one tool_call/tool_result event PAIR per sub-call, sharing a batchId.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockAction, mockFinalAction } from '../../../mocks/baml'
import type { ControllerAction } from '../../../../../baml_client/types'

vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn()
}))

// Steerable callTool: per-test error/delay maps + dispatch log + concurrency meter.
const callLog: string[] = []
const toolErrors: Record<string, string> = {}
const toolDelays: Record<string, number> = {}
let activeCount = 0
let maxActive = 0

const callToolMock = vi.fn(async (tool: string, _args?: Record<string, unknown>) => {
  callLog.push(tool)
  activeCount++
  maxActive = Math.max(maxActive, activeCount)
  const delay = toolDelays[tool] ?? 0
  if (delay) await new Promise((r) => setTimeout(r, delay))
  activeCount--
  if (toolErrors[tool]) return { success: false, data: null, error: toolErrors[tool] }
  return { success: true, data: { tool, ok: true } }
})

vi.mock('../../../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: (tool: string, args?: Record<string, unknown>) => callToolMock(tool, args),
  listTools: vi.fn(async () => [])
}))

const TOOLS = ['tool_a', 'tool_b', 'tool_c', 'Return']

function batchAction(
  first: { tool: string; args?: string },
  additional: Array<{ tool_name: string; tool_args: string }>
): ControllerAction {
  return mockAction({
    tool_name: first.tool,
    tool_args: first.args ?? '{}',
    additional_calls: additional
  })
}

async function runPattern(
  actions: ControllerAction[],
  config?: Record<string, unknown>
) {
  const { simpleLoop } = await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
  const { createScope } = await import('../../../../lib/harness-patterns/context.server')
  const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

  const controller = vi.fn()
  for (const a of actions) controller.mockResolvedValueOnce({ action: a, llmCall: undefined })
  controller.mockResolvedValue({ action: mockFinalAction('done'), llmCall: undefined })

  const pattern = simpleLoop(controller, TOOLS, { patternId: 'mc', ...config })
  const scope = createScope('mc', { intent: 'q' })
  const view = createEventView({
    sessionId: 'mc',
    createdAt: Date.now(),
    events: [
      { type: 'user_message' as const, ts: Date.now(), patternId: 'harness', data: { content: 'q' } }
    ],
    status: 'running' as const,
    data: {},
    input: 'q'
  })
  const result = await pattern.fn(scope, view)
  return { result, controller }
}

beforeEach(() => {
  vi.clearAllMocks()
  callLog.length = 0
  for (const k of Object.keys(toolErrors)) delete toolErrors[k]
  for (const k of Object.keys(toolDelays)) delete toolDelays[k]
  activeCount = 0
  maxActive = 0
})

describe('simpleLoop multi-call turns', () => {
  it('parallel batch: per-sub-call event pairs share a batchId; one LoopTurn records the batch', async () => {
    const { result, controller } = await runPattern([
      batchAction({ tool: 'tool_a' }, [{ tool_name: 'tool_b', tool_args: '{"x":1}' }])
    ])

    // mode reaches the controller (9th positional arg)
    expect(controller.mock.calls[0][8]).toBe('parallel')

    const calls = result.events.filter((e) => e.type === 'tool_call')
    const results = result.events.filter((e) => e.type === 'tool_result')
    expect(calls).toHaveLength(2)
    expect(results).toHaveLength(2)
    const callData = calls.map((e) => e.data as { callId?: string; batchId?: string; tool: string })
    expect(callData[0].batchId).toBeDefined()
    expect(callData[1].batchId).toBe(callData[0].batchId)
    expect(callData[0].callId).not.toBe(callData[1].callId)
    // results pair by callId
    const resultData = results.map((e) => e.data as { callId?: string; success: boolean })
    expect(resultData.map((d) => d.callId).sort()).toEqual(callData.map((d) => d.callId).sort())

    // the NEXT controller call sees ONE turn carrying the batch
    const previousResults = JSON.parse(controller.mock.calls[1][2] as string)
    expect(previousResults).toHaveLength(1)
    expect(previousResults[0].additional_calls).toEqual([{ tool_name: 'tool_b', tool_args: '{"x":1}' }])
    const combined = JSON.parse(previousResults[0].tool_result.result)
    expect(combined['1'].tool).toBe('tool_a')
    expect(combined['2'].tool).toBe('tool_b')
    expect(previousResults[0].tool_result.success).toBe(true)
  })

  it('partial failure: failed sub-call gets __error, loop continues', async () => {
    toolErrors.tool_b = 'boom'
    const { result, controller } = await runPattern([
      batchAction({ tool: 'tool_a' }, [{ tool_name: 'tool_b', tool_args: '{}' }])
    ])

    // loop continued to the follow-up (final) controller call
    expect(controller).toHaveBeenCalledTimes(2)
    const previousResults = JSON.parse(controller.mock.calls[1][2] as string)
    const combined = JSON.parse(previousResults[0].tool_result.result)
    expect(combined['2'].__error).toContain('boom')
    expect(previousResults[0].tool_result.success).toBe(true) // any succeeded

    // no pattern-level error event — partial failure is not a loop failure
    expect(result.events.filter((e) => e.type === 'error')).toHaveLength(0)
  })

  it('all sub-calls failed: break path with a recoverable error event', async () => {
    toolErrors.tool_a = 'down'
    toolErrors.tool_b = 'also down'
    const { result, controller } = await runPattern([
      batchAction({ tool: 'tool_a' }, [{ tool_name: 'tool_b', tool_args: '{}' }])
    ])

    expect(controller).toHaveBeenCalledTimes(1) // loop broke, no second call
    const errors = result.events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    const errData = errors[0].data as { error: string; severity: string }
    expect(errData.error).toContain('All 2 calls')
    expect(errData.severity).toBe('recoverable')
  })

  it('sequential mode: in-order execution, stop on first failure, rest skipped', async () => {
    toolErrors.tool_b = 'boom'
    const { controller } = await runPattern(
      [
        batchAction({ tool: 'tool_a' }, [
          { tool_name: 'tool_b', tool_args: '{}' },
          { tool_name: 'tool_c', tool_args: '{}' }
        ])
      ],
      { multiToolCalls: 'sequential' }
    )

    expect(controller.mock.calls[0][8]).toBe('sequential')
    // tool_c never dispatched
    expect(callLog).toEqual(['tool_a', 'tool_b'])
    const previousResults = JSON.parse(controller.mock.calls[1][2] as string)
    const combined = JSON.parse(previousResults[0].tool_result.result)
    expect(combined['2'].__error).toContain('boom')
    expect(combined['3'].__skipped).toContain('skipped')
    expect(previousResults[0].tool_result.success).toBe(true) // tool_a succeeded
  })

  it("'off' mode: no mode reaches the controller, un-advertised batches still execute serially", async () => {
    toolDelays.tool_a = 20
    const { controller } = await runPattern(
      [batchAction({ tool: 'tool_a' }, [{ tool_name: 'tool_b', tool_args: '{}' }])],
      { multiToolCalls: 'off' }
    )

    expect(controller.mock.calls[0][8]).toBeUndefined()
    expect(callLog).toEqual(['tool_a', 'tool_b'])
    expect(maxActive).toBe(1) // strictly serial
  })

  it('control-flow tools inside a batch get a per-call error; siblings still run', async () => {
    const { controller } = await runPattern([
      batchAction({ tool: 'tool_a' }, [
        { tool_name: 'expandPreviousResult', tool_args: 'ref:ev_1' }
      ])
    ])

    expect(callLog).toEqual(['tool_a']) // expand never dispatched as a tool
    const previousResults = JSON.parse(controller.mock.calls[1][2] as string)
    const combined = JSON.parse(previousResults[0].tool_result.result)
    expect(combined['2'].__error).toContain('cannot be part of a multi-call turn')
    expect(previousResults[0].tool_result.success).toBe(true)
  })

  it('disallowed tools inside a batch fail per-call without killing the batch', async () => {
    const { controller } = await runPattern([
      batchAction({ tool: 'tool_a' }, [{ tool_name: 'not_a_tool', tool_args: '{}' }])
    ])

    expect(callLog).toEqual(['tool_a'])
    const previousResults = JSON.parse(controller.mock.calls[1][2] as string)
    const combined = JSON.parse(previousResults[0].tool_result.result)
    expect(combined['2'].__error).toContain('Tool not allowed: not_a_tool')
  })

  it('singular turns keep the exact pre-feature shape (no additional_calls, no batchId)', async () => {
    const { result, controller } = await runPattern([
      mockAction({ tool_name: 'tool_a', tool_args: '{}' })
    ])

    const previousResults = JSON.parse(controller.mock.calls[1][2] as string)
    expect(previousResults[0].additional_calls).toBeUndefined()
    const call = result.events.find((e) => e.type === 'tool_call')
    expect((call?.data as { batchId?: string }).batchId).toBeUndefined()
  })
})

describe('actorCritic multi-call attempts', () => {
  async function runActor(
    actions: ControllerAction[],
    opts?: {
      config?: Record<string, unknown>
      criticSufficient?: boolean[]
    }
  ) {
    const { actorCritic } = await import('../../../../lib/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')
    const { mockCriticResult } = await import('../../../mocks/baml')

    const actor = vi.fn()
    for (const a of actions) actor.mockResolvedValueOnce({ action: a, llmCall: undefined })
    actor.mockResolvedValue({ action: actions[actions.length - 1], llmCall: undefined })

    const critic = vi.fn()
    for (const ok of opts?.criticSufficient ?? [true]) {
      critic.mockResolvedValueOnce({ result: mockCriticResult({ is_sufficient: ok }), llmCall: undefined })
    }
    critic.mockResolvedValue({ result: mockCriticResult({ is_sufficient: true }), llmCall: undefined })

    const pattern = actorCritic(actor, critic, TOOLS, { patternId: 'ac-mc', ...opts?.config })
    const scope = createScope('ac-mc', { intent: 'q' })
    const view = createEventView({
      sessionId: 'ac-mc',
      createdAt: Date.now(),
      events: [
        { type: 'user_message' as const, ts: Date.now(), patternId: 'harness', data: { content: 'q' } }
      ],
      status: 'running' as const,
      data: {},
      input: 'q'
    })
    const result = await pattern.fn(scope, view)
    return { result, actor, critic }
  }

  it('batch attempt: per-call event pairs, ONE attempt with additionalCalls, critic sees the combined map', async () => {
    const { result, actor, critic } = await runActor([
      batchAction({ tool: 'tool_a' }, [{ tool_name: 'tool_b', tool_args: '{"y":2}' }])
    ])

    // mode reaches the actor (8th positional arg)
    expect(actor.mock.calls[0][7]).toBe('parallel')

    const calls = result.events.filter((e) => e.type === 'tool_call')
    const results = result.events.filter((e) => e.type === 'tool_result')
    expect(calls).toHaveLength(2)
    expect(results).toHaveLength(2)
    const batchIds = calls.map((e) => (e.data as { batchId?: string }).batchId)
    expect(batchIds[0]).toBeDefined()
    expect(batchIds[1]).toBe(batchIds[0])

    // critic (sole exit authority) evaluated ONE attempt carrying the batch
    expect(critic).toHaveBeenCalledTimes(1)
    const attempts = critic.mock.calls[0][1] as Array<{
      toolName?: string
      additionalCalls?: unknown[]
      output: string
    }>
    expect(attempts).toHaveLength(1)
    expect(attempts[0].toolName).toBe('tool_a')
    expect(attempts[0].additionalCalls).toEqual([{ tool_name: 'tool_b', tool_args: '{"y":2}' }])
    const combined = JSON.parse(attempts[0].output)
    expect(combined['1'].tool).toBe('tool_a')
    expect(combined['2'].tool).toBe('tool_b')

    // accepted → the combined map is the pattern result
    expect((result.data as { result?: Record<string, unknown> }).result).toMatchObject({
      '1': { tool: 'tool_a' }
    })
  })

  it('all sub-calls failed: no critic call, next actor attempt sees the error', async () => {
    toolErrors.tool_a = 'down'
    toolErrors.tool_b = 'down too'
    const { actor, critic } = await runActor([
      batchAction({ tool: 'tool_a' }, [{ tool_name: 'tool_b', tool_args: '{}' }]),
      mockAction({ tool_name: 'tool_c', tool_args: '{}' }) // recovery attempt
    ])

    expect(actor.mock.calls.length).toBeGreaterThanOrEqual(2)
    const attemptsSeenBySecondCall = actor.mock.calls[1][3] as Array<{ error?: string | null; output: string }>
    expect(attemptsSeenBySecondCall[0].error).toContain('down')
    expect(attemptsSeenBySecondCall[0].output).toBe('')
    // failed batch attempt is not judged — cadence gate only runs on success
    expect(critic.mock.calls.length).toBeLessThan(actor.mock.calls.length)
  })

  it('dynamicToolAllowlist applies per sub-call', async () => {
    const { critic } = await runActor(
      [batchAction({ tool: 'tool_a' }, [{ tool_name: 'dyn_tool', tool_args: '{}' }])],
      { config: { dynamicToolAllowlist: async () => ['dyn_tool'] } }
    )
    expect(callLog).toContain('dyn_tool')
    const attempts = critic.mock.calls[0][1] as Array<{ output: string }>
    const combined = JSON.parse(attempts[0].output)
    expect(combined['2'].tool).toBe('dyn_tool')
  })

  it("sequential mode threads through; 'off' passes undefined", async () => {
    const { actor } = await runActor(
      [batchAction({ tool: 'tool_a' }, [{ tool_name: 'tool_b', tool_args: '{}' }])],
      { config: { multiToolCalls: 'sequential' } }
    )
    expect(actor.mock.calls[0][7]).toBe('sequential')

    callLog.length = 0
    const { actor: actorOff } = await runActor(
      [batchAction({ tool: 'tool_a' }, [{ tool_name: 'tool_b', tool_args: '{}' }])],
      { config: { multiToolCalls: 'off' } }
    )
    expect(actorOff.mock.calls[0][7]).toBeUndefined()
    expect(callLog).toEqual(['tool_a', 'tool_b']) // still executed, serially
  })
})

describe('runBatch executor', () => {
  it('parallel: caps in-flight sub-calls at MAX_PARALLEL_TOOL_CALLS, returns positional order', async () => {
    const { runBatch } = await import('../../../../lib/harness-patterns/parallel-tools.server')
    const { MAX_PARALLEL_TOOL_CALLS } = await import('../../../../lib/harness-patterns/types')

    let active = 0
    let peak = 0
    const calls = Array.from({ length: 7 }, (_, i) => ({
      tool: `t${i}`,
      run: async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 15))
        active--
        return { success: true, result: i }
      }
    }))

    const outcomes = await runBatch(calls, 'parallel')
    expect(peak).toBeLessThanOrEqual(MAX_PARALLEL_TOOL_CALLS)
    expect(peak).toBeGreaterThan(1)
    expect(outcomes.map((o) => o.index)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(outcomes.map((o) => o.result)).toEqual([0, 1, 2, 3, 4, 5, 6])
  })

  it('parallel: a thrown sub-call becomes a per-call error, siblings unaffected', async () => {
    const { runBatch } = await import('../../../../lib/harness-patterns/parallel-tools.server')
    const outcomes = await runBatch(
      [
        { tool: 'ok', run: async () => ({ success: true, result: 1 }) },
        { tool: 'throws', run: async () => { throw new Error('exploded') } }
      ],
      'parallel'
    )
    expect(outcomes[0].success).toBe(true)
    expect(outcomes[1].success).toBe(false)
    expect(outcomes[1].error).toBe('exploded')
  })

  it('sequential: stops at the first failure and marks the rest skipped', async () => {
    const { runBatch } = await import('../../../../lib/harness-patterns/parallel-tools.server')
    const ran: string[] = []
    const mk = (tool: string, success: boolean) => ({
      tool,
      run: async () => {
        ran.push(tool)
        return { success, result: tool, error: success ? undefined : 'failed' }
      }
    })
    const outcomes = await runBatch([mk('a', true), mk('b', false), mk('c', true)], 'sequential')
    expect(ran).toEqual(['a', 'b'])
    expect(outcomes[2].skipped).toBe(true)
    expect(outcomes[2].error).toContain('call 2 (b) failed')
  })

  it('precheck failures never dispatch and count as failures for serial stop', async () => {
    const { runBatch } = await import('../../../../lib/harness-patterns/parallel-tools.server')
    const ran: string[] = []
    const outcomes = await runBatch(
      [
        { tool: 'bad', precheckError: 'Tool not allowed: bad' },
        { tool: 'never', run: async () => { ran.push('never'); return { success: true } } }
      ],
      'sequential'
    )
    expect(ran).toEqual([])
    expect(outcomes[0].error).toBe('Tool not allowed: bad')
    expect(outcomes[1].skipped).toBe(true)
  })

  it('combineOutcomes: keyed map with __error/__skipped markers and anySucceeded', async () => {
    const { combineOutcomes } = await import('../../../../lib/harness-patterns/parallel-tools.server')
    const { combined, anySucceeded, errors } = combineOutcomes([
      { index: 1, tool: 'a', success: true, result: 'r1' },
      { index: 2, tool: 'b', success: false, error: 'boom' },
      { index: 3, tool: 'c', success: false, skipped: true, error: 'skipped: call 2 (b) failed earlier in this batch' }
    ])
    expect(combined['1']).toEqual({ tool: 'a', result: 'r1' })
    expect(combined['2']).toEqual({ tool: 'b', __error: 'boom' })
    expect(combined['3']).toEqual({ tool: 'c', __skipped: 'skipped: call 2 (b) failed earlier in this batch' })
    expect(anySucceeded).toBe(true)
    expect(errors).toEqual(['[2] b: boom'])
  })
})
