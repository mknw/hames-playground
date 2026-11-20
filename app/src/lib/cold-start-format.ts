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

/** Each box's name as the notice says it (#1057): 'large' is the 27B, 'small'
 *  the 4B summarizer — the ids `cold-start.server.ts` and `wake.server.ts`
 *  already use, so the notice cannot name a third box. */
export const COLD_START_BOX_LABEL: Record<'large' | 'small', string> = {
  large: 'the 27B',
  small: 'the 4B',
}

/** Which boxes the notice waits on, as a phrase appended to the headline
 *  (#1057): nothing when the payload names no boxes (a notice from before the
 *  field existed), one name, or both joined — the order is the boxes' own,
 *  large first, so two notices about one wait never read as two orders. */
export function coldStartBoxSuffix(boxes: readonly ('large' | 'small')[] | undefined): string {
  if (!boxes || boxes.length === 0) return ''
  const ordered: ('large' | 'small')[] = []
  for (const box of ['large', 'small'] as const) if (boxes.includes(box)) ordered.push(box)
  const names = ordered.map((box) => COLD_START_BOX_LABEL[box])
  return ` — ${names.join(' and ')}`
}

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
 * The longest FULL BOOT measured on the self-hosted host: 938s, the 27B's first
 * cold start after a deploy, which built two snapshots (`deploy/modal/README.md`,
 * "The 27B"). A cold start that has to build a GPU snapshot rather than restore
 * one takes 505–938s for the 27B and 305–552s for the small box. That happens
 * after every redeploy, on each GPU or worker type the box has not run on yet, and
 * when the platform recaptures its snapshots. The countdown estimates a restore,
 * so this figure is stated only once the countdown has run out.
 */
export const COLD_START_FULL_BOOT_MS = 938_000

/**
 * The measured FULL-BOOT range per box (`deploy/modal/README.md`): 505–938s for
 * the 27B and 305–552s for the small box. A start that builds a snapshot is not
 * a failure, and the control-plane lines state this range once a container has
 * been booting longer than a snapshot restore takes (#1057: "booting, full
 * boot, 6 min of ~8–15").
 */
export const COLD_START_FULL_BOOT_RANGE_MS: Record<'large' | 'small', readonly [number, number]> = {
  large: [505_000, 938_000],
  small: [305_000, 552_000],
}

/** `'8–16 min'`: the box's full-boot range, in whole minutes. */
export function formatFullBootRange(box: 'large' | 'small'): string {
  const [lo, hi] = COLD_START_FULL_BOOT_RANGE_MS[box]
  return `${Math.round(lo / 60_000)}–${Math.round(hi / 60_000)} min`
}

/** What a box that Modal HAS created a container for is doing, in words
 *  (#1057): `elapsedMs` is measured from Modal's own container start (`null`
 *  while Modal lists the container as `Pending`). Inside the snapshot-restore
 *  estimate it reads as a restore; past it, as the full boot it can only be,
 *  with its range — so a long boot is not mistaken for a failure, and a failure
 *  (no container at all) is a different sentence, `boxNotStartingText`. */
export function boxBootText(
  box: 'large' | 'small',
  elapsedMs: number | null,
  restoreEstimateMs: number,
): string {
  const restore = formatColdStartEstimate(restoreEstimateMs) ?? 'under a minute'
  if (elapsedMs === null) {
    return `queued by Modal — a snapshot restore takes ~${restore}, a full boot ~${formatFullBootRange(box)}`
  }
  const so = formatColdStartEstimate(Math.max(0, elapsedMs)) ?? 'under a minute'
  return elapsedMs <= restoreEstimateMs
    ? `booting, likely a snapshot restore — ${so} of ~${restore} (a full boot takes ~${formatFullBootRange(box)})`
    : `booting, a full boot — ${so} of ~${formatFullBootRange(box)} (a snapshot restore takes ~${restore})`
}

/** A boot that was asked for and has no container yet. */
export function boxWaitingText(waitedMs: number): string {
  const so = formatColdStartEstimate(Math.max(0, waitedMs)) ?? 'under a minute'
  return `waiting for Modal to start a container — ${so} so far`
}

/** A boot Modal is not creating a container for. */
export function boxNotStartingText(waitedMs: number): string {
  const so = formatColdStartEstimate(Math.max(0, waitedMs)) ?? 'under a minute'
  return `NOT STARTING — Modal has created no container after ${so}`
}

/** One box's live phase as the chat notice shows it, from Modal's control
 *  plane (`WarmingBoxState`, `preview-header.server.ts`). `elapsedMs` already
 *  includes this browser's time since it received the reading. */
export interface BoxWaitView {
  box: 'large' | 'small'
  phase: 'waiting' | 'booting' | 'not-starting'
  elapsedMs: number | null
  restoreEstimateMs: number
}

/** The notice's line for one box: `the 27B: booting, a full boot — 6 min of
 *  ~8–16 min …`. A box Modal is not starting says what the user can do. */
export function boxWaitLine(view: BoxWaitView): string {
  const name = COLD_START_BOX_LABEL[view.box]
  switch (view.phase) {
    case 'waiting':
      return `${name}: ${boxWaitingText(view.elapsedMs ?? 0)}`
    case 'booting':
      return `${name}: ${boxBootText(view.box, view.elapsedMs, view.restoreEstimateMs)}`
    case 'not-starting':
      return `${name}: ${boxNotStartingText(view.elapsedMs ?? 0)}. You can stop this turn, wait, or send it again.`
  }
}

/** What a screen reader hears when a box's PHASE changes — deliberately no
 *  counting figure, for the reason `coldStartAnnouncement` states. */
export function boxWaitAnnouncement(view: BoxWaitView): string {
  const name = COLD_START_BOX_LABEL[view.box]
  switch (view.phase) {
    case 'waiting':
      return `${name} is waiting for Modal to start a container.`
    case 'booting':
      return `${name} is booting.`
    case 'not-starting':
      return `${name} is not starting: Modal has created no container. You can stop this turn, wait, or send it again.`
  }
}

/**
 * The notice's second line: what is happening and how much longer.
 *
 * Past the estimate it stops counting and says what the longer wait can be,
 * rather than sitting at `~0 sec` or going negative. That case is expected
 * rather than exceptional: the estimate is a snapshot RESTORE, and a box that
 * has to build a new snapshot takes minutes longer. A region short of GPUs can
 * add a queue on top of that (25 min once, 2026-10-27), and a burst of chats
 * queues on ONE replica. A notice that silently expired would leave a spinner
 * claiming nothing.
 */
export function coldStartDetail(estimateMs: number, elapsedMs: number): string {
  const remaining = formatColdStartEstimate(estimateMs - elapsedMs)
  if (remaining) return `warming up… (estimated time to first token: ~${remaining})`
  const typical = formatColdStartEstimate(estimateMs)
  const fullBoot = formatColdStartEstimate(COLD_START_FULL_BOOT_MS)
  return typical
    ? `warming up… (longer than the usual ~${typical}: a start that builds a new GPU snapshot ` +
        `has taken up to ~${fullBoot}, more if no GPU is free)`
    : 'warming up…'
}

/**
 * The one phrase a screen reader hears, announced when the wait STARTS.
 *
 * Deliberately does not include the counting-down figure: an `aria-live` region
 * that changed every second would interrupt a listener once a second for two
 * minutes. Same rule as the header strip's warm indicator, where the ticking
 * countdown is `aria-hidden` and only the state word is announced.
 */
export function coldStartAnnouncement(
  estimateMs: number,
  boxes?: readonly ('large' | 'small')[],
): string {
  const eta = formatColdStartEstimate(estimateMs)
  // #1057: the screen reader hears which models it waits on — the same names
  // the headline shows, never a second derivation of them.
  const opening = `Waiting for the self-hosted model${
    boxes && boxes.length > 0
      ? ` (${boxes.map((box) => COLD_START_BOX_LABEL[box]).join(' and ')})`
      : ''
  } to start.`
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
    'This server has not measured a cold start yet, so this is the slowest GPU snapshot ' +
    'restore measured on the host, not a local measurement. The endpoint scales to zero, so ' +
    'the first call after an idle period restores a snapshot; a start that has to build a new ' +
    'one takes several minutes longer.'
  )
}
