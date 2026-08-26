/**
 * Verda warm-state — Server Only
 *
 * The self-hosted deployment scales to zero: after `VERDA_SCALEDOWN_SECONDS`
 * with no traffic the GPU is released, and the next call pays a cold start
 * measured in minutes (see `baml_src/verda-client.baml`'s deliberately generous
 * `request_timeout_ms`). This module is the one place that knows whether the
 * box is currently up, so the header can say so before a user sends a message
 * into a multi-minute wait.
 *
 * ## What is measured, precisely
 *
 * `lastCompletedAt` is stamped from an `LlmUsageSample` whose **`clientName` is
 * `VerdaQwen`** — the client BAML actually selected, not the tier anyone
 * intended. A routing change that reads like it moved traffic but did not
 * cannot make this clock tick.
 *
 * `inFlight` is a different and weaker claim, and the wording in the UI has to
 * match it: it counts **turns running on the Verda tier**, incremented by
 * `beginVerdaTurn()` around the turn, not individual outstanding HTTP calls.
 * A turn holds the box awake for its whole duration, so "a Verda turn is
 * running" is exactly the thing worth showing; "one call is on the wire right
 * now" would need a hook at every adapter for no extra information. It is
 * incremented at turn ENTRY, though, so on its own it is a statement of intent,
 * not of warmth — which is why a running turn with no recent completed call
 * reads as `starting` rather than `running` (see {@link VerdaWarmth}).
 *
 * ## MULTI-INSTANCE CAVEAT (deliberate, and a preview-only compromise)
 *
 * Both numbers are **process-local**. Two app instances behind a load balancer
 * each see only their own traffic, so instance B can show "cold" while instance
 * A is actively keeping the box warm — the indicator would then be wrong in the
 * *pessimistic* direction (a user is told to expect a cold start that will not
 * happen), which is the harmless direction to be wrong in. The box itself has
 * no readiness endpoint this app is allowed to poll, and a shared Redis key
 * would be real infrastructure for a countdown. If the preview ever runs more
 * than one instance, this is the thing to move to Redis first.
 *
 * Restarting the app also resets the clock to "cold" while the box may still be
 * warm — same direction, same reasoning.
 */
import { assertServerOnImport } from '../harness-patterns/assert.server'

assertServerOnImport()

/** BAML client name that means "this call reached the self-hosted box". */
export const VERDA_CLIENT_NAME = 'VerdaQwen'

/** Default scale-down delay, in seconds. NOT a reading of the deployment: the
 *  live box was raised to 300 on 2026-08-26 and this default stayed at 180,
 *  because a committed default that tracks one deployment's current setting is
 *  a claim the repo cannot keep true — which is why it is an env var. Set
 *  `VERDA_SCALEDOWN_SECONDS` per host (`app/.env.example` says so at length).
 *  An unset var therefore reads the box as cold while it may still be warm:
 *  pessimistic for the header's countdown, and no longer able to poison the
 *  cold-start estimate — `inference/cold-start.server.ts` carries its own
 *  plausibility floor for exactly this gap. */
export const DEFAULT_VERDA_SCALEDOWN_SECONDS = 180

/**
 * `VERDA_SCALEDOWN_SECONDS`, or the default. Read per call so an operator can
 * change it without a rebuild, and clamped to a positive integer: a `0` or a
 * garbage value would render as "scaling down now, forever".
 */
export function verdaScaledownSeconds(): number {
  const raw = process.env.VERDA_SCALEDOWN_SECONDS
  if (raw === undefined) return DEFAULT_VERDA_SCALEDOWN_SECONDS
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[verda] VERDA_SCALEDOWN_SECONDS=${JSON.stringify(raw)} is not a positive number; ` +
        `falling back to ${DEFAULT_VERDA_SCALEDOWN_SECONDS}s.`,
    )
    return DEFAULT_VERDA_SCALEDOWN_SECONDS
  }
  return Math.floor(parsed)
}

/** Process-local state. Parked on a `globalThis` symbol for the same reason the
 *  routine scheduler is: a dev-server HMR reload re-evaluates this module, and
 *  a fresh module scope would silently reset the clock to "cold". */
const STATE_KEY = Symbol.for('kg-agent.verda-activity')
interface VerdaState {
  lastCompletedAt: number | null
  inFlight: number
}
type VerdaGlobal = typeof globalThis & { [STATE_KEY]?: VerdaState }
const state: VerdaState = ((globalThis as VerdaGlobal)[STATE_KEY] ??= {
  lastCompletedAt: null,
  inFlight: 0,
})

/** Record that a call to the self-hosted box just finished. Called from the
 *  LLM-usage observer for every sample naming `VerdaQwen` — success or failure,
 *  because a failed call woke the box exactly as much as a successful one. */
export function noteVerdaCallCompleted(at: number = Date.now()): void {
  state.lastCompletedAt = at
}

/** A turn on the Verda tier started. Pair with {@link endVerdaTurn} in a
 *  `finally` — an unbalanced increment leaves the header claiming a run that
 *  ended. */
export function beginVerdaTurn(): void {
  state.inFlight += 1
}

/** A turn on the Verda tier finished. Deliberately does NOT stamp the clock:
 *  only a sample naming `VerdaQwen` may do that, so a turn that happened to
 *  make no Verda-routed call (an approval that resolved without an LLM step)
 *  cannot invent warmth the box never had. Never lets the gauge go negative —
 *  a mispaired decrement would otherwise pin the header to "running". */
export function endVerdaTurn(): void {
  state.inFlight = Math.max(0, state.inFlight - 1)
}

/** Test-only reset. */
export function resetVerdaActivity(): void {
  state.lastCompletedAt = null
  state.inFlight = 0
}

/** What the header renders. */
export interface VerdaWarmth {
  /**
   * - `running` — a turn is on the box right now, AND the box was already warm
   *   when it started (so it implies warm, which is what the word promises).
   * - `starting` — a turn is on the box but nothing recent proves the box was
   *   up, so this turn is probably paying the cold start. Never claims a
   *   countdown: there is nothing measured to count down from.
   * - `warm` — a call completed within the scale-down window.
   * - `cold` — nothing recent; the next call pays a cold start.
   * - `unknown` — this process has never seen a Verda call, so it cannot tell
   *   `cold` from "warm because another instance is using it". Distinct from
   *   `cold` on purpose: presenting a guess as a measurement is the failure.
   */
  state: 'running' | 'starting' | 'warm' | 'cold' | 'unknown'
  /** Whole seconds until scale-down, or `null` when there is nothing to count
   *  down (`starting`/`cold`/`unknown`). Never negative. */
  secondsUntilScaledown: number | null
  /** The configured delay, so the client can render a proportion without a
   *  second round trip. */
  scaledownSeconds: number
}

/**
 * The current warm state. Pure w.r.t. `now`, which is what makes the countdown
 * arithmetic testable without faking a clock at every call site.
 */
export function verdaWarmth(now: number = Date.now()): VerdaWarmth {
  const scaledownSeconds = verdaScaledownSeconds()
  const last = state.lastCompletedAt

  // A running turn keeps the box awake regardless of when the last call
  // completed — reporting a countdown here would tick towards a scale-down
  // that cannot happen while work is in flight.
  //
  // But `inFlight` is incremented at turn ENTRY, before any call has reached
  // the box, so on its own it proves intent rather than warmth. Claiming
  // "answering" with a full countdown for the first message to a scaled-to-zero
  // deployment tells the sender the box is up while they pay the multi-minute
  // cold start this indicator exists to warn about — and tells every OTHER
  // reader of the strip the same, so they send into the same wait. The whole
  // module errs pessimistically by design; this was the one place it did not.
  // So a turn only reads as `running` when a completed call independently says
  // the box was warm; otherwise it reads as `starting`, which claims nothing.
  if (state.inFlight > 0) {
    const provenWarm = last !== null && last + scaledownSeconds * 1000 > now
    return provenWarm
      ? { state: 'running', secondsUntilScaledown: scaledownSeconds, scaledownSeconds }
      : { state: 'starting', secondsUntilScaledown: null, scaledownSeconds }
  }
  if (last === null) {
    return { state: 'unknown', secondsUntilScaledown: null, scaledownSeconds }
  }
  const remainingMs = last + scaledownSeconds * 1000 - now
  if (remainingMs <= 0) {
    return { state: 'cold', secondsUntilScaledown: null, scaledownSeconds }
  }
  return {
    state: 'warm',
    secondsUntilScaledown: Math.ceil(remainingMs / 1000),
    scaledownSeconds,
  }
}

/**
 * When this process last saw a call to the box FINISH, or `null` if it never
 * has. The narrow accessor exists for one caller — `inference/cold-start.server.ts`
 * — which needs a claim {@link verdaWarmth} deliberately collapses: `starting`
 * covers both "we have seen the box go cold" and "we have never seen it at
 * all", and only the first is evidence a cold start is actually being paid.
 * Reporting a measurement taken under the second would let "the box was warm
 * and this process had not noticed" enter the cold-start history as a
 * four-second cold start.
 */
export function verdaLastCallCompletedAt(): number | null {
  return state.lastCompletedAt
}
