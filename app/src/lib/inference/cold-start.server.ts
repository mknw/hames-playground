/**
 * Cold-start notice — Server Only
 *
 * The self-hosted deployment scales to zero, so the first call after an idle
 * period pays a container start plus a 27B weight load: **71.7s, 146s and
 * ~360s** on the three occasions it has been measured against the live
 * deployment (2026-08-26, #273/#279, and 2026-08-27). For that whole
 * window the chat produces nothing — the SSE keep-alive proves the connection
 * is alive but is invisible to a human by construction
 * (`SSE_KEEPALIVE_MS`), which is why #273 left "no user-visible signal that a
 * cold start is in progress" open as owner decision D-c. This module is that
 * signal's server half.
 *
 * ## When the notice fires, and why not at turn entry
 *
 * Only the roles in `VERDA_CLIENT_BY_ROLE` reach the box, and since 2026-08-26
 * that is every role including `router` — so on a verda-tier turn the notice now
 * fires from the ROUTER call, the turn's first verda-bound one, rather than from
 * the controller after routing answered on Anthropic. #274 predicted exactly
 * this and it cost no code: nothing here hardcodes a role, and the hook is on the
 * seam, not on a position in the chain. The moment worth telling the user about
 * is still "a call is about to be made and nothing says the box is up" — not "a
 * verda-tier turn began", which is why {@link noteVerdaCallStarting} is called
 * from `clientOverrideFor()` (`harness-patterns/clients.server.ts`), the per-call
 * seam that builds a verda-bound options bag, and fires at most once per turn.
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
 *    the box finished (`verdaLastCallCompletedAt() !== null`) and
 *    `VERDA_SCALEDOWN_SECONDS` has elapsed since. It is not proof the platform
 *    released the GPU. The app cannot read the deployment's own setting, so a
 *    `VERDA_SCALEDOWN_SECONDS` **lower** than the deployment's poisons the
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
 *    `VERDA_SCALEDOWN_SECONDS` is set, which is the point: the value is an
 *    operator's to get right and the estimate's honesty must not depend on it.
 *
 * With neither gate satisfied the state is genuinely unknown — the box may well
 * have been warm and this process simply had not noticed (a restart, a second
 * instance) — and the notice still shows, pessimistically, measuring nothing.
 *
 * ## MULTI-INSTANCE CAVEAT
 *
 * The history is **process-local**, on a `globalThis` symbol, the same
 * compromise (and the same eventual Redis move) as `verda-activity.server.ts`'s
 * clock and `metrics/call-latency.server.ts`'s window. A restart empties it and
 * the estimate falls back to {@link COLD_START_FALLBACK_MS} — which is a
 * measurement, not a guess, so falling back costs accuracy rather than honesty.
 *
 * ## What it holds
 *
 * Durations. No user id, no conversation id, no prompt, no content (SD-10).
 */
import { assertServerOnImport } from '../harness-patterns/assert.server'
import { AsyncLocalStorage } from 'node:async_hooks'
import { percentileMs } from '../metrics/call-latency.server'
import {
  verdaLastCallCompletedAt,
  verdaScaledownSeconds,
  verdaWarmth,
} from './verda-activity.server'

assertServerOnImport()

/**
 * The estimate used until this process has measured a cold start of its own.
 *
 * **360_000 ms**, raised from 146_000 on 2026-08-27. Three readings exist
 * against the live deployment, all of them real and all of them of the same
 * box: **71.7s** and **146s** (2026-08-26, #273/#279) and **~360s**
 * (2026-08-27, the reading that also overran the wake's old 300s bound).
 *
 * This is the LARGEST of the three and deliberately not their median, because
 * the two errors are not symmetric and the owner settled the direction: a
 * pessimistic countdown costs a user a spinner that clears early, and an
 * optimistic one is a promise the box breaks — which is the exact failure the
 * notice was built to end (#273's D-c was "a user watching a still screen has no
 * way to tell a warming GPU from a hung app"). A "~2 min" that runs on for
 * another four minutes tells them nothing they can trust twice.
 *
 * It is deliberately ONE named constant with its provenance attached rather than
 * a rounded "about six minutes" spelled into a label — a number the UI states as
 * an expectation has to be traceable to something that happened. And it is a
 * FALLBACK: any process that has measured cold starts of its own reports their
 * median instead, with `basis: 'measured'`, so a deployment faster than this one
 * stops being described by it after the first wait.
 */
export const COLD_START_FALLBACK_MS = 360_000

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
 * 36.5s. The recording gate in {@link noteVerdaCallStarting} can only prove that
 * THIS process was quiet for longer than the scale-down it was configured with
 * (see the module docstring), and two ordinary situations make that false: a
 * `VERDA_SCALEDOWN_SECONDS` lower than the deployment's own, and a second app
 * instance. Both let a warm ~4s call through the gate, and five of those in an
 * eight-sample window pull the median to 4s while still reporting
 * `basis: 'measured'`.
 *
 * This is the backstop that cannot be misconfigured. Nothing anywhere near this
 * fast starts a container and loads 27B of weights — the FASTEST cold start ever
 * measured on this deployment is 71.7s and the load test's WARM p95 at 8-way
 * concurrency is 9.9s — so a reading below the floor is a warm call the gate
 * misread, and dropping it cannot cost a real cold start. Deliberately generous
 * rather than tight: the cost of dropping a genuine 30s cold start is one lost
 * sample, and the cost of keeping a warm one is a confidently wrong promise to
 * every future user.
 *
 * **ITS OWN LITERAL SINCE 2026-08-27, where it used to be a quarter of
 * {@link COLD_START_FALLBACK_MS}.** The derivation was arithmetic convenience,
 * not a relationship: the two constants answer different questions and move on
 * different evidence. The fallback is a claim about how long a cold start
 * TYPICALLY takes, and it errs LONG on purpose; the floor is a claim about the
 * fastest one that could possibly be real, and it must sit under the fastest one
 * ever seen. Keeping them tied broke the moment the fallback rose to 360s — a
 * derived floor would have become 90s and rejected the genuine 71.7s reading,
 * i.e. erring long on the estimate would have silently started discarding
 * measurements. So the floor stays where it was, and `cold-start.test.ts` pins it
 * inside the band the two live numbers define: comfortably above the 9.9s warm
 * p95, comfortably below the 71.7s cold start.
 *
 * The poll gives it a second, mechanical reading it did not have before. With a
 * 30s per-attempt timeout and a ~5s gap (`wake.server.ts`), a wake that needed
 * even ONE retry has taken at least 35s — so a reading under this floor is
 * necessarily a wake whose FIRST attempt answered, which is a box that was
 * already up.
 */
export const COLD_START_PLAUSIBILITY_FLOOR_MS = 36_500

/** Warm states that count as PROOF the box is up. Everything else — `starting`,
 *  `cold`, `unknown` — shows the notice. */
const PROVEN_WARM = new Set(['warm', 'running'])

/**
 * Is the box PROVABLY up right now?
 *
 * The one predicate behind two decisions that must never disagree: whether to
 * show the notice ({@link noteVerdaCallStarting}) and whether to send a wake
 * ping at all (`wake.server.ts`). Two copies of "warm or running" would be one
 * edit away from a turn that pings without telling anyone, or tells someone
 * without pinging.
 *
 * Note which way it errs, and that the direction is the same for both callers:
 * anything short of proof costs a wake ping and a spinner that clears in
 * seconds, where the opposite error costs a user a silent 146-second wait.
 */
export function verdaProvenWarm(now: number = Date.now()): boolean {
  return PROVEN_WARM.has(verdaWarmth(now).state)
}

const HISTORY_KEY = Symbol.for('kg-agent.cold-start-history')
type HistoryGlobal = typeof globalThis & { [HISTORY_KEY]?: number[] }
const history: number[] = ((globalThis as HistoryGlobal)[HISTORY_KEY] ??= [])

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
  /** Set once {@link noteVerdaCallStarting} has fired, so one turn cannot
   *  announce two cold starts (the second verda-bound call of a turn is on a
   *  box the first one woke). */
  fired: boolean
  /** True only when the box was PROVABLY cold — see the module docstring. A
   *  fired-but-unrecordable watch shows the notice and measures nothing. */
  recordable: boolean
  /** Set once the wait has been measured, so a turn contributes at most one
   *  reading to the history. */
  settled: boolean
}

const watchStore = new AsyncLocalStorage<TurnWatch>()

/**
 * Run `fn` with a cold-start watch armed, notifying `listener` if the turn ends
 * up waiting on a cold box.
 *
 * An AsyncLocalStorage scope for the same reason `runWithInferenceTier` is one:
 * the decision belongs to the RUN, and the place that detects it
 * (`clientOverrideFor`, several layers down inside the harness) must not need a
 * parameter threaded to it. Opened by `turn.server.ts` only for a verda-tier
 * turn whose caller supplied an `onWarming` hook — no hook, no scope, no cost.
 */
export function runWithColdStartWatch<T>(
  listener: ColdStartListener,
  fn: () => Promise<T>,
): Promise<T> {
  return watchStore.run({ notify: listener, fired: false, recordable: false, settled: false }, fn)
}

/**
 * A verda-bound call is about to be made. Announces the wait if nothing says
 * the box is up, and arms the measurement when it can be taken honestly.
 *
 * A throwing listener never breaks a turn — the same rule the LLM-usage
 * observer states, and for the same reason: a status frame is not worth an
 * answer. The throw is logged rather than swallowed.
 */
export function noteVerdaCallStarting(now: number = Date.now()): void {
  const watch = watchStore.getStore()
  if (!watch || watch.fired) return
  if (verdaProvenWarm(now)) return

  const last = verdaLastCallCompletedAt()
  watch.fired = true
  // Evidence of coldness, not merely absence of evidence of warmth: this
  // process watched a call to the box finish, and the CONFIGURED scale-down
  // window has elapsed since. `verdaWarmth` cannot answer this — its `starting`
  // state collapses "went cold" and "never seen" into one word, and only the
  // first may enter the history. Read this for exactly what it says: the
  // configured window is not the deployment's, and a second instance sees only
  // its own traffic, so this is a necessary condition and not a sufficient one.
  // `noteColdStartMeasured`'s plausibility floor is what covers the gap.
  watch.recordable = last !== null && now - last >= verdaScaledownSeconds() * 1000

  try {
    watch.notify(coldStartEstimate())
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
  const watch = watchStore.getStore()
  if (!watch || !watch.fired || watch.settled) return
  watch.settled = true
  if (!watch.recordable || durationMs === undefined) return
  noteColdStartMeasured(durationMs)
}
