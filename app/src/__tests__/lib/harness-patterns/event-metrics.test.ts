/**
 * Event-level token/cost accounting (#122).
 *
 * `computeEventMetrics` must report the harness step's TRUE bill: summed
 * across every physical API call the step made (truncation retries, fallback
 * chains) — not just the selected exchange that `llmCall.usage` describes.
 * Cache read/write buckets come from the raw HTTP response (the Collector's
 * Usage has no cache-write field); cost is stamped with the per-client rates
 * in force, and omitted entirely when any token-bearing attempt has no
 * pricing entry (unknown beats silently wrong).
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

describe('estimateLlmCostUsd', () => {
  it('prices the cache buckets at their multipliers', async () => {
    const { estimateLlmCostUsd } = await import('../../../lib/settings')
    const est = estimateLlmCostUsd(
      { inputUncachedTokens: 1_000_000, inputCacheReadTokens: 1_000_000, inputCacheWriteTokens: 1_000_000, outputTokens: 1_000_000 },
      'AnthropicSonnet5',
    )
    // Sonnet 5 intro: $2 in / $10 out per MTok
    expect(est).toBeDefined()
    expect(est!.costUsd).toBeCloseTo(2 + 2 * 0.1 + 2 * 1.25 + 10, 6)   // 14.7
    expect(est!.noCacheUsd).toBeCloseTo(3 * 2 + 10, 6)                  // 16.0
    expect(est!.rates).toEqual({ inPerMTok: 2.0, outPerMTok: 10.0 })
  })

  it('returns undefined for clients without a pricing entry', async () => {
    const { estimateLlmCostUsd } = await import('../../../lib/settings')
    expect(estimateLlmCostUsd(
      { inputUncachedTokens: 100, inputCacheReadTokens: 0, inputCacheWriteTokens: 0, outputTokens: 10 },
      'GroqFast',
    )).toBeUndefined()
  })
})

describe('computeEventMetrics', () => {
  it('sums the true bill across a truncated attempt and its retry', async () => {
    const { computeEventMetrics } = await import('../../../lib/harness-patterns/baml-adapters.server')
    // Log 1: the truncated call — full input billed, 32k output burned.
    // Log 2: the corrective retry that produced the visible action.
    const collector = fakeCollector([
      { calls: [apiCall('AnthropicSonnet5', { input_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 500, output_tokens: 32_768 })] },
      { calls: [apiCall('AnthropicSonnet5', { input_tokens: 250, cache_read_input_tokens: 5500, cache_creation_input_tokens: 300, output_tokens: 900 })] },
    ])
    const m = computeEventMetrics(collector as never)
    expect(m).toBeDefined()
    expect(m!.attempts).toBe(2)
    expect(m!.inputUncachedTokens).toBe(450)
    expect(m!.inputCacheReadTokens).toBe(10_500)
    expect(m!.inputCacheWriteTokens).toBe(800)
    expect(m!.outputTokens).toBe(33_668)
    // Cost includes the burned 32k output — the whole point of step accounting
    const expected = ((450 + 800 * 1.25 + 10_500 * 0.1) * 2 + 33_668 * 10) / 1e6
    expect(m!.costUsd).toBeCloseTo(expected, 9)
    expect(m!.noCacheUsd).toBeCloseTo(((450 + 800 + 10_500) * 2 + 33_668 * 10) / 1e6, 9)
    expect(m!.rates).toEqual({ inPerMTok: 2.0, outPerMTok: 10.0 })
  })

  it('sums multiple attempts WITHIN one log (client fallback)', async () => {
    const { computeEventMetrics } = await import('../../../lib/harness-patterns/baml-adapters.server')
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
    expect(m!.costUsd).toBeCloseTo((100 * 2 + 50 * 10) / 1e6 + (100 * 3 + 60 * 15) / 1e6, 9)
  })

  it('omits cost (not zero) when any token-bearing attempt is unpriced', async () => {
    const { computeEventMetrics } = await import('../../../lib/harness-patterns/baml-adapters.server')
    const collector = fakeCollector([
      { calls: [apiCall('GroqGPT120B', { input_tokens: 400, output_tokens: 200 })] },
      { calls: [apiCall('AnthropicSonnet5', { input_tokens: 100, output_tokens: 50 })] },
    ])
    const m = computeEventMetrics(collector as never)
    expect(m!.attempts).toBe(2)
    expect(m!.inputUncachedTokens).toBe(500) // tokens still summed
    expect(m!.costUsd).toBeUndefined()
    expect(m!.noCacheUsd).toBeUndefined()
  })

  it('falls back to Collector usage when a call has no readable response body', async () => {
    const { computeEventMetrics } = await import('../../../lib/harness-patterns/baml-adapters.server')
    const collector = fakeCollector([
      { calls: [{ clientName: 'AnthropicSonnet5', usage: { inputTokens: 120, outputTokens: 40, cachedInputTokens: 30 } }] },
    ])
    const m = computeEventMetrics(collector as never)
    expect(m!.attempts).toBe(1)
    expect(m!.inputUncachedTokens).toBe(120)
    expect(m!.inputCacheReadTokens).toBe(30)
    expect(m!.inputCacheWriteTokens).toBe(0) // write bucket unknowable here
    expect(m!.outputTokens).toBe(40)
  })

  it('returns undefined when no attempt produced usage (pre-flight failure)', async () => {
    const { computeEventMetrics } = await import('../../../lib/harness-patterns/baml-adapters.server')
    expect(computeEventMetrics(fakeCollector([{ calls: [{ clientName: 'AnthropicSonnet5' }] }]) as never)).toBeUndefined()
    expect(computeEventMetrics(undefined)).toBeUndefined()
  })
})

describe('createEvent lifts metrics onto the event', () => {
  it('event.metrics mirrors llmCall.metrics; absent when the call has none', async () => {
    const { createEvent } = await import('../../../lib/harness-patterns/context.server')
    const metrics = {
      inputUncachedTokens: 100, inputCacheReadTokens: 5000, inputCacheWriteTokens: 300,
      outputTokens: 250, attempts: 1, costUsd: 0.001, noCacheUsd: 0.002,
      rates: { inPerMTok: 2, outPerMTok: 10 },
    }
    const withMetrics = createEvent('controller_action', 'p1', { a: 1 }, { functionName: 'LoopController', variables: {}, metrics })
    expect(withMetrics.metrics).toEqual(metrics)
    expect(withMetrics.llmCall?.metrics).toEqual(metrics)

    const without = createEvent('controller_action', 'p1', { a: 1 }, { functionName: 'LoopController', variables: {} })
    expect(without.metrics).toBeUndefined()

    const nonLlm = createEvent('tool_result', 'p1', { tool: 'x' })
    expect(nonLlm.metrics).toBeUndefined()
  })
})
