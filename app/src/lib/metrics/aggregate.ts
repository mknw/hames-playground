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
 * point. `stepCostEur` beside it is the same idea for the money: one currency,
 * one conversion rule, shared with the observability panel's own fold so the
 * two surfaces cannot disagree about the same conversation. `isTimePricedStep`
 * is the third: one rule for whether a figure is a floor, so the `≥` means the
 * same thing on every surface that renders one.
 */

import type { ContextEvent, EventMetrics } from '../harness-patterns/types'
import { DEFAULT_EUR_PER_USD } from '../settings'

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

/**
 * The EUR cost of one step — the second accessor every fold goes through, and
 * the one place that knows a stamp might predate the currency fix.
 *
 * `undefined` means the step was not priced at all: no client rate and no
 * measured wall-clock. That is rendered as "—", never as €0.
 *
 * Pre-EUR events carry `costUsd`, and that figure was always a token-priced
 * Anthropic estimate — the self-hosted box had no pricing entry back then, so
 * no wrong time-priced number can be in the store — which makes converting it
 * exactly as accurate as converting a new one. It converts at the DEFAULT rate,
 * not the operator's current one, because the rate in force when it was stamped
 * was never recorded; using the live value would silently re-price history
 * every time `EUR_PER_USD` moved.
 *
 * Shared with `observability/token-totals.ts`: the panel and the dashboard must
 * agree to the cent on the same conversation, and two copies of this rule would
 * be one copy away from disagreeing.
 */
export function stepCostEur(m: EventMetrics): { costEur: number; noCacheEur: number } | undefined {
  if (m.costEur !== undefined) {
    // No `noCacheEur` ⇒ treat the call as its own baseline, so it contributes
    // zero savings rather than a fabricated one. A time-priced call is always
    // its own baseline: caching cannot save wall-clock.
    return { costEur: m.costEur, noCacheEur: m.noCacheEur ?? m.costEur }
  }
  if (m.costUsd !== undefined) {
    return {
      costEur: m.costUsd * DEFAULT_EUR_PER_USD,
      noCacheEur: (m.noCacheUsd ?? m.costUsd) * DEFAULT_EUR_PER_USD,
    }
  }
  return undefined
}

/**
 * Whether a step's figure is a FLOOR — the third accessor every fold goes
 * through, and the reason the `≥` on the panel, the summary bar and the
 * dashboard cannot drift apart.
 *
 * True when ANY of the step's priced attempts was billed by wall-clock, not
 * when the last one was: a step holding a billed GPU hour plus one Anthropic
 * retry is a floor whichever attempt ran last, and reading `basis` alone
 * dropped the marker for exactly that step. Events stamped before
 * `timePricedAttempts` existed carry only `basis`, and are read that way.
 */
export function isTimePricedStep(m: EventMetrics): boolean {
  return m.timePricedAttempts !== undefined ? m.timePricedAttempts > 0 : m.basis === 'time'
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
  /** Estimated spend in EUR over the calls that could be priced */
  costEur: number
  /** Same calls priced with zero caching — the savings baseline */
  noCacheEur: number
  /** Metered calls that could be priced (cost covers only these) */
  pricedCalls: number
  /** Priced calls billed by wall-clock rather than by token. `> 0` ⇒ `costEur`
   *  is a FLOOR: the self-hosted box is also paid for the idle scale-down
   *  window after the last call and the cold start before the first, and
   *  neither is any call's measured duration. The UI renders a `≥`. */
  timePricedCalls: number
}

/** Totals plus the ratios the UI shows. */
export interface MetricSummary extends MetricTotals {
  inputTotalTokens: number
  totalTokens: number
  /** Share of input tokens served from cache (0 when there was no input) */
  cacheHitRate: number
  /** noCacheEur − costEur, i.e. what caching avoided */
  savingsEur: number
  /** savingsEur as a share of the uncached baseline */
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
    costEur: 0,
    noCacheEur: 0,
    pricedCalls: 0,
    timePricedCalls: 0,
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
  const cost = stepCostEur(m)
  if (cost) {
    totals.pricedCalls++
    totals.costEur += cost.costEur
    totals.noCacheEur += cost.noCacheEur
    if (isTimePricedStep(m)) totals.timePricedCalls++
  }
  return totals
}

/** Derive the ratios the UI shows from raw sums. */
export function summarize(totals: MetricTotals): MetricSummary {
  const inputTotalTokens =
    totals.inputUncachedTokens + totals.inputCacheReadTokens + totals.inputCacheWriteTokens
  const savingsEur = totals.noCacheEur - totals.costEur
  return {
    ...totals,
    inputTotalTokens,
    totalTokens: inputTotalTokens + totals.outputTokens,
    cacheHitRate: inputTotalTokens > 0 ? totals.inputCacheReadTokens / inputTotalTokens : 0,
    savingsEur,
    savingsPct: totals.noCacheEur > 0 ? savingsEur / totals.noCacheEur : 0,
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
  if (b.costEur !== a.costEur) return b.costEur - a.costEur
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
