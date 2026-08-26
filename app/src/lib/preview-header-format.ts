/**
 * Preview-header formatting — pure, client-safe.
 *
 * Split out of the component so the two things that are actually easy to get
 * wrong — the scale-down countdown and the compact number rendering — are
 * testable without a DOM, a timer or a server.
 *
 * Everything here is written for a strip that ticks once a second next to a
 * chat: **no output may change width as its value changes**, or the controls
 * beside it shuffle sideways every second. That is why the countdown is always
 * `m:ss` and why compact numbers keep one decimal place.
 */

/** Tier labels, in the words a preview user can act on. "Private" is the
 *  property they care about; the deployment name is the parenthetical. */
export const TIER_LABELS = {
  verda: 'Private (Verda)',
  anthropic: 'Anthropic',
} as const

/**
 * Seconds → `m:ss`, clamped at zero and capped so a very long scale-down delay
 * cannot widen the field: anything past 99:59 renders as `99:59`. A production
 * delay of an hour is 60:00, so the cap is only a guard against a nonsense env
 * value, not a real ceiling.
 */
export function formatCountdown(totalSeconds: number): string {
  const clamped = Math.max(0, Math.min(Math.floor(totalSeconds), 99 * 60 + 59))
  const minutes = Math.floor(clamped / 60)
  const seconds = clamped % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/**
 * Whole numbers below 1000, then `1.2k` / `3.4M` / `1.2B`.
 *
 * Rounds DOWN (`Math.floor` on the scaled value), so a counter never reads
 * higher than what was actually spent — the same direction the counters
 * themselves err in (`preview-counters.server.ts`: "at most what was spent").
 */
export function formatCompactNumber(value: number): string {
  if (!Number.isFinite(value) || value < 0) return '—'
  const n = Math.floor(value)
  if (n < 1000) return String(n)
  const units: [number, string][] = [
    [1_000_000_000, 'B'],
    [1_000_000, 'M'],
    [1_000, 'k'],
  ]
  for (const [scale, suffix] of units) {
    if (n >= scale) {
      const scaled = Math.floor((n / scale) * 10) / 10
      return `${scaled}${suffix}`
    }
  }
  return String(n)
}

/** A share (0–1) as a whole percentage, or `—` when there is nothing to divide
 *  by. `null` is not `0%`: "no calls yet" and "none of them were ours" are
 *  different claims and only one of them is a measurement. */
export function formatShare(share: number | null): string {
  if (share === null || !Number.isFinite(share)) return '—'
  return `${Math.round(Math.max(0, Math.min(1, share)) * 100)}%`
}

/**
 * A duration in milliseconds as the strip's latency value, or `—`.
 *
 * `null` — this process has recorded no call on the tier — is `—`, never `0`:
 * "not measured yet" and "instant" are different claims and only one of them
 * would be a measurement. Same rule as {@link formatShare}.
 *
 * Fixed-width by construction, because this field sits beside a control and
 * ticks with every poll: seconds to one decimal up to `99.9s`, then minutes to
 * one decimal (a cold start on the self-hosted box really is minutes), capped
 * at `99.9m`. Five characters at the widest, and `min-w` reserves that.
 *
 * Rounds to NEAREST rather than down, unlike the counters. A counter that
 * rounds down never claims more was spent than was; a latency that rounded down
 * would claim a call was faster than it was, and understating a wait is the
 * dishonest direction for this number.
 */
export function formatLatency(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—'
  const seconds = ms / 1000
  if (seconds < 99.95) return `${(Math.round(seconds * 10) / 10).toFixed(1)}s`
  const minutes = Math.min(99.9, Math.round((seconds / 60) * 10) / 10)
  return `${minutes.toFixed(1)}m`
}

/**
 * The countdown the header shows *between* polls.
 *
 * The client subtracts the elapsed wall-clock since the payload arrived rather
 * than counting its own ticks, so a throttled background tab resumes on the
 * right number instead of however many `setInterval` callbacks it managed to
 * run.
 *
 * `receivedAt` is the CLIENT's stamp for when the payload landed, not the
 * server's `generatedAt`. Both it and `now` come from the same `Date.now()`, so
 * the difference is elapsed time; mixing the two clocks would fold the skew
 * between them into the countdown, which shows up as a number that jumps at
 * every poll instead of ticking.
 *
 * Returns `null` when there is nothing to count down, and `0` once the window
 * has elapsed — the caller renders "cold" rather than a negative number.
 */
export function remainingSeconds(
  secondsUntilScaledown: number | null,
  receivedAt: number,
  now: number,
): number | null {
  if (secondsUntilScaledown === null) return null
  const elapsed = Math.max(0, (now - receivedAt) / 1000)
  return Math.max(0, Math.ceil(secondsUntilScaledown - elapsed))
}
