/**
 * Session token/cost accounting — the fold behind the panel's summary bar,
 * plus its two formatters. Split out of `ObservabilityPanel.tsx` (#226 B5).
 */

import type { ContextEvent } from '../harness-patterns'

/** Compact token count: 1234 → "1.2k", 25_320 → "25.3k". */
export const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/** Cost with enough precision to be meaningful at per-call scale. */
export const fmtUsd = (v: number): string => (v >= 0.1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`)

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
    costUsd: 0,
    noCacheUsd: 0,
    costKnownCalls: 0,
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
      if (m.costUsd !== undefined) {
        t.costUsd += m.costUsd
        t.noCacheUsd += m.noCacheUsd ?? m.costUsd
        t.costKnownCalls++
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
    savedPct: t.noCacheUsd > 0 ? (t.noCacheUsd - t.costUsd) / t.noCacheUsd : 0,
  }
}
