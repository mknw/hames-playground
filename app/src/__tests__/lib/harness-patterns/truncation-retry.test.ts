/**
 * Recoverable parse failures in the BAML adapters: truncation and empty
 * completions. Both surface as the SAME BamlValidationError text ("missing
 * required fields"), so they are handled by one retry branch with two triggers
 * and asserted apart here.
 *
 * A controller response that hits its client's `max_tokens` truncates mid-JSON
 * (observed live: a sandbox actor inlined a full report-generation script into
 * `tool_args`, was cut at exactly the cap, and lost the trailing required
 * fields → BamlValidationError). The adapters detect the cap-hit via the
 * collector's usage + clientName against CLIENT_MAX_OUTPUT_TOKENS and do ONE
 * corrective retry with truncation guidance appended to the per-call `context`.
 *
 * Hermetic: baml_client + MCP are mocked; the "collector" is a plain object
 * shaped like Collector.last (the adapters only read `.last`).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockFinalAction } from '../../mocks/baml'
import { mockListTools } from '../../mocks/mcp'
import type { Collector } from '@boundaryml/baml'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

vi.mock('../../../lib/harness-patterns/mcp-client.server', () => ({
  listTools: mockListTools(['read_neo4j_cypher', 'sandbox_bash', 'Return']),
}))

const mockLoopController = vi.fn()
const mockActorController = vi.fn()

vi.mock('../../../../baml_client', () => ({
  b: {
    LoopController: mockLoopController,
    ActorController: mockActorController,
  },
}))

/** Fake collector whose last call reports the given output tokens + client. */
function fakeCollector(outputTokens: number, clientName: string): Collector {
  return {
    last: {
      usage: { inputTokens: 1000, outputTokens, cachedInputTokens: 0 },
      calls: [{ selected: true, provider: 'anthropic', clientName }],
      rawLlmResponse: '{"reasoning": "truncated mid-way',
    },
  } as unknown as Collector
}

/**
 * Collector for a completion with no text: tokens were spent (the model
 * produced a thinking block whose content is not exposed) but nothing was
 * returned to parse. Well below the cap, so it must not be mistaken for
 * truncation.
 */
function emptyCollector(outputTokens = 689, rawLlmResponse = ''): Collector {
  return {
    last: {
      usage: { inputTokens: 1000, outputTokens, cachedInputTokens: 0 },
      calls: [{ selected: true, provider: 'anthropic', clientName: 'AnthropicSonnet5' }],
      rawLlmResponse,
    },
  } as unknown as Collector
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('llmCallHitOutputCap', () => {
  it('detects a call that hit its configured cap', async () => {
    const { llmCallHitOutputCap } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    expect(
      llmCallHitOutputCap({
        clientName: 'AnthropicSonnet5',
        usage: { inputTokens: 1, outputTokens: 32_768, cachedInputTokens: 0, totalTokens: 32_769 },
      }),
    ).toBe(true)
  })

  it('detects the cap on EVERY capped leaf, at the boundary (SA-C2)', async () => {
    const { llmCallHitOutputCap } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    // The collector reports the selected LEAF's clientName, never the chain's,
    // so each leaf needs its own CLIENT_MAX_OUTPUT_TOKENS entry. Seven
    // Groq/OpenRouter leaves were missing theirs and every production
    // truncation went undetected; those clients are gone, the invariant is not
    // (client-output-caps.test.ts pins the map against baml_src).
    for (const [clientName, cap] of [
      ['AnthropicSonnet5', 32_768],
      ['AnthropicSonnet5NoThink', 32_768],
      ['AnthropicSonnet46', 16_384],
      ['AnthropicSonnet46NoThink', 16_384],
      ['AnthropicHaiku45', 16_384],
      ['AnthropicOpus4', 4_096],
      ['LocalGLM', 2_048],
    ] as const) {
      expect(
        llmCallHitOutputCap({
          clientName,
          usage: { inputTokens: 1, outputTokens: cap, cachedInputTokens: 0, totalTokens: cap + 1 },
        }),
      ).toBe(true)
      expect(
        llmCallHitOutputCap({
          clientName,
          usage: { inputTokens: 1, outputTokens: cap - 1, cachedInputTokens: 0, totalTokens: cap },
        }),
      ).toBe(false)
    }
  })

  it('is false below the cap, for unknown clients, and without usage', async () => {
    const { llmCallHitOutputCap } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    expect(
      llmCallHitOutputCap({
        clientName: 'AnthropicSonnet5',
        usage: { inputTokens: 1, outputTokens: 512, cachedInputTokens: 0, totalTokens: 513 },
      }),
    ).toBe(false)
    expect(
      llmCallHitOutputCap({
        clientName: 'SomeUnknownClient',
        usage: {
          inputTokens: 1,
          outputTokens: 999_999,
          cachedInputTokens: 0,
          totalTokens: 1_000_000,
        },
      }),
    ).toBe(false)
    expect(llmCallHitOutputCap({ clientName: 'AnthropicSonnet5' })).toBe(false)
    expect(llmCallHitOutputCap(undefined)).toBe(false)
  })
})

describe('ActorController truncation retry (Anthropic-only path)', () => {
  it('retries ONCE with truncation guidance appended to context when the output hit the cap', async () => {
    const { createActorControllerAdapter, TRUNCATION_RETRY_GUIDANCE } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    mockActorController
      .mockRejectedValueOnce(
        new BamlValidationError(
          'prompt',
          'raw',
          'missing status/is_final',
          'missing status/is_final',
        ),
      )
      .mockResolvedValueOnce(mockFinalAction('Recovered'))

    const actor = createActorControllerAdapter({
      toolNames: ['sandbox_bash'],
      contextPrefix: 'You have a sandbox.',
    })
    const result = await actor(
      'do the thing',
      'intent',
      [],
      [],
      fakeCollector(32_768, 'AnthropicSonnet5'),
      1,
      6,
    )

    expect(result.action).toBeDefined()
    expect(mockActorController).toHaveBeenCalledTimes(2)
    // context is the 5th positional arg — the retry must carry the guidance.
    const retryContext = mockActorController.mock.calls[1][4] as string
    expect(retryContext).toContain('You have a sandbox.')
    expect(retryContext).toContain(TRUNCATION_RETRY_GUIDANCE)
    // First call must NOT have the guidance (it's retry-only, per-call scoped).
    expect(String(mockActorController.mock.calls[0][4])).not.toContain('CUT OFF')
  })

  it('does NOT retry when the parse failure was not a cap-hit (rethrows as LLMCallError)', async () => {
    const { createActorControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    mockActorController.mockRejectedValueOnce(
      new BamlValidationError('prompt', 'raw', 'bad output', 'bad output'),
    )

    const { LLMCallError } = await import('../../../lib/harness-patterns/baml-adapters.server')
    const actor = createActorControllerAdapter({ toolNames: ['sandbox_bash'] })
    await expect(
      actor('do the thing', 'intent', [], [], fakeCollector(512, 'AnthropicSonnet5'), 1, 6),
    ).rejects.toBeInstanceOf(LLMCallError)
    expect(mockActorController).toHaveBeenCalledTimes(1)
  })

  it('throws LLMCallError when the truncation retry also fails (exactly one retry)', async () => {
    const { createActorControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    mockActorController
      .mockRejectedValueOnce(new BamlValidationError('prompt', 'raw', 'truncated', 'truncated'))
      .mockRejectedValueOnce(
        new BamlValidationError('prompt', 'raw', 'truncated again', 'truncated again'),
      )

    const { LLMCallError } = await import('../../../lib/harness-patterns/baml-adapters.server')
    const actor = createActorControllerAdapter({ toolNames: ['sandbox_bash'] })
    await expect(
      actor('do the thing', 'intent', [], [], fakeCollector(16_384, 'AnthropicHaiku45'), 1, 6),
    ).rejects.toBeInstanceOf(LLMCallError)
    expect(mockActorController).toHaveBeenCalledTimes(2)
  })
})

describe('LoopController truncation retry (Anthropic-only path)', () => {
  it('retries ONCE with truncation guidance appended to context', async () => {
    const { createLoopControllerAdapter, TRUNCATION_RETRY_GUIDANCE } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    mockLoopController
      .mockRejectedValueOnce(
        new BamlValidationError('prompt', 'raw', 'missing fields', 'missing fields'),
      )
      .mockResolvedValueOnce(mockFinalAction('Recovered'))

    const controller = createLoopControllerAdapter(['read_neo4j_cypher', 'Return'], 'Prefix.')
    const result = await controller(
      'user message',
      'intent',
      '[]',
      0,
      undefined,
      fakeCollector(16_384, 'AnthropicSonnet46'),
    )

    expect(result.action).toBeDefined()
    expect(mockLoopController).toHaveBeenCalledTimes(2)
    const retryContext = mockLoopController.mock.calls[1][4] as string
    expect(retryContext).toContain('Prefix.')
    expect(retryContext).toContain(TRUNCATION_RETRY_GUIDANCE)
  })

  it('without a cap-hit, a parse failure rethrows — no retry, no escalation', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    mockLoopController.mockRejectedValueOnce(
      new BamlValidationError('prompt', 'raw', 'bad output', 'bad output'),
    )

    const { LLMCallError } = await import('../../../lib/harness-patterns/baml-adapters.server')
    const controller = createLoopControllerAdapter(['Return'])
    await expect(
      controller(
        'user message',
        'intent',
        '[]',
        0,
        undefined,
        fakeCollector(512, 'AnthropicSonnet46'),
      ),
    ).rejects.toBeInstanceOf(LLMCallError)
    expect(mockLoopController).toHaveBeenCalledTimes(1)
  })
})

describe('the retry stays on the declared chain', () => {
  it('appends guidance to the SAME call — it never swaps the client', async () => {
    const { createLoopControllerAdapter, TRUNCATION_RETRY_GUIDANCE } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    mockLoopController
      .mockRejectedValueOnce(new BamlValidationError('prompt', 'raw', 'truncated', 'truncated'))
      .mockResolvedValueOnce(mockFinalAction('Recovered'))

    const controller = createLoopControllerAdapter(['Return'])
    const result = await controller(
      'user message',
      'intent',
      '[]',
      0,
      undefined,
      fakeCollector(16_384, 'AnthropicSonnet46'),
    )

    expect(result.action).toBeDefined()
    expect(mockLoopController).toHaveBeenCalledTimes(2)
    // A truncation is a transport failure, not a model-capability one: the
    // remedy is a smaller response on the same client. The old ladder hopped
    // to a leaf with HALF the cap that had just truncated — nothing may
    // reintroduce a client swap on this path.
    const retryCall = mockLoopController.mock.calls[1]
    const retryOpts = retryCall[retryCall.length - 1] as { client?: string } | undefined
    expect(retryOpts?.client).toBeUndefined()
    expect(String(retryCall[4])).toContain(TRUNCATION_RETRY_GUIDANCE)
  })
})

/**
 * Empty completions: the model spends output tokens and returns no text (a
 * thinking block, whose content is not exposed, then `end_turn`). Measured at
 * ~16% on one replayed controller request — 7 of 43 calls, against 0 of 37 with
 * thinking disabled. The parse "failure" is a misnomer: there is nothing to
 * parse, so asking again IS the remedy and there is nothing to correct.
 */
describe('empty-completion retry', () => {
  it('LoopController retries ONCE with the context UNCHANGED', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    mockLoopController
      .mockRejectedValueOnce(new BamlValidationError('prompt', '', 'missing=5', 'missing=5'))
      .mockResolvedValueOnce(mockFinalAction('Recovered'))

    const controller = createLoopControllerAdapter(['Return'], 'Graph context.')
    const result = await controller('user message', 'intent', '[]', 2, undefined, emptyCollector())

    expect(result.action).toBeDefined()
    expect(mockLoopController).toHaveBeenCalledTimes(2)
    // Same context both times: no guidance, because the model did not err —
    // it produced nothing. Telling it "your response was cut off" would be false.
    const first = mockLoopController.mock.calls[0][4]
    const retry = mockLoopController.mock.calls[1][4]
    expect(retry).toEqual(first)
    expect(String(retry)).not.toContain('CUT OFF')
  })

  it('ActorController retries ONCE with the context UNCHANGED', async () => {
    const { createActorControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    mockActorController
      .mockRejectedValueOnce(new BamlValidationError('prompt', '', 'missing=5', 'missing=5'))
      .mockResolvedValueOnce(mockFinalAction('Recovered'))

    const actor = createActorControllerAdapter({
      toolNames: ['sandbox_bash'],
      contextPrefix: 'You have a sandbox.',
    })
    const result = await actor('do the thing', 'intent', [], [], emptyCollector(), 1, 6)

    expect(result.action).toBeDefined()
    expect(mockActorController).toHaveBeenCalledTimes(2)
    expect(mockActorController.mock.calls[1][4]).toEqual(mockActorController.mock.calls[0][4])
    expect(String(mockActorController.mock.calls[1][4])).not.toContain('CUT OFF')
  })

  it('whitespace-only output counts as empty', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    mockLoopController
      .mockRejectedValueOnce(new BamlValidationError('prompt', '\n  \n', 'missing=5', 'missing=5'))
      .mockResolvedValueOnce(mockFinalAction('Recovered'))

    const controller = createLoopControllerAdapter(['Return'])
    await controller('user message', 'intent', '[]', 1, undefined, emptyCollector(400, '\n  \n'))
    expect(mockLoopController).toHaveBeenCalledTimes(2)
  })

  it('a cap-hit still wins: truncation guidance, not a bare retry', async () => {
    const { createLoopControllerAdapter, TRUNCATION_RETRY_GUIDANCE } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    mockLoopController
      .mockRejectedValueOnce(new BamlValidationError('prompt', '', 'missing=5', 'missing=5'))
      .mockResolvedValueOnce(mockFinalAction('Recovered'))

    const controller = createLoopControllerAdapter(['Return'])
    // Empty raw response AND at the cap — a response cut off before any text
    // reached us is still truncation, and the model needs to know why.
    await controller('user message', 'intent', '[]', 1, undefined, emptyCollector(32_768, ''))
    expect(String(mockLoopController.mock.calls[1][4])).toContain(TRUNCATION_RETRY_GUIDANCE)
  })

  it('exactly one retry: a second empty response throws LLMCallError', async () => {
    const { createLoopControllerAdapter, LLMCallError } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    mockLoopController
      .mockRejectedValueOnce(new BamlValidationError('prompt', '', 'missing=5', 'missing=5'))
      .mockRejectedValueOnce(new BamlValidationError('prompt', '', 'missing=5', 'missing=5'))

    const controller = createLoopControllerAdapter(['Return'])
    await expect(
      controller('user message', 'intent', '[]', 1, undefined, emptyCollector()),
    ).rejects.toBeInstanceOf(LLMCallError)
    expect(mockLoopController).toHaveBeenCalledTimes(2)
  })

  it('a non-empty response that simply failed to parse is NOT retried', async () => {
    const { createLoopControllerAdapter, LLMCallError } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    mockLoopController.mockRejectedValueOnce(
      new BamlValidationError('prompt', 'Turn 2 action: …', 'missing=5', 'missing=5'),
    )

    const controller = createLoopControllerAdapter(['Return'])
    await expect(
      controller(
        'user message',
        'intent',
        '[]',
        1,
        undefined,
        emptyCollector(500, 'Turn 2 action: …'),
      ),
    ).rejects.toBeInstanceOf(LLMCallError)
    expect(mockLoopController).toHaveBeenCalledTimes(1)
  })
})
