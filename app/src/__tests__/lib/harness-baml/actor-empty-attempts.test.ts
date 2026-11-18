/** Layer 1, #1035: run the real loop and adapters, then render each BAML
 * request offline. A permissive mock of ActorController missed the required
 * Attempt.result validation. No inference request is sent by these tests. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import '../../../lib/inference/config.server'
import {
  actorCritic,
  askHuman,
  createContext,
  createEventView,
  createScope,
  harness,
  held,
  LLMCallError,
  withRunFrame,
} from '@hames-ai/harness-patterns'
import type { Attempt, ControllerAction, ScriptExecutionEvent } from '@hames-ai/harness-patterns'
import { b } from '@hames-ai/harness-baml/baml_client'
import {
  createActorControllerAdapter,
  createCriticAdapter,
} from '@hames-ai/harness-baml/baml-adapters.server'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
const { callTool } = vi.hoisted(() => ({ callTool: vi.fn() }))
vi.mock('@hames-ai/harness-patterns/mcp-client.server', () => ({
  callTool,
  listTools: vi.fn(async () => [{ name: 'probe', description: 'Synthetic test tool' }]),
}))

const EMPTY = '[No output was produced for this attempt.]'
const action = (overrides: Partial<ControllerAction> = {}): ControllerAction => ({
  reasoning: 'Synthetic action',
  tool_name: 'probe',
  tool_args: '{}',
  is_final: false,
  ...overrides,
})
let actions: (ControllerAction | Error)[]
let actorAttempts: Attempt[][]
let criticAttempts: Attempt[][]
let rendered: string[]
let sufficient: boolean[]

beforeAll(() => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'offline-test-key')
  vi.stubEnv('USE_SELF_DEPLOYED_INFERENCE', '0')
  vi.spyOn(console, 'warn').mockImplementation(() => {}) // offline render has no collector log
  vi.spyOn(b, 'ActorController').mockImplementation(async (...args) => {
    const request = await b.request.ActorController(...args)
    rendered.push(JSON.stringify(request.body.json()))
    actorAttempts.push(structuredClone(args[3]))
    const next = actions.shift() ?? action({ is_final: true })
    if (next instanceof Error) throw next
    return next
  })
  vi.spyOn(b, 'Critic').mockImplementation(async (...args) => {
    const request = await b.request.Critic(...args)
    rendered.push(JSON.stringify(request.body.json()))
    criticAttempts.push(structuredClone(args[1]))
    return { is_sufficient: sufficient.shift() ?? true, explanation: 'Synthetic verdict' }
  })
})

beforeEach(() => {
  actions = []
  actorAttempts = []
  criticAttempts = []
  rendered = []
  sufficient = []
  callTool.mockReset().mockResolvedValue({ success: true, data: 'finished' })
})

afterAll(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

const pattern = () =>
  actorCritic(createActorControllerAdapter(['probe']), createCriticAdapter(), ['probe'], {
    patternId: 'empty-attempt',
    maxRetries: 4,
    criticCadence: 99,
    multiToolCalls: 'sequential',
  })

async function run() {
  const scope = await withRunFrame({ inference: { tier: 'anthropic' } }, () =>
    pattern().fn(
      createScope('empty-attempt', { intent: 'Synthetic task' }),
      createEventView(createContext('Synthetic task')),
    ),
  )
  expect(scope.events.filter((event) => event.type === 'error')).toEqual([])
  expect(criticAttempts).toHaveLength(1)
  return scope
}

describe('empty actor attempts', () => {
  // Mutation for every case: replace the adapter's labelled fallback with
  // event.output. Undefined fails BAML validation; empty strings lose the label.
  it('renders a successful tool call with no data instead of BAML refusing the retry', async () => {
    callTool.mockResolvedValueOnce({ success: true, data: undefined })
    actions = [action(), action({ tool_args: '{"next":true}', is_final: true })]
    await run()
    expect(actorAttempts[1][0].result).toBe(EMPTY)
    expect(criticAttempts[0][0].result).toBe(EMPTY)
    expect(rendered.join('\n')).toContain(EMPTY)
  })

  it('labels a failed tool call without losing its error', async () => {
    callTool.mockResolvedValueOnce({ success: false, error: 'Synthetic tool failure' })
    actions = [action()]
    await run()
    expect(actorAttempts[1][0]).toMatchObject({ result: EMPTY, error: 'Synthetic tool failure' })
    expect(criticAttempts[0][0].result).toBe(EMPTY)
    expect(rendered.join('\n')).toContain('Synthetic tool failure')
  })

  it('labels a refused tool that never ran', async () => {
    actions = [action({ tool_name: 'unavailable' })]
    await run()
    expect(actorAttempts[1][0]).toMatchObject({
      result: EMPTY,
      error: 'Tool not allowed: unavailable',
    })
    expect(callTool).toHaveBeenCalledTimes(1)
  })

  it('labels invalid tool arguments that never ran', async () => {
    actions = [action({ tool_args: 'not JSON at all' })]
    await run()
    expect(actorAttempts[1][0]).toMatchObject({
      result: EMPTY,
      error: expect.stringContaining('Invalid'),
    })
    expect(callTool).toHaveBeenCalledTimes(1)
  })

  it('labels an unparseable actor answer with no tool result', async () => {
    actions = [
      new LLMCallError(
        'Synthetic parse failure',
        { functionName: 'ActorController', variables: {}, rawOutput: 'invalid answer' },
        undefined,
        { recoverable: true },
      ),
    ]
    await run()
    expect(actorAttempts[1][0]).toMatchObject({ result: EMPTY, error: expect.any(String) })
    expect(callTool).toHaveBeenCalledTimes(1)
  })

  it('labels an all-failed batch including calls skipped after the failure', async () => {
    callTool.mockResolvedValueOnce({ success: false, error: 'Synthetic batch failure' })
    actions = [action({ additional_calls: [{ tool_name: 'probe', tool_args: '{"later":true}' }] })]
    const scope = await run()
    expect(actorAttempts[1][0]).toMatchObject({
      result: EMPTY,
      error: expect.stringContaining('Synthetic batch failure'),
    })
    expect(scope.events.filter((event) => event.type === 'tool_result')[1].data).toMatchObject({
      success: false,
      error: expect.stringContaining('skipped'),
    })
    expect(callTool).toHaveBeenCalledTimes(2) // failed batch head + next attempt
  })

  it('labels a final repeat whose reused result has no data', async () => {
    callTool.mockResolvedValueOnce({ success: true, data: undefined })
    actions = [
      action(),
      action({ is_final: true }),
      action({ tool_args: '{"next":true}', is_final: true }),
    ]
    sufficient = [false, true]
    await withRunFrame({ inference: { tier: 'anthropic' } }, () =>
      pattern().fn(
        createScope('empty-attempt', {}),
        createEventView(createContext('Synthetic task')),
      ),
    )
    expect(actorAttempts).toHaveLength(3)
    expect(actorAttempts[2].map((attempt) => attempt.result)).toEqual([EMPTY, EMPTY])
    expect(criticAttempts).toHaveLength(2)
    expect(callTool).toHaveBeenCalledTimes(2)
  })

  it.each([false, true])(
    'pauses a held call before either adapter can read the pending attempt (batch: %s)',
    async (batch) => {
      actions = [
        action({
          is_final: true,
          ...(batch
            ? { additional_calls: [{ tool_name: 'probe', tool_args: '{"later":true}' }] }
            : {}),
        }),
      ]
      callTool.mockImplementationOnce(async () => {
        const ask = await askHuman({
          kind: 'confirmation',
          question: 'Continue the synthetic call?',
          options: [
            { id: 'stop', label: 'Stop', unattended: true, stopsRun: true },
            { id: 'continue', label: 'Continue' },
          ],
          defaultOption: 'stop',
        })
        return { success: true, data: held(ask) }
      })
      const result = await withRunFrame(
        { inference: { tier: 'anthropic' }, hitl: { attended: true } },
        () => harness(pattern())('Synthetic task'),
      )
      expect(result.status).toBe('paused')
      expect(actorAttempts).toEqual([[]])
      expect(criticAttempts).toEqual([])
      expect(callTool).toHaveBeenCalledTimes(1)
    },
  )

  it.each([undefined, null, ''])('labels a caller-supplied empty output (%s)', async (output) => {
    // Also defend the public adapter against JS callers without a typed output.
    const attempt = { script: '{}', output } as ScriptExecutionEvent
    await withRunFrame({ inference: { tier: 'anthropic' } }, async () => {
      await createActorControllerAdapter([])({
        userMessage: 'Synthetic task',
        intent: 'Synthetic task',
        availableTools: [],
        previousAttempts: [attempt],
        attemptNumber: 2,
      })
      await createCriticAdapter()('Synthetic task', [attempt])
    })
    expect(actorAttempts[0][0].result).toBe(EMPTY)
    expect(criticAttempts[0][0].result).toBe(EMPTY)
  })

  it('preserves real outputs, batch actions, errors and critic feedback', async () => {
    const attempt: ScriptExecutionEvent = {
      toolName: 'probe',
      script: '{}',
      output: '0',
      error: 'Synthetic error',
      feedback: 'Try another approach',
      additionalCalls: [{ tool_name: 'probe', tool_args: '{"later":true}' }],
    }
    await withRunFrame({ inference: { tier: 'anthropic' } }, async () => {
      await createActorControllerAdapter([])(
        'Synthetic task',
        'Synthetic task',
        [],
        [attempt],
        undefined,
        2,
      )
      await createCriticAdapter()('Synthetic task', [attempt])
    })
    for (const attempts of [actorAttempts[0], criticAttempts[0]]) {
      expect(attempts[0]).toMatchObject({
        n: 1,
        result: '0',
        error: attempt.error,
        feedback: attempt.feedback,
        action: { tool_name: 'probe', tool_args: '{}', additional_calls: attempt.additionalCalls },
      })
    }
    expect(attempt.output).toBe('0')
  })
})
