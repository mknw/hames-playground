/**
 * Cold-start notice formatting — pure, client-safe.
 *
 * The self-hosted deployment scales to zero, and a chat turn that wakes it
 * produces nothing for minutes. `LiveProgressBar` shows a spinner and a
 * counting-down estimate for that window; the arithmetic and the wording live
 * here so both are testable without a DOM, a timer or a server — the same split
 * `preview-header-format.ts` makes for the header strip, and for the same
 * reason.
 *
 * **Every figure is deliberately coarse.** The estimate is a rolling median of
 * whole cold starts, taken over a handful of samples on one process, against a
 * platform whose behaviour under queueing is measured exactly twice. A `2:26`
 * ticking down to the second would present that as a schedule. So the output is
 * `2 min` / `40 sec`, rounded, and the caller renders it with a `~`.
 *
 * Rounding runs in the OVERSTATING direction below a minute (`Math.ceil` to ten
 * seconds) — understating a wait is the dishonest direction for a number
 * somebody is deciding whether to keep waiting on. Minutes round to nearest,
 * because ceiling them would turn a measured 146 s into "~3 min".
 */

/** The notice's headline — the state, in the words the owner picked. Fixed,
 *  short, and independent of the estimate so it can never read as a promise. */
export const COLD_START_HEADLINE = 'starting GPU'

/**
 * A duration in milliseconds as a coarse phrase (`'2 min'`, `'40 sec'`), or
 * `null` when there is nothing worth stating — a non-finite reading, or under
 * a second, where any figure would be noise.
 *
 * The `~` is NOT included: the visible label prefixes it and the screen-reader
 * phrase says "about" instead, and a tilde read aloud is not a word.
 */
export function formatColdStartEstimate(ms: number): string | null {
  if (!Number.isFinite(ms) || ms < 1000) return null
  if (ms < 60_000) return `${Math.ceil(ms / 10_000) * 10} sec`
  return `${Math.round(ms / 60_000)} min`
}

/**
 * The notice's second line: what is happening and how much longer.
 *
 * Past the estimate it stops counting and says so, rather than sitting at
 * `~0 sec` or going negative. That case is expected rather than exceptional —
 * a burst of chats queues on ONE replica (measured 2026-08-26), so the second
 * sender's wait is the first sender's wait plus their own — and a notice that
 * silently expired would leave a spinner claiming nothing.
 */
export function coldStartDetail(estimateMs: number, elapsedMs: number): string {
  const remaining = formatColdStartEstimate(estimateMs - elapsedMs)
  if (remaining) return `warming up… (estimated time to first token: ~${remaining})`
  const typical = formatColdStartEstimate(estimateMs)
  return typical ? `warming up… (longer than the usual ~${typical})` : 'warming up…'
}

/**
 * The one phrase a screen reader hears, announced when the wait STARTS.
 *
 * Deliberately does not include the counting-down figure: an `aria-live` region
 * that changed every second would interrupt a listener once a second for two
 * minutes. Same rule as the header strip's warm indicator, where the ticking
 * countdown is `aria-hidden` and only the state word is announced.
 */
export function coldStartAnnouncement(estimateMs: number): string {
  const eta = formatColdStartEstimate(estimateMs)
  const opening = 'Waiting for the self-hosted model to start.'
  return eta ? `${opening} Estimated time to first token: about ${eta}.` : opening
}

/**
 * The tooltip: where the estimate came from. A fallback figure must never read
 * as a local measurement, which is the whole reason `basis` rides the wire.
 */
export function coldStartBasisHint(basis: 'measured' | 'default', samples: number): string {
  if (basis === 'measured') {
    return (
      `Median of the ${samples} most recent cold start${samples === 1 ? '' : 's'} this server ` +
      'measured. The endpoint scales to zero, so the first call after an idle period pays a ' +
      'container start and a model load.'
    )
  }
  return (
    'This server has not measured a cold start yet, so this is the published reading rather ' +
    'than a local measurement. The endpoint scales to zero, so the first call after an idle ' +
    'period pays a container start and a model load.'
  )
}
