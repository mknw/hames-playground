/**
 * Usage recorder — Server Only.
 *
 * Bridges `harness-patterns`' LLM-usage observer to the three things the
 * preview header shows: the global counters (`preview-counters.server.ts`), the
 * self-hosted box's warm clock (`inference/verda-activity.server.ts`), and the
 * rolling per-tier call latency (`call-latency.server.ts`).
 *
 * It lives on the APP side of that seam on purpose. The framework must not
 * import a database — `harness-patterns` is on its way to being published as a
 * library — so it notifies, and this module is the only listener, registered
 * once from `src/middleware.ts` (the app's server-boot hook).
 *
 * ## Batching
 *
 * A busy turn makes a dozen LLM calls; writing a row-update per call would put
 * a dozen round trips in the path of every answer. Deltas are therefore
 * accumulated in memory and flushed on a short timer. The consequence is
 * stated rather than hidden: **up to one flush interval of usage is lost if the
 * process dies**, and the counters are documented as "at most what was spent".
 * A preview header is not billing; paying a synchronous write per call to make
 * it exact would be the wrong trade.
 *
 * ## Which tier a call is attributed to
 *
 * `sample.clientName` — the client BAML actually selected — not the tier the
 * run intended. A call that says `VerdaQwen` ran on the box; everything else
 * is counted as Anthropic. This is why the Verda share is worth showing: it
 * cannot be inflated by a routing change that did not take effect.
 */
import { assertServerOnImport } from '../harness-patterns/assert.server'
import { observeLlmUsage, type LlmUsageSample } from '../harness-patterns/llm-usage-observer.server'
import { noteVerdaCallCompleted, VERDA_CLIENT_NAME } from '../inference/verda-activity.server'
import { addUsage, type UsageDelta } from './preview-counters.server'
import { noteCallLatency } from './call-latency.server'
import { TIER_SWITCHED_FUNCTIONS, type InferenceTier } from '../harness-patterns/clients.server'

assertServerOnImport()

/** How long a delta may sit in memory before it is written. Short enough that
 *  a header polling every few seconds sees its own turn's usage; long enough
 *  that a 12-call turn costs one write, not twelve. */
export const USAGE_FLUSH_INTERVAL_MS = 5_000

const INSTALLED_KEY = Symbol.for('kg-agent.usage-recorder')
type RecorderGlobal = typeof globalThis & { [INSTALLED_KEY]?: true }

/** Deltas awaiting a flush, keyed by tier. */
const pending = new Map<InferenceTier, UsageDelta>()

function bucket(tier: InferenceTier): UsageDelta {
  let delta = pending.get(tier)
  if (!delta) {
    delta = { tier, llmCalls: 0, inputTokens: 0, outputTokens: 0, turns: 0 }
    pending.set(tier, delta)
  }
  return delta
}

/** The tier a sample is attributed to. See the module docstring: the selected
 *  client is the evidence, the intended routing is not. */
export function tierOfSample(sample: LlmUsageSample): InferenceTier {
  return sample.clientName === VERDA_CLIENT_NAME ? 'verda' : 'anthropic'
}

/** Fold one finished call into the pending deltas. Exported for the tests —
 *  the observer registration is what production calls. */
export function recordSample(sample: LlmUsageSample, at: number = Date.now()): void {
  if (sample.clientName === VERDA_CLIENT_NAME) noteVerdaCallCompleted(at)

  // Latency is recorded on its own condition, BEFORE the metrics gate below: a
  // call that failed after reaching the model spent the user's wall-clock time
  // whether or not it reported tokens, and dropping those would bias the median
  // towards the calls that went well. `durationMs` is absent when BAML measured
  // nothing, which is the only case there is nothing to record.
  //
  // And only the SWITCHED roles, unlike the counters above and below, which
  // count every call. The latency is read as a comparison between the two
  // switch positions, and `router` / `describe` / `screen` / `planner` run on
  // Anthropic in both — so counting them would leave each window holding a
  // different role mix: on a verda-tier turn the heavy calls land in the
  // `verda` window while that same turn's cheap side-roles land in the
  // `anthropic` one. Filtering here rather than in the store keeps the store's
  // job "median of what it was given" and puts the eligibility rule next to the
  // map it comes from.
  if (sample.durationMs !== undefined && TIER_SWITCHED_FUNCTIONS.has(sample.functionName)) {
    noteCallLatency(tierOfSample(sample), sample.durationMs)
  }

  const m = sample.metrics
  // No accounting means the call never reached a model (a pre-flight throw).
  // It did not spend anything and, for Verda, did not wake anything either —
  // but the clock above is stamped only on a named client, so nothing to undo.
  if (!m) return

  const delta = bucket(tierOfSample(sample))
  delta.llmCalls += 1
  delta.inputTokens += m.inputUncachedTokens + m.inputCacheReadTokens + m.inputCacheWriteTokens
  delta.outputTokens += m.outputTokens
}

/** Count one user turn against a tier. Called by the turn runner, which is the
 *  only thing that knows a turn happened at all. */
export function recordTurn(tier: InferenceTier): void {
  bucket(tier).turns += 1
}

/**
 * Write every pending delta and clear it.
 *
 * Failures are logged and the delta is DROPPED, not retried: a retry queue
 * that grows while Postgres is down is a memory leak in the path of every
 * turn, and the number it protects is a header stat. Dropping is visible in
 * the log; growing without bound is not.
 */
export async function flushUsage(now: number = Date.now()): Promise<void> {
  if (pending.size === 0) return
  const deltas = [...pending.values()]
  pending.clear()
  for (const delta of deltas) {
    await addUsage(delta, now).catch((err: unknown) =>
      console.error('[usage] counter flush failed; this slice of usage is not counted:', err),
    )
  }
}

/**
 * Register the observer and arm the flush timer. Idempotent and HMR-safe (the
 * install flag is parked on a `globalThis` symbol), mirroring
 * `startRoutineScheduler` — a dev-server reload must not stack a second timer
 * or a second listener that double-counts every call.
 */
export function installUsageRecorder(intervalMs: number = USAGE_FLUSH_INTERVAL_MS): void {
  const g = globalThis as RecorderGlobal
  if (g[INSTALLED_KEY]) return
  g[INSTALLED_KEY] = true

  observeLlmUsage((sample) => recordSample(sample))

  const timer = setInterval(() => {
    void flushUsage()
  }, intervalMs)
  // Never hold the process open for a counter flush.
  if (typeof timer.unref === 'function') timer.unref()
}
