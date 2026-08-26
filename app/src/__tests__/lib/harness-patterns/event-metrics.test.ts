/**
 * Event-level token/cost accounting (#122).
 *
 * `computeEventMetrics` must report the harness step's TRUE bill: summed
 * across every physical API call the step made (truncation retries, fallback
 * chains) — not just the selected exchange that `llmCall.usage` describes.
 * Cache read/write buckets come from the raw HTTP response (the Collector's
 * Usage has no cache-write field); cost is stamped in EUR with the per-client
 * rates in force, and omitted entirely when any token-bearing attempt could not
 * be priced (unknown beats silently wrong).
 *
 * The two pricing MODELS and the attribution rule have their own suite:
 * `__tests__/lib/pricing-eur.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))
vi.mock('../../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: vi.fn(),
  listTools: vi.fn().mockResolvedValue([]),
}))

/** Fake collector call whose httpResponse carries Anthropic-style usage. */
function apiCall(clientName: string, usage: Record<string, number>) {
  return {
    selected: false,
    clientName,
    provider: 'anthropic',
    httpResponse: { body: { json: () => ({ usage }) } },
  }
}

function fakeCollector(logs: Array<{ calls: unknown[] }>) {
  return { logs, last: logs[logs.length - 1] ?? null }
}

describe('estimateLlmCostEur (token basis)', () => {
  it('prices the cache buckets at their multipliers, in euro', async () => {
    const { estimateLlmCostEur } = await import('../../../lib/settings')
    const est = estimateLlmCostEur(
      {
        inputUncachedTokens: 1_000_000,
        inputCacheReadTokens: 1_000_000,
        inputCacheWriteTokens: 1_000_000,
        outputTokens: 1_000_000,
      },
      'AnthropicSonnet5',
      { usdEurRate: 0.5 },
    )
    // Sonnet 5 intro: $2 in / $10 out per MTok → €1 / €5 at this rate
    expect(est).toBeDefined()
    expect(est!.basis).toBe('tokens')
    expect(est!.costEur).toBeCloseTo(1 + 1 * 0.1 + 1 * 1.25 + 5, 6) // 7.35
    expect(est!.noCacheEur).toBeCloseTo(3 * 1 + 5, 6) // 8.0
    // `rates` is the audit trail, so it is the €/MTok actually applied.
    expect(est!.rates).toEqual({ inPerMTok: 1.0, outPerMTok: 5.0 })
    expect(est!.timeRate).toBeUndefined()
  })

  it('returns undefined for clients without a pricing entry', async () => {
    const { estimateLlmCostEur } = await import('../../../lib/settings')
    expect(
      estimateLlmCostEur(
        {
          inputUncachedTokens: 100,
          inputCacheReadTokens: 0,
          inputCacheWriteTokens: 0,
          outputTokens: 10,
        },
        'AClientWithNoPricingEntry',
      ),
    ).toBeUndefined()
  })
})

describe('computeEventMetrics', () => {
  it('sums the true bill across a truncated attempt and its retry', async () => {
    const { computeEventMetrics } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    // Log 1: the truncated call — full input billed, 32k output burned.
    // Log 2: the corrective retry that produced the visible action.
    const collector = fakeCollector([
      {
        calls: [
          apiCall('AnthropicSonnet5', {
            input_tokens: 200,
            cache_read_input_tokens: 5000,
            cache_creation_input_tokens: 500,
            output_tokens: 32_768,
          }),
        ],
      },
      {
        calls: [
          apiCall('AnthropicSonnet5', {
            input_tokens: 250,
            cache_read_input_tokens: 5500,
            cache_creation_input_tokens: 300,
            output_tokens: 900,
          }),
        ],
      },
    ])
    const m = computeEventMetrics(collector as never)
    expect(m).toBeDefined()
    expect(m!.attempts).toBe(2)
    expect(m!.inputUncachedTokens).toBe(450)
    expect(m!.inputCacheReadTokens).toBe(10_500)
    expect(m!.inputCacheWriteTokens).toBe(800)
    expect(m!.outputTokens).toBe(33_668)
    // Cost includes the burned 32k output — the whole point of step accounting
    const { DEFAULT_USD_EUR_RATE } = await import('../../../lib/settings')
    const r = DEFAULT_USD_EUR_RATE
    const expected = ((450 + 800 * 1.25 + 10_500 * 0.1) * 2 * r + 33_668 * 10 * r) / 1e6
    expect(m!.basis).toBe('tokens')
    expect(m!.costEur).toBeCloseTo(expected, 9)
    expect(m!.noCacheEur).toBeCloseTo(((450 + 800 + 10_500) * 2 * r + 33_668 * 10 * r) / 1e6, 9)
    expect(m!.rates).toEqual({ inPerMTok: 2.0 * r, outPerMTok: 10.0 * r })
  })

  it('sums multiple attempts WITHIN one log (client fallback)', async () => {
    const { computeEventMetrics } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const collector = fakeCollector([
      {
        calls: [
          apiCall('AnthropicSonnet5', { input_tokens: 100, output_tokens: 50 }),
          apiCall('AnthropicSonnet46', { input_tokens: 100, output_tokens: 60 }),
        ],
      },
    ])
    const m = computeEventMetrics(collector as never)
    expect(m!.attempts).toBe(2)
    expect(m!.inputUncachedTokens).toBe(200)
    expect(m!.outputTokens).toBe(110)
    // Per-attempt rates: Sonnet5 intro (2/10) + Sonnet46 standard (3/15)
    const { DEFAULT_USD_EUR_RATE: r } = await import('../../../lib/settings')
    expect(m!.costEur).toBeCloseTo(((100 * 2 + 50 * 10) / 1e6 + (100 * 3 + 60 * 15) / 1e6) * r, 9)
  })

  it('omits cost (not zero) when any token-bearing attempt is unpriced', async () => {
    const { computeEventMetrics } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const collector = fakeCollector([
      { calls: [apiCall('AClientWithNoPricingEntry', { input_tokens: 400, output_tokens: 200 })] },
      { calls: [apiCall('AnthropicSonnet5', { input_tokens: 100, output_tokens: 50 })] },
    ])
    const m = computeEventMetrics(collector as never)
    expect(m!.attempts).toBe(2)
    expect(m!.inputUncachedTokens).toBe(500) // tokens still summed
    expect(m!.costEur).toBeUndefined()
    expect(m!.noCacheEur).toBeUndefined()
    expect(m!.basis).toBeUndefined()
  })

  it('prices a self-hosted attempt by its OWN measured duration, not by tokens', async () => {
    const { computeEventMetrics } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { DEFAULT_VERDA_EUR_PER_HOUR, TIME_PRICED_CLIENT } = await import('../../../lib/settings')
    const collector = fakeCollector([
      {
        calls: [
          {
            ...apiCall(TIME_PRICED_CLIENT, { input_tokens: 900_000, output_tokens: 40_000 }),
            timing: { durationMs: 6_300 },
          },
        ],
      },
    ])
    const m = computeEventMetrics(collector as never)!
    expect(m.basis).toBe('time')
    // Nearly a million tokens and the price is 6.3 GPU-seconds. Tokens are free.
    expect(m.costEur).toBeCloseTo((6.3 / 3600) * DEFAULT_VERDA_EUR_PER_HOUR, 12)
    expect(m.timeRate).toEqual({
      eurPerHour: DEFAULT_VERDA_EUR_PER_HOUR,
      durationMs: 6_300,
    })
    expect(m.rates).toBeUndefined()
    // The tokens are still counted — they are the size of the call, just not its price.
    expect(m.inputUncachedTokens).toBe(900_000)
  })

  it('prices each attempt under its own client when a step spans both boxes', async () => {
    // The attribution rule with teeth: a step that started on the self-hosted
    // box and retried on Anthropic pays wall-clock for the first attempt and
    // tokens for the second. Pricing the whole step by the run's intended tier
    // would bill one of the two wrong.
    const { computeEventMetrics } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { DEFAULT_USD_EUR_RATE, DEFAULT_VERDA_EUR_PER_HOUR, TIME_PRICED_CLIENT } =
      await import('../../../lib/settings')
    const collector = fakeCollector([
      {
        calls: [
          {
            ...apiCall(TIME_PRICED_CLIENT, { input_tokens: 5_000, output_tokens: 100 }),
            timing: { durationMs: 3_600_000 },
          },
          {
            ...apiCall('AnthropicSonnet5', { input_tokens: 5_000, output_tokens: 100 }),
            timing: { durationMs: 1_000 },
          },
        ],
      },
    ])
    const m = computeEventMetrics(collector as never)!
    const anthropicEur = ((5_000 * 2 + 100 * 10) / 1e6) * DEFAULT_USD_EUR_RATE
    expect(m.attempts).toBe(2)
    expect(m.costEur).toBeCloseTo(DEFAULT_VERDA_EUR_PER_HOUR + anthropicEur, 9)
    // The audit fields describe the LAST priced attempt — the Anthropic one.
    expect(m.basis).toBe('tokens')
    expect(m.rates).toBeDefined()
  })

  it('omits the whole step cost when a self-hosted attempt was not measured', async () => {
    // A time bill with no time is not a free call, and the step's other attempts
    // cannot stand in for it: the honest reading is unknown.
    const { computeEventMetrics } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { TIME_PRICED_CLIENT } = await import('../../../lib/settings')
    const collector = fakeCollector([
      { calls: [apiCall(TIME_PRICED_CLIENT, { input_tokens: 5_000, output_tokens: 100 })] },
    ])
    const m = computeEventMetrics(collector as never)!
    expect(m.attempts).toBe(1)
    expect(m.inputUncachedTokens).toBe(5_000)
    expect(m.costEur).toBeUndefined()
    expect(m.basis).toBeUndefined()
  })

  it('honours the env rates when pricing a step', async () => {
    const { computeEventMetrics } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { TIME_PRICED_CLIENT } = await import('../../../lib/settings')
    const saved = process.env.VERDA_EUR_PER_HOUR
    process.env.VERDA_EUR_PER_HOUR = '3.5'
    try {
      const collector = fakeCollector([
        {
          calls: [
            {
              ...apiCall(TIME_PRICED_CLIENT, { input_tokens: 10, output_tokens: 1 }),
              timing: { durationMs: 3_600_000 },
            },
          ],
        },
      ])
      expect(computeEventMetrics(collector as never)!.costEur).toBeCloseTo(3.5, 9)
    } finally {
      if (saved === undefined) delete process.env.VERDA_EUR_PER_HOUR
      else process.env.VERDA_EUR_PER_HOUR = saved
    }
  })

  it('falls back to Collector usage when a call has no readable response body', async () => {
    const { computeEventMetrics } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const collector = fakeCollector([
      {
        calls: [
          {
            clientName: 'AnthropicSonnet5',
            usage: { inputTokens: 120, outputTokens: 40, cachedInputTokens: 30 },
          },
        ],
      },
    ])
    const m = computeEventMetrics(collector as never)
    expect(m!.attempts).toBe(1)
    expect(m!.inputUncachedTokens).toBe(120)
    expect(m!.inputCacheReadTokens).toBe(30)
    expect(m!.inputCacheWriteTokens).toBe(0) // write bucket unknowable here
    expect(m!.outputTokens).toBe(40)
  })

  it('returns undefined when no attempt produced usage (pre-flight failure)', async () => {
    const { computeEventMetrics } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    expect(
      computeEventMetrics(
        fakeCollector([{ calls: [{ clientName: 'AnthropicSonnet5' }] }]) as never,
      ),
    ).toBeUndefined()
    expect(computeEventMetrics(undefined)).toBeUndefined()
  })
})

describe('createEvent lifts metrics onto the event', () => {
  it('event.metrics mirrors llmCall.metrics; absent when the call has none', async () => {
    const { createEvent } = await import('../../../lib/harness-patterns/context.server')
    const metrics = {
      inputUncachedTokens: 100,
      inputCacheReadTokens: 5000,
      inputCacheWriteTokens: 300,
      outputTokens: 250,
      attempts: 1,
      costEur: 0.001,
      noCacheEur: 0.002,
      basis: 'tokens' as const,
      rates: { inPerMTok: 2, outPerMTok: 10 },
    }
    const withMetrics = createEvent(
      'controller_action',
      'p1',
      { a: 1 },
      { functionName: 'LoopController', variables: {}, metrics },
    )
    expect(withMetrics.metrics).toEqual(metrics)
    expect(withMetrics.llmCall?.metrics).toEqual(metrics)

    const without = createEvent(
      'controller_action',
      'p1',
      { a: 1 },
      { functionName: 'LoopController', variables: {} },
    )
    expect(without.metrics).toBeUndefined()

    const nonLlm = createEvent('tool_result', 'p1', { tool: 'x' })
    expect(nonLlm.metrics).toBeUndefined()
  })
})
