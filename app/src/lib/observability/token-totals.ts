/**
 * Session token/cost accounting — the fold behind the panel's summary bar,
 * plus its two formatters. Split out of `ObservabilityPanel.tsx` (#226 B5).
 */

import type { ContextEvent } from '../harness-patterns'
import { stepCostEur } from '../metrics/aggregate'

/** Compact token count: 1234 → "1.2k", 25_320 → "25.3k". */
export const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/**
 * THE price formatter. One currency, one symbol, everywhere a price renders —
 * the panel, the per-call detail and the metrics dashboard all import this one.
 * EUR because that is the currency the bills arrive in; the conversion from the
 * vendors' USD list prices happens once, at pricing time (`settings.ts`).
 *
 * Precision follows scale: cents once a figure is worth reading in cents, four
 * places below that, because a single describe call really does cost €0.0003
 * and "€0.00" would read as free.
 */
export const fmtEur = (v: number): string => (v >= 0.1 ? `€${v.toFixed(2)}` : `€${v.toFixed(4)}`)

/** Fold `event.metrics` (first-class accounting, #122) into session totals.
 *  Events predating the metrics attribute fall back to `llmCall.usage` — no
 *  cache-write bucket there, and no cost (partial pricing would mislead). */
export const foldTokenTotals = (events: ContextEvent[]) => {
  const t = {
    llmCalls: 0,
    attempts: 0,
    inputUncached: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    costEur: 0,
    noCacheEur: 0,
    costKnownCalls: 0,
    /** Priced steps billed by wall-clock. `> 0` ⇒ the total is a FLOOR, because
     *  a time-priced box is also paid for the idle scale-down window after the
     *  last call and the cold start before the first, neither of which is any
     *  call's duration. The bar renders a `≥` when this is non-zero. */
    timePricedCalls: 0,
  }
  for (const e of events) {
    const m = e.metrics
    if (m) {
      t.llmCalls++
      t.attempts += m.attempts
      t.inputUncached += m.inputUncachedTokens
      t.cacheRead += m.inputCacheReadTokens
      t.cacheWrite += m.inputCacheWriteTokens
      t.output += m.outputTokens
      const cost = stepCostEur(m)
      if (cost) {
        t.costEur += cost.costEur
        t.noCacheEur += cost.noCacheEur
        t.costKnownCalls++
        if (m.basis === 'time') t.timePricedCalls++
      }
    } else if (e.llmCall?.usage) {
      const u = e.llmCall.usage
      t.llmCalls++
      t.attempts++
      t.inputUncached += u.inputTokens
      t.cacheRead += u.cachedInputTokens
      t.cacheWrite += u.cacheCreationInputTokens ?? 0
      t.output += u.outputTokens
    }
  }
  const inputTotal = t.inputUncached + t.cacheRead + t.cacheWrite
  return {
    ...t,
    inputTotal,
    cachedPct: inputTotal > 0 ? t.cacheRead / inputTotal : 0,
    savedPct: t.noCacheEur > 0 ? (t.noCacheEur - t.costEur) / t.noCacheEur : 0,
  }
}
