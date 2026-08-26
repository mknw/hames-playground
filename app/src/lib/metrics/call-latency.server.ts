/**
 * Rolling call latency, per inference tier — Server Only.
 *
 * Answers the one question the tier switch raises and nothing else on the
 * strip does: *if I pick this tier, how long will an answer take?* The warm
 * indicator says whether the self-hosted box is up; this says what a call costs
 * in seconds once it is.
 *
 * ## What is measured, precisely
 *
 * The **median of the last {@link LATENCY_WINDOW} completed model calls on that
 * tier**, where a call is one BAML function call and its duration is BAML's own
 * `FunctionLog.timing` (`LlmUsageSample.durationMs`, stamped at the single
 * accounting chokepoint). Three consequences the UI has to say out loud rather
 * than round off:
 *
 * - It is **per call, not per turn.** A turn makes several calls; the number
 *   here is not how long a message takes to answer.
 * - Every role is in it — the controller, the critic, the cheap summarizer —
 *   because the tier is what the window is keyed on, not the role. A tier
 *   running many small describe calls therefore reads faster than the same tier
 *   answering one controller turn. The tooltip says "model call", not "reply".
 * - **A cold start is inside it.** The self-hosted deployment scales to zero,
 *   so the first call after idle is minutes rather than seconds and drags the
 *   window with it — which is the honest reading, not a distortion to filter
 *   out: it is time a user waited. The warm indicator beside it is what
 *   distinguishes the two cases.
 *
 * ## Why the median, and why nearest-rank
 *
 * A mean is wrecked by one cold start; the median is the value a typical call
 * actually had. `percentileMs` takes the **nearest rank** — the smallest sample
 * with at least half the window at or below it — rather than averaging the two
 * middle readings of an even-sized window, so every number this module reports
 * is a duration something really took rather than a figure no call recorded.
 *
 * ## MULTI-INSTANCE CAVEAT (deliberate, and the same one as the warm indicator)
 *
 * The window is **process-local**, exactly like `inference/
 * verda-activity.server.ts`'s clock, and for the same reason: a shared Redis
 * key would be real infrastructure for a header stat. Two app instances behind
 * a load balancer each report their own traffic, so two users can see different
 * medians for the same tier at the same moment, and a restart empties the
 * window (the strip then renders "—", never a stale number). If the preview
 * ever runs more than one instance, this moves to Redis with that clock.
 *
 * ## What it holds
 *
 * Durations and a tier, nothing else — no user id, no conversation id, no
 * prompt, no content. It is an aggregate over everyone's calls shown to
 * everyone, like the counters beside it, and there is nothing in it to attribute
 * to a person (SD-10).
 */
import { assertServerOnImport } from '../harness-patterns/assert.server'
import type { InferenceTier } from '../harness-patterns/clients.server'

assertServerOnImport()

/**
 * How many recent calls the median is taken over, per tier.
 *
 * 32 is a compromise with two ends. Too short and one cold start owns the
 * median for the rest of the day's quiet period; too long and the number stops
 * tracking the deployment's current behaviour, which is the whole reason a
 * *rolling* window is right here rather than a daily average in the counters
 * table. At this size a busy tier's window turns over in a couple of turns.
 */
export const LATENCY_WINDOW = 32

/** Process-local samples per tier, on a `globalThis` symbol for the reason the
 *  warm clock is: a dev-server HMR reload re-evaluates this module, and a fresh
 *  module scope would silently empty the window. */
const STATE_KEY = Symbol.for('kg-agent.call-latency')
type LatencyState = Record<InferenceTier, number[]>
type LatencyGlobal = typeof globalThis & { [STATE_KEY]?: LatencyState }
const state: LatencyState = ((globalThis as LatencyGlobal)[STATE_KEY] ??= {
  verda: [],
  anthropic: [],
})

/**
 * Record one completed call's duration against its tier.
 *
 * Non-finite and negative readings are DROPPED rather than clamped: they mean
 * the call was not measured, and a 0 in the window is a fast call that never
 * happened. Same rule the sample field itself follows.
 */
export function noteCallLatency(tier: InferenceTier, durationMs: number): void {
  if (!Number.isFinite(durationMs) || durationMs < 0) return
  const window = state[tier]
  window.push(durationMs)
  // Ring by truncation from the front — the window is 32 long, so the cost of
  // a shift is not worth a head index and the modular arithmetic around it.
  if (window.length > LATENCY_WINDOW) window.splice(0, window.length - LATENCY_WINDOW)
}

/**
 * Nearest-rank percentile of a set of durations, in milliseconds. Pure and
 * exported so the arithmetic is testable without a process to fill.
 *
 * `p` is a fraction (0.5 for the median). The returned value is always one of
 * the inputs — see the module docstring on why nothing is interpolated.
 * `null` for an empty set: "no calls yet" is not "0 ms".
 */
export function percentileMs(durations: readonly number[], p: number): number | null {
  if (durations.length === 0) return null
  const sorted = [...durations].sort((a, b) => a - b)
  const clamped = Math.max(0, Math.min(1, p))
  const rank = Math.max(1, Math.ceil(clamped * sorted.length))
  return sorted[rank - 1]
}

/** What the header renders for one tier. */
export interface TierLatency {
  /** Median of the window, or `null` when this process has recorded no call on
   *  the tier — the strip renders "—" rather than inventing a 0. */
  p50Ms: number | null
  /** How many calls the median is over, so the tooltip can say `n` instead of
   *  implying a settled figure. Never more than {@link LATENCY_WINDOW}. */
  samples: number
}

/** The rolling median for one tier. */
export function tierLatency(tier: InferenceTier): TierLatency {
  const window = state[tier]
  return { p50Ms: percentileMs(window, 0.5), samples: window.length }
}

/** Test-only reset. */
export function resetCallLatency(): void {
  state.verda = []
  state.anthropic = []
}
