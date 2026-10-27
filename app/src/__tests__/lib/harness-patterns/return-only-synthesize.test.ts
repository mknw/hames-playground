/**
 * The last hop of a Return-only turn (#610): the controller's `Return` text has
 * to reach the `Synthesize` call's turns, not just compactExecution's input.
 *
 * `packages/harness-patterns/__tests__/compact-return-only.test.ts` stubs
 * `synthesize`, so it cannot see this hop. Mutation: disable the
 * `else if (input.response)` branch in `defaultSynthesize` → `turns` is `[]`
 * and the first test goes red (before this file, nothing did).
 *
 * The second test runs the real `simpleLoop` (stub controller) → real
 * `compactExecution` → real `defaultSynthesize`, BAML mocked at the client.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const synthesize = vi.fn()
const callTool = vi.fn()
vi.mock('@hames-ai/harness-patterns/mcp-client.server', async (orig) => ({
  ...(await orig<object>()),
  callTool,
}))
vi.mock('@hames-ai/harness-baml/baml_client', () => ({ b: { Synthesize: synthesize } }))
vi.mock('@boundaryml/baml', () => {
  class MockCollector {
    last = {
      rawLlmResponse: 'raw',
      usage: { inputTokens: 40, outputTokens: 12 },
      calls: [{ httpRequest: { body: { messages: [] } }, provider: 'x', clientName: 'x' }],
    }
    constructor(public readonly name?: string) {}
  }
  class BamlValidationError extends Error {}
  return { Collector: MockCollector, BamlValidationError }
})

beforeEach(() => {
  vi.clearAllMocks()
  synthesize.mockResolvedValue('answer')
})

const ONLY_THE_RETURN_TEXT = [
  { n: 0, tool_result: { tool: 'response', result: 'Twice 42 is 84.', success: true } },
]

describe('Return-only turn reaches Synthesize', () => {
  it('defaultSynthesize turns a response-only input into one `response` turn', async () => {
    const { defaultSynthesize } = await import('@hames-ai/harness-baml/defaults.server')
    await defaultSynthesize({
      mode: 'response',
      userMessage: 'double that',
      intent: 'double that',
      response: 'Twice 42 is 84.',
    } as never)
    expect(synthesize.mock.calls[0][2]).toMatchObject(ONLY_THE_RETURN_TEXT)
    expect(synthesize.mock.calls[0][2]).toHaveLength(1)
  })

  it('simpleLoop (stub controller) → compactExecution → Synthesize', async () => {
    const { defaultSynthesize } = await import('@hames-ai/harness-baml/defaults.server')
    const { simpleLoop } = await import('@hames-ai/harness-patterns/patterns/simpleLoop.server')
    const { compactExecution } =
      await import('@hames-ai/harness-patterns/patterns/compactExecution.server')
    const { runChain } = await import('@hames-ai/harness-patterns/patterns/chain.server')
    const { createEvent } = await import('@hames-ai/harness-patterns/context.server')
    const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')

    const loop = simpleLoop(
      async () => ({
        action: {
          reasoning: '',
          tool_name: 'Return',
          tool_args: 'Twice 42 is 84.',
          status: 'ok',
          is_final: true,
        },
        llmCall: undefined,
      }),
      ['lookup'],
      { patternId: 'execute' },
    )
    const synth = compactExecution<Record<string, unknown>>({
      mode: 'thread',
      patternId: 'response-synth',
      viewConfig: { fromPatterns: ['harness', 'execute'], fromLastNTurns: 1 },
      synthesize: defaultSynthesize,
    })
    const ctx = {
      sessionId: 's',
      createdAt: Date.now(),
      events: [createEvent('user_message', 'harness', { content: 'double that' })],
      status: 'running' as const,
      data: {},
      input: 'double that',
    }
    await withRunFrame({}, () => runChain(ctx, [loop, synth]))

    expect(synthesize).toHaveBeenCalledTimes(1)
    expect(synthesize.mock.calls[0][2]).toMatchObject(ONLY_THE_RETURN_TEXT)
    expect(synthesize.mock.calls[0][2]).toHaveLength(1)
  })

  // #614. The real chain, the real tool-call path: the controller's one call
  // fails, then it Returns an answer from context. Mutations (each run): drop the
  // `returnText` field set in compactExecution's all-failed branch → only the
  // error turn is sent; drop the `input.returnText` append in defaultSynthesize
  // → same; make `succeeded` count a failed result → the field is never set.
  it('a failed tool call then a Return keeps the answer beside the error', async () => {
    callTool.mockResolvedValue({ success: false, error: 'lookup exploded', data: null })
    const { defaultSynthesize } = await import('@hames-ai/harness-baml/defaults.server')
    const { simpleLoop } = await import('@hames-ai/harness-patterns/patterns/simpleLoop.server')
    const { compactExecution } =
      await import('@hames-ai/harness-patterns/patterns/compactExecution.server')
    const { runChain } = await import('@hames-ai/harness-patterns/patterns/chain.server')
    const { createEvent } = await import('@hames-ai/harness-patterns/context.server')
    const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')

    const script = [
      { tool_name: 'lookup', tool_args: '{}', is_final: false },
      { tool_name: 'Return', tool_args: 'Twice 42 is 84.', is_final: true },
    ]
    let i = 0
    const loop = simpleLoop(
      async () => ({
        action: { reasoning: '', status: 'ok', ...script[Math.min(i++, 1)] },
        llmCall: undefined,
      }),
      ['lookup'],
      { patternId: 'execute' },
    )
    const synth = compactExecution<Record<string, unknown>>({
      mode: 'thread',
      patternId: 'response-synth',
      viewConfig: { fromPatterns: ['harness', 'execute'], fromLastNTurns: 1 },
      synthesize: defaultSynthesize,
    })
    const ctx = {
      sessionId: 's',
      createdAt: Date.now(),
      events: [createEvent('user_message', 'harness', { content: 'double that' })],
      status: 'running' as const,
      data: {},
      input: 'double that',
    }
    await withRunFrame({}, () => runChain(ctx, [loop, synth]))

    const turns = synthesize.mock.calls[0][2]
    expect(turns).toHaveLength(2)
    expect(turns[0].tool_result.result).toContain('lookup exploded')
    expect(turns[1].tool_result).toMatchObject({ tool: 'response', result: 'Twice 42 is 84.' })
  })

  // #614 review finding 6: the appended turn's `n` must not repeat a surviving
  // iteration's `turn` (a refused call leaves the history at [turn 1]).
  // Mutation: `n: 0` / `iterations.length` → both headers read Turn 1.
  it('numbers the appended answer turn after the last surviving iteration', async () => {
    const { defaultSynthesize } = await import('@hames-ai/harness-baml/defaults.server')
    await defaultSynthesize({
      mode: 'thread',
      userMessage: 'q',
      intent: 'q',
      returnText: 'From context.',
      loopHistory: {
        iterations: [
          {
            turn: 1,
            action: { reasoning: '', tool_name: 'lookup', tool_args: '{}', status: 'ok' },
            result: { __error: 'boom' },
            timestamp: 0,
          },
        ],
        startTime: 0,
        endTime: 1,
      },
    } as never)
    expect(synthesize.mock.calls[0][2].map((t: { n: number }) => t.n)).toEqual([1, 2])
  })
})
