/**
 * Cold-start notice — Server Only
 *
 * The self-hosted deployment scales to zero, so the first call after an idle
 * period pays a container start plus a 27B weight load: **71.7s, 146s and
 * ~360s** on the original host, which had no snapshots (2026-08-26, #273/#279,
 * and 2026-08-27). On Modal the box restores a GPU memory snapshot instead
 * (12–157s through the URL), unless it has to build a new one, which is a full
 * boot (5–16 min; see {@link COLD_START_FALLBACK_MS}). For that whole
 * window the chat produces nothing — the SSE keep-alive proves the connection
 * is alive but is invisible to a human by construction
 * (`SSE_KEEPALIVE_MS`), which is why #273 left "no user-visible signal that a
 * cold start is in progress" open as owner decision D-c. This module is that
 * signal's server half.
 *
 * ## When the notice fires, and why not at turn entry
 *
 * Only the roles in `SELF_DEPLOYED_CLIENT_BY_ROLE` reach the box, and since 2026-08-26
 * that is every role including `router` — so on a self_deployed-tier turn the notice now
 * fires from the ROUTER call, the turn's first self_deployed-bound one, rather than from
 * the controller after routing answered on Anthropic. #274 predicted exactly
 * this and it cost no code: nothing here hardcodes a role, and the hook is on the
 * seam, not on a position in the chain. The moment worth telling the user about
 * is still "a call is about to be made and nothing says the box is up" — not "a
 * self_deployed-tier turn began", which is why {@link noteLargeCallStarting} is called
 * from `clientOverrideFor()` (`harness-baml/clients.server.ts`), the per-call
 * seam that builds a self_deployed-bound options bag, and fires at most once per turn.
 * The move made the notice EARLIER by one call, which is the right direction: on
 * this tier the router is itself a call that waits on the box.
 *
 * ## Two claims, deliberately not the same one
 *
 * **Whether to SHOW the notice** errs pessimistic, exactly like the header's
 * warm indicator: anything short of proof that the box is up (`warm` /
 * `running`) shows it. Being wrong costs a spinner that clears in four
 * seconds.
 *
 * **Whether to RECORD the wait as a cold-start measurement** does not get that
 * licence, because a wrong reading here poisons every future estimate — and in
 * the understating direction, which is the dishonest one: a four-second warm
 * call entering the history as a "cold start" makes the notice promise "~10
 * sec" for a multi-minute wait, with `basis: 'measured'` behind it.
 *
 * So recording is gated **twice**, because neither gate is sufficient alone.
 *
 * 1. **A coldness gate on the wait**, which is weaker than it reads and is
 *    stated here as what it actually proves: *this process has been quiet
 *    longer than the scale-down value it was **configured with*** — a call to
 *    the box finished (`largeLastCallCompletedAt() !== null`) and
 *    `LARGE_LLM_SCALEDOWN_SECONDS` has elapsed since. It is not proof the platform
 *    released the GPU. The app cannot read the deployment's own setting, so a
 *    `LARGE_LLM_SCALEDOWN_SECONDS` **lower** than the deployment's poisons the
 *    history downward: every idle gap between the two values looks cold here
 *    while the box is still held warm. The code default and `app/.env.example`
 *    now both say 300, matching the live deployment (owner-settled 2026-08-26),
 *    so that window is closed on the preview as shipped — but it reopens for any
 *    host whose box differs, which is why gate 2 below exists. The same
 *    shape arrives with no misconfiguration at all the moment a second instance
 *    exists: an instance that has itself seen a call finish and then gone quiet
 *    is indistinguishable from a cold box.
 * 2. **A plausibility floor on the reading** ({@link
 *    COLD_START_PLAUSIBILITY_FLOOR_MS}), which is what closes both of those. A
 *    duration too short to *be* a container start plus a 27B weight load is not
 *    a cold start whatever the gate above believed, and dropping it cannot cost
 *    a real one. It protects the history regardless of how
 *    `LARGE_LLM_SCALEDOWN_SECONDS` is set, which is the point: the value is an
 *    operator's to get right and the estimate's honesty must not depend on it.
 *
 * With neither gate satisfied the state is genuinely unknown — the box may well
 * have been warm and this process simply had not noticed (a restart, a second
 * instance) — and the notice still shows, pessimistically, measuring nothing.
 *
 * ## MULTI-INSTANCE CAVEAT
 *
 * The history is **process-local**, on a `globalThis` symbol, the same
 * compromise (and the same eventual Redis move) as `large-activity.server.ts`'s
 * clock and `metrics/call-latency.server.ts`'s window. A restart empties it and
 * the estimate falls back to {@link COLD_START_FALLBACK_MS} — which is a
 * measurement, not a guess, so falling back costs accuracy rather than honesty.
 *
 * ## What it holds
 *
 * Durations. No user id, no conversation id, no prompt, no content (SD-10).
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { AsyncLocalStorage } from 'node:async_hooks'
import { percentileMs } from '../metrics/call-latency.server'
import {
  largeLastCallCompletedAt,
  largeScaledownSeconds,
  largeWarmth,
} from './large-activity.server'

assertServerOnImport()

/**
 * The estimate used until this process has measured a cold start of its own.
 *
 * **157_000 ms**: the slowest GPU-snapshot RESTORE of the 27B measured on Modal,
 * through the public URL, first request to first answer. Six readings exist
 * (2026-10-17 and 2026-10-27, `deploy/modal/README.md` "The 27B"): **11.9s,
 * 31.3s, 31.3s, 36.2s, 62.2s and 156.8s**. On 2026-11-02 the restore itself took
 * ~36s inside the container.
 *
 * It was 360_000 from 2026-08-27, the largest of three readings on the original
 * host (71.7s, 146s, ~360s), which had no snapshots: every cold start there was a
 * full weight load. That figure described a box this deployment no longer runs,
 * and on Modal it overstated a typical wait about tenfold.
 *
 * Still the LARGEST reading and deliberately not the median (~34s), because the
 * owner settled the direction on 2026-08-27 and the errors are still not
 * symmetric: a pessimistic countdown costs a spinner that clears early, and an
 * optimistic one is a promise the box breaks.
 *
 * What it does NOT cover is the other mode. A cold start that has to BUILD a
 * snapshot is a full boot: after every redeploy, on each GPU type and worker type
 * the box has not run on yet (Modal keeps snapshots per worker type, and needs
 * 2–3 per GPU type), and when Modal recaptures them. Those took **505–938s** for
 * the 27B and **305–552s** for the small box. Folding them into this figure
 * would put the countdown back at ~16 min for every restore, so the notice
 * states that mode separately once the countdown runs out
 * (`COLD_START_FULL_BOOT_MS`, `lib/cold-start-format.ts`).
 *
 * It is ONE named constant with its provenance attached rather than a rounded
 * label, because a number the UI states as an expectation has to be traceable to
 * something that happened. And it is a FALLBACK: any process that has measured
 * cold starts of its own reports their median instead, with
 * `basis: 'measured'`.
 */
export const COLD_START_FALLBACK_MS = 157_000

/**
 * How many measured cold starts the estimate is taken over.
 *
 * Small on purpose. Cold starts are rare by construction (one per idle period),
 * so a window sized like the latency one would span days and stop describing
 * the deployment's current behaviour; eight is a few days of preview traffic
 * and still enough for a median to mean something.
 */
export const COLD_START_WINDOW = 8

/**
 * Shortest duration the history will accept as a cold start.
 *
 * 10s, the same floor the small box uses
 * ({@link SMALL_COLD_START_PLAUSIBILITY_FLOOR_MS}). The recording gate in
 * {@link noteLargeCallStarting} can only prove that THIS process was quiet for
 * longer than the scale-down it was configured with (see the module docstring),
 * and two ordinary situations make that false: a `LARGE_LLM_SCALEDOWN_SECONDS`
 * lower than the deployment's own, and a second app instance. Both let a warm
 * wake through the gate, and five of those in an eight-sample window would pull
 * the median down while still reporting `basis: 'measured'`.
 *
 * What the history records is the wake poll's total, so the thing the floor must
 * reject is a WARM wake ping: one 1-token completion, measured at 0.34s on a warm
 * Modal box. The heaviest warm figure on record, the 8-way load test's p95 on the
 * original host (9.9s, 2026-08-25, 2.75k-token prompts), is still below it.
 *
 * It was 36.5s until 2026-11-02, set when the fastest cold start ever seen was
 * 71.7s and a cold box held each request until it was up. On Modal a cold box
 * answers 503 at once and the poll retries every 5s, so a snapshot restore can be
 * fast, and the old floor discarded four of the six measured restores (11.9s,
 * 31.3s, 31.3s, 36.2s). The history then learned only the slow wakes while its
 * tooltip claimed the median of all of them. The floor must sit under the
 * fastest real cold start, and on this host that is 11.9s.
 *
 * It is its own literal, not derived from {@link COLD_START_FALLBACK_MS}: the
 * fallback is a claim about how long a cold start typically takes and errs long;
 * the floor is a claim about the fastest one that could be real.
 * `cold-start.test.ts` pins it between the warm figures and the fastest restore.
 */
export const COLD_START_PLAUSIBILITY_FLOOR_MS = 10_000

/** Warm states that count as PROOF the box is up. Everything else — `starting`,
 *  `cold`, `unknown` — shows the notice. */
const PROVEN_WARM = new Set(['warm', 'running'])

/**
 * Is the box PROVABLY up right now?
 *
 * The one predicate behind two decisions that must never disagree: whether to
 * show the notice ({@link noteLargeCallStarting}) and whether to send a wake
 * ping at all (`wake.server.ts`). Two copies of "warm or running" would be one
 * edit away from a turn that pings without telling anyone, or tells someone
 * without pinging.
 *
 * Note which way it errs, and that the direction is the same for both callers:
 * anything short of proof costs a wake ping and a spinner that clears in
 * seconds, where the opposite error costs a user a silent 146-second wait.
 */
export function largeProvenWarm(now: number = Date.now()): boolean {
  return PROVEN_WARM.has(largeWarmth(now).state)
}

const HISTORY_KEY = Symbol.for('hames-app.cold-start-history')
type HistoryGlobal = typeof globalThis & { [HISTORY_KEY]?: number[] }
const history: number[] = ((globalThis as HistoryGlobal)[HISTORY_KEY] ??= [])

export type WakeBox = 'large' | 'small'
/** The small box's restore estimate: the slowest snapshot restore measured through
 *  the URL — 31.4s, the largest of the 2026-10-15 L4 readings in
 *  `deploy/modal/README.md` — rounded UP, by the same rule as
 *  {@link COLD_START_FALLBACK_MS}: a countdown that clears before the slowest
 *  measured restore is the optimistic promise that rule exists to forbid. A full
 *  boot (305–552s) is not covered by it; the notice states that case once the
 *  countdown runs out. */
export const SMALL_COLD_START_FALLBACK_MS = 32_000
// Between sub-second warm health checks and the fastest measured cold start (21s).
export const SMALL_COLD_START_PLAUSIBILITY_FLOOR_MS = 10_000
/** The small box releases its GPU after 300s idle. */
export const DEFAULT_SMALL_LLM_SCALEDOWN_SECONDS = 300
const SMALL_KEY = Symbol.for('hames-app.small-cold-start')
interface SmallState {
  lastCompletedAt: number | null
  history: number[]
}
const small = ((globalThis as typeof globalThis & { [SMALL_KEY]?: SmallState })[SMALL_KEY] ??= {
  lastCompletedAt: null,
  history: [],
})

export function smallScaledownSeconds(): number {
  const value = Math.floor(
    Number(process.env.SMALL_LLM_SCALEDOWN_SECONDS ?? DEFAULT_SMALL_LLM_SCALEDOWN_SECONDS),
  )
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_SMALL_LLM_SCALEDOWN_SECONDS
}
export function noteSmallCallCompleted(at = Date.now()): void {
  small.lastCompletedAt = at
}
export function smallProvenWarm(now = Date.now()): boolean {
  return (
    small.lastCompletedAt !== null && now - small.lastCompletedAt < smallScaledownSeconds() * 1000
  )
}
export function resetSmallActivity(): void {
  small.lastCompletedAt = null
}
export function resetSmallColdStartHistory(): void {
  small.history.length = 0
}
export function smallColdStartEstimate(): ColdStartEstimate {
  return estimateFor('small')
}
function estimateFor(box: WakeBox): ColdStartEstimate {
  const values = box === 'large' ? history : small.history
  const measured = percentileMs(values, 0.5)
  return measured === null
    ? {
        estimateMs: box === 'large' ? COLD_START_FALLBACK_MS : SMALL_COLD_START_FALLBACK_MS,
        basis: 'default',
        samples: 0,
      }
    : { estimateMs: measured, basis: 'measured', samples: values.length }
}

/** The larger outstanding wait owns the countdown, including its actual basis. */
function pendingEstimate(now: number): ColdStartEstimate {
  const estimates = [
    ...(!largeProvenWarm(now) ? [estimateFor('large')] : []),
    ...(!smallProvenWarm(now) ? [estimateFor('small')] : []),
  ]
  return estimates.reduce((a, b) => (b.estimateMs > a.estimateMs ? b : a))
}

/** What the notice carries to the browser. */
export interface ColdStartEstimate {
  /** Expected total wait, in milliseconds. Always a positive number — the
   *  client counts it down against its own receipt time. */
  estimateMs: number
  /** `measured` when {@link estimateMs} is the median of this process's own
   *  observed cold starts, `default` when it is {@link COLD_START_FALLBACK_MS}.
   *  The tooltip says which, so a fallback is never presented as a reading. */
  basis: 'measured' | 'default'
  /** How many measurements the median is over; `0` on the fallback. */
  samples: number
}

/**
 * Record one observed cold start.
 *
 * Non-finite and non-positive readings are DROPPED rather than clamped, the
 * same rule `noteCallLatency` follows: they mean the wait was not measured, and
 * a 0 in the window is a cold start that never happened.
 *
 * So is anything below {@link COLD_START_PLAUSIBILITY_FLOOR_MS} — the floor
 * lives HERE, at the single funnel into the history, rather than beside the
 * caller's gate in {@link settleColdStart}: a second recording path added later
 * inherits it instead of having to remember it.
 */
export function noteColdStartMeasured(durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return
  if (durationMs < COLD_START_PLAUSIBILITY_FLOOR_MS) return
  history.push(durationMs)
  if (history.length > COLD_START_WINDOW) history.splice(0, history.length - COLD_START_WINDOW)
}

/**
 * The current estimate.
 *
 * The MEDIAN of the window, nearest-rank, so the returned figure is a duration
 * some cold start really took — `percentileMs` is shared with the header's
 * latency window rather than reimplemented, for the reason stated there: a
 * mean is wrecked by one outlier and an interpolated value is a number nothing
 * recorded.
 */
export function coldStartEstimate(): ColdStartEstimate {
  const measured = percentileMs(history, 0.5)
  if (measured === null) {
    return { estimateMs: COLD_START_FALLBACK_MS, basis: 'default', samples: 0 }
  }
  return { estimateMs: measured, basis: 'measured', samples: history.length }
}

/** Test-only reset. */
export function resetColdStartHistory(): void {
  history.length = 0
}

// ============================================================================
// The per-turn notice
// ============================================================================

/** Called with the estimate the moment a turn starts waiting on a cold box. */
export type ColdStartListener = (estimate: ColdStartEstimate) => void

interface TurnWatch {
  notify: ColdStartListener
  /** Set once any box announces, so one turn emits only one warming frame. */
  fired: boolean
  /** Per-box evidence and settlement, independent of the turn's single notice.
   *  `recordable` requires PROVEN coldness; a fired-but-unrecordable watch
   *  shows the notice and measures nothing. `settled` limits each box to one
   *  reading per turn, including joiners that settle without a duration. */
  boxes: Partial<Record<WakeBox, { recordable: boolean; settled: boolean }>>
}

const watchStore = new AsyncLocalStorage<TurnWatch>()

/**
 * Run `fn` with a cold-start watch armed, notifying `listener` if the turn ends
 * up waiting on a cold box.
 *
 * An AsyncLocalStorage scope for the same reason the run frame is one:
 * the decision belongs to the RUN, and the place that detects it
 * (`clientOverrideFor`, several layers down inside the harness) must not need a
 * parameter threaded to it. Opened by `turn.server.ts` only for a self_deployed-tier
 * turn whose caller supplied an `onWarming` hook — no hook, no scope, no cost.
 */
export function runWithColdStartWatch<T>(
  listener: ColdStartListener,
  fn: () => Promise<T>,
): Promise<T> {
  return watchStore.run({ notify: listener, fired: false, boxes: {} }, fn)
}

/**
 * A self_deployed-bound call is about to be made. Announces the wait if nothing says
 * the box is up, and arms the measurement when it can be taken honestly.
 *
 * A throwing listener never breaks a turn — the same rule the LLM-usage
 * observer states, and for the same reason: a status frame is not worth an
 * answer. The throw is logged rather than swallowed.
 */
export function noteLargeCallStarting(now: number = Date.now()): void {
  noteBoxCallStarting('large', now)
}

export function noteBoxCallStarting(box: WakeBox, now = Date.now()): void {
  const watch = watchStore.getStore()
  if (!watch || watch.boxes[box]) return
  if (box === 'large' ? largeProvenWarm(now) : smallProvenWarm(now)) return
  // Evidence of coldness, not merely absence of evidence of warmth: this
  // process saw this box answer, then its CONFIGURED scale-down window elapsed.
  // Unknown activity can justify a notice but never a measurement. The window
  // may differ from the deployment's, and another instance sees other traffic,
  // so this is necessary, not sufficient: each box's plausibility floor covers
  // that gap before the reading can enter its history.
  const last = box === 'large' ? largeLastCallCompletedAt() : small.lastCompletedAt
  const seconds = box === 'large' ? largeScaledownSeconds() : smallScaledownSeconds()
  watch.boxes[box] = { recordable: last !== null && now - last >= seconds * 1000, settled: false }
  if (watch.fired) return
  watch.fired = true
  try {
    watch.notify(pendingEstimate(now))
  } catch (err) {
    console.error('[cold-start] the warming listener threw; the turn is unaffected:', err)
  }
}

/**
 * A call to the box finished. When it is the one this turn announced a cold
 * start for, its duration becomes the next estimate's raw material.
 *
 * `durationMs` is the wake poll's TOTAL wait — first attempt's start to the
 * attempt that answered (`wake.server.ts`), which is what the user actually sat
 * through and therefore what the countdown has to predict. Absent means the
 * caller measured nothing, which is not a zero: a turn that ATTACHED to a poll
 * already in flight passes `undefined` rather than its own fragment of the wait.
 */
export function settleColdStart(durationMs: number | undefined): void {
  settleBoxColdStart('large', durationMs)
}

export function settleBoxColdStart(box: WakeBox, durationMs: number | undefined): void {
  const watched = watchStore.getStore()?.boxes[box]
  if (!watched || watched.settled) return
  watched.settled = true
  if (!watched.recordable || durationMs === undefined) return
  if (box === 'large') {
    noteColdStartMeasured(durationMs)
    return
  }
  if (!Number.isFinite(durationMs) || durationMs < SMALL_COLD_START_PLAUSIBILITY_FLOOR_MS) return
  small.history.push(durationMs)
  if (small.history.length > COLD_START_WINDOW)
    small.history.splice(0, small.history.length - COLD_START_WINDOW)
}
