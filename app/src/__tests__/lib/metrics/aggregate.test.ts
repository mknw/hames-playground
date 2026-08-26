/**
 * Metrics dashboard aggregation (#132).
 *
 * The dashboard is a fold over `event.metrics`, so the fold is where its
 * numbers can be wrong. These tests pin the contract: only metered events feed
 * the sums, LLM steps predating `event.metrics` are counted as unmetered
 * rather than silently dropped or re-derived from `llmCall.usage`, cost only
 * accumulates over calls that carried pricing, and the derived ratios (cache
 * hit-rate, savings) stay defined on empty input.
 */
import { describe, it, expect } from 'vitest'
import type { ContextEvent, EventMetrics } from '../../../lib/harness-patterns/types'
import {
  getEventMetrics,
  isLlmBearing,
  foldEvents,
  aggregateByPattern,
  aggregateByConversation,
  buildDashboard,
  summarize,
  emptyTotals,
  type ConversationEvents,
} from '../../../lib/metrics/aggregate'
import { DEFAULT_USD_EUR_RATE } from '../../../lib/settings'

// ============================================================================
// Fixtures
// ============================================================================

function metrics(over: Partial<EventMetrics> = {}): EventMetrics {
  return {
    inputUncachedTokens: 1000,
    inputCacheReadTokens: 3000,
    inputCacheWriteTokens: 1000,
    outputTokens: 500,
    attempts: 1,
    costEur: 0.01,
    noCacheEur: 0.02,
    rates: { inPerMTok: 2, outPerMTok: 10 },
    ...over,
  }
}

/** A metered LLM step. */
function metered(patternId: string, over: Partial<EventMetrics> = {}): ContextEvent {
  return {
    type: 'controller_action',
    ts: 1,
    patternId,
    data: {},
    llmCall: { functionName: 'LoopController', variables: {} },
    metrics: metrics(over),
  } as ContextEvent
}

/** A pre-#122 LLM step: `llmCall` but no `metrics`. */
function unmetered(patternId: string): ContextEvent {
  return {
    type: 'controller_action',
    ts: 2,
    patternId,
    data: {},
    llmCall: {
      functionName: 'LoopController',
      variables: {},
      usage: {
        inputTokens: 9999,
        outputTokens: 9999,
        cachedInputTokens: 9999,
        totalTokens: 29_997,
      },
    },
  } as ContextEvent
}

/** A non-LLM event (tool call, user message, …). */
function plain(patternId: string): ContextEvent {
  return { type: 'tool_result', ts: 3, patternId, data: { success: true } } as ContextEvent
}

// ============================================================================
// Selector
// ============================================================================

describe('getEventMetrics', () => {
  it('reads accounting off event.metrics', () => {
    expect(getEventMetrics(metered('p'))?.outputTokens).toBe(500)
  })

  it('does not fall back to llmCall.usage', () => {
    // Deliberate: usage has no cache-write bucket and no cost, so folding it
    // in would understate spend while looking complete.
    expect(getEventMetrics(unmetered('p'))).toBeUndefined()
  })

  it('classifies LLM-bearing events with or without metrics', () => {
    expect(isLlmBearing(metered('p'))).toBe(true)
    expect(isLlmBearing(unmetered('p'))).toBe(true)
    expect(isLlmBearing(plain('p'))).toBe(false)
  })
})

// ============================================================================
// foldEvents
// ============================================================================

describe('foldEvents', () => {
  it('sums token buckets and cost across metered events', () => {
    const s = foldEvents([metered('a'), metered('b')])

    expect(s.meteredCalls).toBe(2)
    expect(s.attempts).toBe(2)
    expect(s.inputUncachedTokens).toBe(2000)
    expect(s.inputCacheReadTokens).toBe(6000)
    expect(s.inputCacheWriteTokens).toBe(2000)
    expect(s.outputTokens).toBe(1000)
    expect(s.inputTotalTokens).toBe(10_000)
    expect(s.totalTokens).toBe(11_000)
    expect(s.costEur).toBeCloseTo(0.02, 10)
    expect(s.noCacheEur).toBeCloseTo(0.04, 10)
    expect(s.pricedCalls).toBe(2)
  })

  it('derives cache hit-rate and savings', () => {
    const s = foldEvents([metered('a')])
    expect(s.cacheHitRate).toBeCloseTo(3000 / 5000, 10)
    expect(s.savingsEur).toBeCloseTo(0.01, 10)
    expect(s.savingsPct).toBeCloseTo(0.5, 10)
  })

  it('counts metric-less LLM steps as unmetered without summing their usage', () => {
    const s = foldEvents([metered('a'), unmetered('a'), plain('a')])

    expect(s.meteredCalls).toBe(1)
    expect(s.unmeteredCalls).toBe(1)
    // The unmetered step's 9999-token usage must not leak into the totals.
    expect(s.inputUncachedTokens).toBe(1000)
    expect(s.outputTokens).toBe(500)
    expect(s.totalTokens).toBe(5500)
  })

  it('ignores events that never touched an LLM', () => {
    const s = foldEvents([plain('a'), plain('b')])
    expect(s.meteredCalls).toBe(0)
    expect(s.unmeteredCalls).toBe(0)
    expect(s.totalTokens).toBe(0)
  })

  it('counts tokens but not cost when a step had no pricing', () => {
    const s = foldEvents([metered('a', { costEur: undefined, noCacheEur: undefined })])

    expect(s.meteredCalls).toBe(1)
    expect(s.pricedCalls).toBe(0)
    expect(s.costEur).toBe(0)
    expect(s.inputTotalTokens).toBe(5000)
    expect(s.savingsPct).toBe(0)
  })

  it('treats a priced step with no uncached baseline as zero savings', () => {
    const s = foldEvents([metered('a', { costEur: 0.01, noCacheEur: undefined })])
    expect(s.noCacheEur).toBeCloseTo(0.01, 10)
    expect(s.savingsEur).toBe(0)
  })

  it('marks the total a floor when a step was billed by wall-clock', () => {
    // `timePricedCalls > 0` is what puts the `≥` in front of the dashboard's
    // figure: the self-hosted box is also paid for the idle window after the
    // last call and the cold start before the first, and neither is any call's
    // duration.
    const s = foldEvents([
      metered('a', { costEur: 0.01, noCacheEur: 0.01, basis: 'time' }),
      metered('b', { costEur: 0.02, noCacheEur: 0.05, basis: 'tokens' }),
    ])
    expect(s.timePricedCalls).toBe(1)
    expect(s.pricedCalls).toBe(2)
    expect(s.costEur).toBeCloseTo(0.03, 10)
    // A wall-clock step contributes no caching saving — it is its own baseline.
    expect(s.savingsEur).toBeCloseTo(0.03, 10)
  })

  it('leaves timePricedCalls at zero when everything was token-priced', () => {
    const s = foldEvents([metered('a', { basis: 'tokens' })])
    expect(s.timePricedCalls).toBe(0)
  })

  it('converts a pre-EUR (USD) stamp at the default rate rather than dropping it', () => {
    // Persisted events predating the currency fix carry `costUsd`. Reading them
    // as unpriced would empty the dashboard for every historical conversation.
    const s = foldEvents([
      metered('a', { costEur: undefined, noCacheEur: undefined, costUsd: 0.5, noCacheUsd: 1 }),
    ])
    expect(s.pricedCalls).toBe(1)
    expect(s.costEur).toBeCloseTo(0.5 * DEFAULT_USD_EUR_RATE, 10)
    expect(s.noCacheEur).toBeCloseTo(1 * DEFAULT_USD_EUR_RATE, 10)
    expect(s.timePricedCalls).toBe(0)
  })

  it('sums retries via attempts', () => {
    const s = foldEvents([metered('a', { attempts: 3 }), metered('a', { attempts: 1 })])
    expect(s.attempts).toBe(4)
    expect(s.meteredCalls).toBe(2)
  })

  it('has defined ratios on empty input', () => {
    const s = summarize(emptyTotals())
    expect(s).toMatchObject({ cacheHitRate: 0, savingsPct: 0, savingsEur: 0, totalTokens: 0 })
    expect(foldEvents([])).toEqual(s)
  })
})

// ============================================================================
// Per-pattern
// ============================================================================

describe('aggregateByPattern', () => {
  it('buckets by patternId and ranks by cost', () => {
    const rows = aggregateByPattern([
      metered('cheap', { costEur: 0.001 }),
      metered('pricey', { costEur: 0.5 }),
      metered('cheap', { costEur: 0.001 }),
    ])

    expect(rows.map((r) => r.patternId)).toEqual(['pricey', 'cheap'])
    expect(rows[0].summary.meteredCalls).toBe(1)
    expect(rows[1].summary.meteredCalls).toBe(2)
    expect(rows[1].summary.costEur).toBeCloseTo(0.002, 10)
  })

  it('keeps a pattern that only has unmetered steps', () => {
    const rows = aggregateByPattern([unmetered('legacy')])
    expect(rows).toHaveLength(1)
    expect(rows[0].summary.unmeteredCalls).toBe(1)
    expect(rows[0].summary.meteredCalls).toBe(0)
  })

  it('drops patterns with no LLM activity and buckets missing ids under unknown', () => {
    const orphan = { ...metered('x'), patternId: '' } as ContextEvent
    const rows = aggregateByPattern([plain('tools-only'), orphan])
    expect(rows.map((r) => r.patternId)).toEqual(['unknown'])
  })

  it('ranks by tokens when costs tie', () => {
    const rows = aggregateByPattern([
      metered('small', { costEur: undefined, noCacheEur: undefined, outputTokens: 10 }),
      metered('big', { costEur: undefined, noCacheEur: undefined, outputTokens: 10_000 }),
    ])
    expect(rows.map((r) => r.patternId)).toEqual(['big', 'small'])
  })
})

// ============================================================================
// Per-conversation + dashboard
// ============================================================================

function conversation(id: string, events: ContextEvent[]): ConversationEvents {
  return { id, title: `title-${id}`, agentId: 'search', updatedAt: 1_700_000_000_000, events }
}

describe('aggregateByConversation', () => {
  it('ranks conversations by cost and drops silent ones', () => {
    const rows = aggregateByConversation([
      conversation('quiet', [plain('a')]),
      conversation('cheap', [metered('a', { costEur: 0.01 })]),
      conversation('pricey', [metered('a', { costEur: 0.2 }), metered('b', { costEur: 0.3 })]),
    ])

    expect(rows.map((r) => r.id)).toEqual(['pricey', 'cheap'])
    expect(rows[0].summary.costEur).toBeCloseTo(0.5, 10)
    expect(rows[0].title).toBe('title-pricey')
  })

  it('keeps a conversation whose only activity is unmetered', () => {
    const rows = aggregateByConversation([conversation('legacy', [unmetered('a')])])
    expect(rows.map((r) => r.id)).toEqual(['legacy'])
  })
})

describe('buildDashboard', () => {
  it('folds every conversation into totals, patterns and a top-N list', () => {
    const d = buildDashboard(
      [
        conversation('a', [metered('router', { costEur: 0.3 }), plain('router')]),
        conversation('b', [metered('loop', { costEur: 0.2 }), unmetered('loop')]),
        conversation('c', [metered('loop', { costEur: 0.1 })]),
      ],
      { topConversations: 2 },
    )

    expect(d.conversationCount).toBe(3)
    expect(d.eventCount).toBe(5)
    expect(d.totals.meteredCalls).toBe(3)
    expect(d.totals.unmeteredCalls).toBe(1)
    expect(d.totals.costEur).toBeCloseTo(0.6, 10)
    expect(d.byPattern.map((p) => p.patternId)).toEqual(['loop', 'router'])
    expect(d.byConversation.map((c) => c.id)).toEqual(['a', 'b'])
    expect(d.conversationsOmitted).toBe(1)
  })

  it('reports nothing omitted when every conversation fits', () => {
    const d = buildDashboard([conversation('a', [metered('router')])], { topConversations: 10 })
    expect(d.conversationsOmitted).toBe(0)
    expect(d.byConversation).toHaveLength(1)
  })

  it('handles a user with no conversations at all', () => {
    const d = buildDashboard([])
    expect(d).toMatchObject({ conversationCount: 0, eventCount: 0, conversationsOmitted: 0 })
    expect(d.byPattern).toEqual([])
    expect(d.byConversation).toEqual([])
    expect(d.totals.costEur).toBe(0)
  })
})
