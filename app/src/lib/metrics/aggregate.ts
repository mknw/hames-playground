/**
 * Metrics Aggregation — pure folds over `ContextEvent[]` (#132)
 *
 * Client-safe and dependency-free: every function here is a pure fold, so the
 * dashboard's numbers are unit-testable without a database, a harness run, or
 * a DOM. The server function in `dashboard.server.ts` loads events and calls
 * `buildDashboard`; the route only renders what it returns.
 *
 * Source of truth is `event.metrics` (#122 / PR #130) — the first-class,
 * step-level accounting stamped at `trackEvent` time. We deliberately do NOT
 * re-derive from `llmCall.usage`: that shape has no cache-write bucket and no
 * cost, so folding it in would silently understate spend. Events predating the
 * attribute are counted as **unmetered** and surfaced as such.
 *
 * `getEventMetrics` is the single accessor every fold goes through — if the
 * accounting ever moves off `event.metrics`, this one function is the swap
 * point.
 */

import type { ContextEvent, EventMetrics } from '../harness-patterns/types'

// ============================================================================
// Selector
// ============================================================================

/** The one place that knows where step-level accounting lives on an event. */
export function getEventMetrics(event: ContextEvent): EventMetrics | undefined {
  return event.metrics
}

/** True when the event came from an LLM call, metered or not. */
export function isLlmBearing(event: ContextEvent): boolean {
  return getEventMetrics(event) !== undefined || event.llmCall !== undefined
}

// ============================================================================
// Types
// ============================================================================

/** Straight sums — nothing derived. */
export interface MetricTotals {
  /** LLM steps carrying `metrics` (the ones the numbers below describe) */
  meteredCalls: number
  /** LLM steps with no `metrics` — pre-#122 events, excluded from every sum */
  unmeteredCalls: number
  /** Physical API calls; `attempts > meteredCalls` ⇒ retries/fallbacks */
  attempts: number
  inputUncachedTokens: number
  inputCacheReadTokens: number
  inputCacheWriteTokens: number
  outputTokens: number
  /** Estimated spend over the calls that had pricing */
  costUsd: number
  /** Same tokens priced with zero caching — the savings baseline */
  noCacheUsd: number
  /** Metered calls whose client had a pricing entry (cost covers only these) */
  pricedCalls: number
}

/** Totals plus the ratios the UI shows. */
export interface MetricSummary extends MetricTotals {
  inputTotalTokens: number
  totalTokens: number
  /** Share of input tokens served from cache (0 when there was no input) */
  cacheHitRate: number
  /** noCacheUsd − costUsd, i.e. what caching avoided */
  savingsUsd: number
  /** savingsUsd as a share of the uncached baseline */
  savingsPct: number
}

/** One row of the per-pattern table. */
export interface PatternAggregate {
  patternId: string
  summary: MetricSummary
}

/** Events of a single stored conversation, as the server hands them over. */
export interface ConversationEvents {
  id: string
  title: string | null
  agentId: string
  /** Epoch millis — the row's `updated_at` */
  updatedAt: number
  events: ContextEvent[]
}

/** One row of the per-conversation table. */
export interface ConversationAggregate {
  id: string
  title: string | null
  agentId: string
  updatedAt: number
  summary: MetricSummary
}

/** Everything the dashboard route renders. */
export interface DashboardData {
  totals: MetricSummary
  byPattern: PatternAggregate[]
  /** Top N by cost (then tokens) — see `buildDashboard` options */
  byConversation: ConversationAggregate[]
  /** Conversations scanned (including ones with no LLM activity at all) */
  conversationCount: number
  /** Conversations left out of `byConversation` by the top-N cut */
  conversationsOmitted: number
  /** Events scanned across all conversations */
  eventCount: number
}

// ============================================================================
// Folds
// ============================================================================

export function emptyTotals(): MetricTotals {
  return {
    meteredCalls: 0,
    unmeteredCalls: 0,
    attempts: 0,
    inputUncachedTokens: 0,
    inputCacheReadTokens: 0,
    inputCacheWriteTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    noCacheUsd: 0,
    pricedCalls: 0,
  }
}

/** Accumulate one event into `totals` (mutates — folds own their accumulator). */
export function accumulate(totals: MetricTotals, event: ContextEvent): MetricTotals {
  const m = getEventMetrics(event)
  if (!m) {
    // An LLM step with no accounting: countable, but nothing to sum.
    if (event.llmCall) totals.unmeteredCalls++
    return totals
  }
  totals.meteredCalls++
  // `attempts` predates nothing but can still be missing on a hand-rolled
  // event; a metered call is at least one physical call.
  totals.attempts += m.attempts || 1
  totals.inputUncachedTokens += m.inputUncachedTokens
  totals.inputCacheReadTokens += m.inputCacheReadTokens
  totals.inputCacheWriteTokens += m.inputCacheWriteTokens
  totals.outputTokens += m.outputTokens
  if (m.costUsd !== undefined) {
    totals.pricedCalls++
    totals.costUsd += m.costUsd
    // No `noCacheUsd` (older stamp) ⇒ treat the call as its own baseline, so
    // it contributes zero savings rather than a fabricated one.
    totals.noCacheUsd += m.noCacheUsd ?? m.costUsd
  }
  return totals
}

/** Derive the ratios the UI shows from raw sums. */
export function summarize(totals: MetricTotals): MetricSummary {
  const inputTotalTokens =
    totals.inputUncachedTokens + totals.inputCacheReadTokens + totals.inputCacheWriteTokens
  const savingsUsd = totals.noCacheUsd - totals.costUsd
  return {
    ...totals,
    inputTotalTokens,
    totalTokens: inputTotalTokens + totals.outputTokens,
    cacheHitRate: inputTotalTokens > 0 ? totals.inputCacheReadTokens / inputTotalTokens : 0,
    savingsUsd,
    savingsPct: totals.noCacheUsd > 0 ? savingsUsd / totals.noCacheUsd : 0,
  }
}

/** Fold a flat event stream into one summary. */
export function foldEvents(events: ContextEvent[]): MetricSummary {
  const totals = emptyTotals()
  for (const event of events) accumulate(totals, event)
  return summarize(totals)
}

/** Cost first, then tokens — a call with unknown pricing still ranks by size. */
function byCostThenTokens(a: MetricSummary, b: MetricSummary): number {
  if (b.costUsd !== a.costUsd) return b.costUsd - a.costUsd
  return b.totalTokens - a.totalTokens
}

/**
 * Per-pattern aggregate. Events with no `patternId` (defensive — the harness
 * always sets one) are bucketed under `unknown`. Patterns with no LLM activity
 * at all are dropped: a tool-only pattern would be an all-zero row.
 */
export function aggregateByPattern(events: ContextEvent[]): PatternAggregate[] {
  const buckets = new Map<string, MetricTotals>()
  for (const event of events) {
    if (!isLlmBearing(event)) continue
    const key = event.patternId || 'unknown'
    let totals = buckets.get(key)
    if (!totals) {
      totals = emptyTotals()
      buckets.set(key, totals)
    }
    accumulate(totals, event)
  }
  return [...buckets.entries()]
    .map(([patternId, totals]) => ({ patternId, summary: summarize(totals) }))
    .sort((a, b) => byCostThenTokens(a.summary, b.summary))
}

/** Per-conversation aggregate, ranked by cost. Conversations with no LLM
 *  activity are dropped — they'd be all-zero rows. */
export function aggregateByConversation(
  conversations: ConversationEvents[],
): ConversationAggregate[] {
  return conversations
    .map((c) => ({
      id: c.id,
      title: c.title,
      agentId: c.agentId,
      updatedAt: c.updatedAt,
      summary: foldEvents(c.events),
    }))
    .filter((c) => c.summary.meteredCalls > 0 || c.summary.unmeteredCalls > 0)
    .sort((a, b) => byCostThenTokens(a.summary, b.summary))
}

export interface BuildDashboardOptions {
  /** How many conversation rows to keep (default 10) */
  topConversations?: number
}

/** The whole dashboard, folded from every conversation the caller loaded. */
export function buildDashboard(
  conversations: ConversationEvents[],
  options: BuildDashboardOptions = {},
): DashboardData {
  const topN = options.topConversations ?? 10
  const allEvents = conversations.flatMap((c) => c.events)
  const ranked = aggregateByConversation(conversations)

  return {
    totals: foldEvents(allEvents),
    byPattern: aggregateByPattern(allEvents),
    byConversation: ranked.slice(0, topN),
    conversationCount: conversations.length,
    conversationsOmitted: Math.max(0, ranked.length - topN),
    eventCount: allEvents.length,
  }
}
