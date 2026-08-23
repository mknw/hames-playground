/**
 * Session token/cost accounting — the fold behind the panel's summary bar.
 *
 * The panel's own tests read the rendered bar; these pin the arithmetic
 * directly, including the two derived ratios and the legacy `llmCall.usage`
 * fallback for events recorded before `metrics` existed (#122).
 */
import { describe, it, expect } from 'vitest'
import type { ContextEvent } from '~/lib/harness-patterns'
import type { EventMetrics } from '~/lib/harness-patterns/types'
import { fmtTok, fmtUsd, foldTokenTotals } from '~/lib/observability/token-totals'

const metrics = (m: Partial<EventMetrics> = {}): EventMetrics => ({
  inputUncachedTokens: 1000,
  inputCacheReadTokens: 0,
  inputCacheWriteTokens: 0,
  outputTokens: 200,
  attempts: 1,
  ...m,
})

let seq = 0
const ev = (extra: Partial<ContextEvent> = {}): ContextEvent => ({
  type: 'controller_action',
  ts: ++seq,
  patternId: 'neo4j-query',
  data: {},
  ...extra,
})

describe('fmtTok', () => {
  it('abbreviates from a thousand up and leaves smaller counts alone', () => {
    expect(fmtTok(0)).toBe('0')
    expect(fmtTok(999)).toBe('999')
    expect(fmtTok(1000)).toBe('1.0k')
    expect(fmtTok(25_320)).toBe('25.3k')
  })
})

describe('fmtUsd', () => {
  it('keeps sub-cent costs at four decimals and rounds larger ones to two', () => {
    expect(fmtUsd(0.0123)).toBe('$0.0123')
    expect(fmtUsd(0.1)).toBe('$0.10')
    expect(fmtUsd(1.239)).toBe('$1.24')
  })
})

describe('foldTokenTotals', () => {
  it('returns zeroed totals and no ratios for an empty stream', () => {
    expect(foldTokenTotals([])).toMatchObject({
      llmCalls: 0,
      attempts: 0,
      inputTotal: 0,
      cachedPct: 0,
      savedPct: 0,
    })
  })

  it('sums metrics across events', () => {
    const totals = foldTokenTotals([
      ev({ metrics: metrics() }),
      ev({ metrics: metrics({ inputUncachedTokens: 500, outputTokens: 50 }) }),
    ])
    expect(totals).toMatchObject({
      llmCalls: 2,
      attempts: 2,
      inputUncached: 1500,
      output: 250,
      inputTotal: 1500,
    })
  })

  it('counts cache writes into the input denominator, diluting the cached share', () => {
    const totals = foldTokenTotals([
      ev({
        metrics: metrics({
          inputUncachedTokens: 0,
          inputCacheReadTokens: 300,
          inputCacheWriteTokens: 100,
        }),
      }),
    ])
    expect(totals.inputTotal).toBe(400)
    expect(totals.cachedPct).toBeCloseTo(0.75)
  })

  it('accumulates cost only from priced calls and reports the caching saving', () => {
    const totals = foldTokenTotals([
      ev({ metrics: metrics({ costUsd: 0.02, noCacheUsd: 0.05 }) }),
      ev({ metrics: metrics() }),
    ])
    expect(totals.llmCalls).toBe(2)
    expect(totals.costKnownCalls).toBe(1)
    expect(totals.costUsd).toBeCloseTo(0.02)
    expect(totals.savedPct).toBeCloseTo(0.6)
  })

  it('treats a priced call with no uncached figure as having saved nothing', () => {
    const totals = foldTokenTotals([ev({ metrics: metrics({ costUsd: 0.03 }) })])
    expect(totals.noCacheUsd).toBeCloseTo(0.03)
    expect(totals.savedPct).toBe(0)
  })

  it('counts retry attempts above the number of LLM steps', () => {
    const totals = foldTokenTotals([ev({ metrics: metrics({ attempts: 3 }) })])
    expect(totals.llmCalls).toBe(1)
    expect(totals.attempts).toBe(3)
  })

  it('falls back to llmCall.usage — one attempt, no cost — for pre-metrics events', () => {
    const totals = foldTokenTotals([
      ev({
        llmCall: {
          functionName: 'Router',
          usage: {
            inputTokens: 800,
            cachedInputTokens: 200,
            cacheCreationInputTokens: 100,
            outputTokens: 40,
            totalTokens: 1140,
          },
        },
      }),
    ])
    expect(totals).toMatchObject({
      llmCalls: 1,
      attempts: 1,
      inputUncached: 800,
      cacheRead: 200,
      cacheWrite: 100,
      output: 40,
      costUsd: 0,
      costKnownCalls: 0,
    })
  })

  it('defaults a missing cache-write figure on the legacy shape to zero', () => {
    const totals = foldTokenTotals([
      ev({
        llmCall: {
          functionName: 'Router',
          usage: {
            inputTokens: 10,
            cachedInputTokens: 0,
            outputTokens: 5,
            totalTokens: 15,
          },
        },
      }),
    ])
    expect(totals.cacheWrite).toBe(0)
  })

  it('prefers metrics over llmCall.usage when an event carries both', () => {
    const totals = foldTokenTotals([
      ev({
        metrics: metrics({ inputUncachedTokens: 7 }),
        llmCall: {
          functionName: 'Router',
          usage: {
            inputTokens: 999,
            cachedInputTokens: 0,
            outputTokens: 999,
            totalTokens: 1998,
          },
        },
      }),
    ])
    expect(totals.llmCalls).toBe(1)
    expect(totals.inputUncached).toBe(7)
  })

  it('ignores events that never called an LLM', () => {
    expect(foldTokenTotals([ev({ type: 'tool_call' })]).llmCalls).toBe(0)
  })
})
