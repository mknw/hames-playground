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
import { fmtTok, fmtEur, foldTokenTotals } from '~/lib/observability/token-totals'
import { DEFAULT_EUR_PER_USD } from '~/lib/settings'

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

describe('fmtEur', () => {
  it('keeps sub-cent costs at four decimals and rounds larger ones to two', () => {
    expect(fmtEur(0.0123)).toBe('€0.0123')
    expect(fmtEur(0.1)).toBe('€0.10')
    expect(fmtEur(1.239)).toBe('€1.24')
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
      ev({ metrics: metrics({ costEur: 0.02, noCacheEur: 0.05 }) }),
      ev({ metrics: metrics() }),
    ])
    expect(totals.llmCalls).toBe(2)
    expect(totals.costKnownCalls).toBe(1)
    expect(totals.costEur).toBeCloseTo(0.02)
    expect(totals.savedPct).toBeCloseTo(0.6)
  })

  it('treats a priced call with no uncached figure as having saved nothing', () => {
    const totals = foldTokenTotals([ev({ metrics: metrics({ costEur: 0.03 }) })])
    expect(totals.noCacheEur).toBeCloseTo(0.03)
    expect(totals.savedPct).toBe(0)
  })

  it('flags the total as a floor when a step was billed by wall-clock', () => {
    // A time-priced step's figure covers only the durations of the calls; the
    // box is also paid for the idle window after them and the cold start before
    // them. `timePricedCalls > 0` is what makes the bar render a `≥`.
    const totals = foldTokenTotals([
      ev({ metrics: metrics({ costEur: 0.01, noCacheEur: 0.01, basis: 'time' }) }),
      ev({ metrics: metrics({ costEur: 0.02, noCacheEur: 0.05, basis: 'tokens' }) }),
    ])
    expect(totals.timePricedCalls).toBe(1)
    expect(totals.costEur).toBeCloseTo(0.03)
  })

  it('flags a MIXED step a floor too — the panel folds the same rule as the dashboard', () => {
    // `basis` names the last priced attempt, so a step that retried from the
    // self-hosted box onto Anthropic reads `'tokens'` while still holding a
    // wall-clock bill. Gating on it dropped the bar's `≥` for that session.
    const totals = foldTokenTotals([
      ev({
        metrics: metrics({
          costEur: 1.83,
          noCacheEur: 1.83,
          basis: 'tokens',
          timePricedAttempts: 1,
        }),
      }),
    ])
    expect(totals.timePricedCalls).toBe(1)
  })

  it('leaves timePricedCalls at zero for an all-token session', () => {
    const totals = foldTokenTotals([
      ev({ metrics: metrics({ costEur: 0.02, noCacheEur: 0.05, basis: 'tokens' }) }),
    ])
    expect(totals.timePricedCalls).toBe(0)
  })

  it('converts a pre-EUR stamp at the DEFAULT rate rather than dropping it', () => {
    // Events persisted before the currency fix carry `costUsd`. Reading them as
    // unpriced would empty the panel for every historical conversation; the
    // figure was always a token-priced Anthropic estimate, so converting it is
    // as accurate as converting a new one. The DEFAULT rate, not the operator's
    // current one — the rate in force at stamp time was never recorded.
    const totals = foldTokenTotals([
      ev({ metrics: { ...metrics(), costUsd: 0.5, noCacheUsd: 1.0 } }),
    ])
    expect(totals.costKnownCalls).toBe(1)
    expect(totals.costEur).toBeCloseTo(0.5 * DEFAULT_EUR_PER_USD, 9)
    expect(totals.noCacheEur).toBeCloseTo(1.0 * DEFAULT_EUR_PER_USD, 9)
    // No basis on a legacy stamp ⇒ not counted as a floor.
    expect(totals.timePricedCalls).toBe(0)
  })

  it('prefers a new EUR stamp over a legacy USD one on the same event', () => {
    const totals = foldTokenTotals([
      ev({ metrics: { ...metrics(), costEur: 0.01, noCacheEur: 0.01, costUsd: 99 } }),
    ])
    expect(totals.costEur).toBeCloseTo(0.01, 9)
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
          variables: {},
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
      costEur: 0,
      costKnownCalls: 0,
    })
  })

  it('defaults a missing cache-write figure on the legacy shape to zero', () => {
    const totals = foldTokenTotals([
      ev({
        llmCall: {
          functionName: 'Router',
          variables: {},
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
          variables: {},
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
