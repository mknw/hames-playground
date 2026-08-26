/**
 * Cold-start notice — Server Only
 *
 * The self-hosted deployment scales to zero, so the first call after an idle
 * period pays a container start plus a 27B weight load: **146 seconds**,
 * measured against the live deployment on 2026-08-26 (PR #273). For that whole
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
 * sec" for a 146-second wait, with `basis: 'measured'` behind it.
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
 * 146_000 ms is the single reading taken against the live deployment on
 * 2026-08-26 and written up in `baml_src/verda-client.baml` and CLAUDE.md: one
 * completion into a sleeping box took 146s. It is deliberately ONE named
 * constant with its provenance attached rather than a rounded "about two
 * minutes" spelled into a label — a number the UI states as an expectation has
 * to be traceable to something that happened.
 */
export const COLD_START_FALLBACK_MS = 146_000

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
 * A quarter of {@link COLD_START_FALLBACK_MS} — 36.5s. The recording gate in
 * {@link noteVerdaCallStarting} can only prove that THIS process was quiet for
 * longer than the scale-down it was configured with (see the module docstring),
 * and two ordinary situations make that false: a `VERDA_SCALEDOWN_SECONDS`
 * lower than the deployment's own, and a second app instance. Both let a warm
 * ~4s call through the gate, and five of those in an eight-sample window pull
 * the median to 4s while still reporting `basis: 'measured'`.
 *
 * This is the backstop that cannot be misconfigured. Nothing anywhere near this
 * fast starts a container and loads 27B of weights — the one measured cold start
 * is 146s and the load test's WARM p95 at 8-way concurrency is 9.9s — so a
 * reading below the floor is a warm call the gate misread, and dropping it
 * cannot cost a real cold start. Deliberately generous rather than tight: the
 * cost of dropping a genuine 30s cold start is one lost sample, and the cost of
 * keeping a warm one is a confidently wrong promise to every future user.
 */
export const COLD_START_PLAUSIBILITY_FLOOR_MS = COLD_START_FALLBACK_MS / 4

/** Warm states that count as PROOF the box is up. Everything else — `starting`,
 *  `cold`, `unknown` — shows the notice. */
const PROVEN_WARM = new Set(['warm', 'running'])

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
  if (PROVEN_WARM.has(verdaWarmth(now).state)) return

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
 * `durationMs` is BAML's own `FunctionLog.timing` for the call — the same
 * number the latency window uses — so the cold start is measured by the thing
 * that waited for it rather than by a stopwatch around the adapter. Absent
 * means BAML measured nothing, which is not a zero.
 */
export function settleColdStart(durationMs: number | undefined): void {
  const watch = watchStore.getStore()
  if (!watch || !watch.fired || watch.settled) return
  watch.settled = true
  if (!watch.recordable || durationMs === undefined) return
  noteColdStartMeasured(durationMs)
}
