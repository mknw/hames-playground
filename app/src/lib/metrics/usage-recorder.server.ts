/**
 * Usage recorder — Server Only.
 *
 * Bridges `harness-patterns`' LLM-usage observer to the three things the
 * preview header shows: the global counters (`preview-counters.server.ts`), the
 * self-hosted box's warm clock (`inference/large-activity.server.ts`), and the
 * rolling per-tier call latency (`call-latency.server.ts`) — plus a fourth
 * consumer that is not on the header at all: the chat's cold-start notice
 * (`inference/cold-start.server.ts`), which closes the loop on the wait it
 * announced by turning its duration into the next estimate.
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
 * `sample.clientName` — the client BAML actually selected — not the tier the run
 * intended. This is why the private share is worth showing: it cannot be
 * inflated by a routing change that did not take effect.
 *
 * The set of names that count is `PRIVATE_TIER_CLIENTS`: the tier map plus
 * dormant thinking leaves (#625), not a
 * single literal, and that changed on 2026-08-26 when the private tier became
 * two models: the heavy roles on `SelfDeployedQwen` and `describe` on `LocalQwenSmall`.
 * A hardcoded `=== SELF_DEPLOYED_CLIENT_NAME` would have counted every private-tier
 * describe call as an ANTHROPIC call — six of the twelve functions, and the
 * highest-frequency ones — silently understating the private share on exactly
 * the tier the number exists to report. Deriving it means a third model added to
 * that map is counted with no edit here.
 *
 * The WARM CLOCK does not follow the same set, and the difference is the point:
 * each box has its own clock. Only a call naming `SelfDeployedQwen` or its thinking twin stamps the 27B
 * clock; a 4B describe sample with metrics stamps the small clock instead. A
 * cold ingress can answer 503 without reaching the model, so a small sample
 * without metrics is not evidence of warmth.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import {
  observeLlmUsage,
  type LlmUsageSample,
} from '@hames-ai/harness-patterns/llm-usage-observer.server'
import {
  noteLargeCallCompleted,
  SELF_DEPLOYED_CLIENT_NAME,
} from '../inference/large-activity.server'
import { noteSmallCallCompleted, settleColdStart } from '../inference/cold-start.server'
import { addUsage, type UsageDelta } from './preview-counters.server'
import { noteCallLatency } from './call-latency.server'
import {
  TIER_SWITCHED_FUNCTIONS,
  PRIVATE_TIER_CLIENTS,
  THINKING_CLIENTS,
} from '@hames-ai/harness-baml/clients.server'
import type { InferenceTier } from '../inference/config.server'

assertServerOnImport()

/** How long a delta may sit in memory before it is written. Short enough that
 *  a header polling every few seconds sees its own turn's usage; long enough
 *  that a 12-call turn costs one write, not twelve. */
export const USAGE_FLUSH_INTERVAL_MS = 5_000

const INSTALLED_KEY = Symbol.for('hames-app.usage-recorder')
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
  // A sample with no client name is a call that never named one — Anthropic by
  // elimination, and the same answer the `===` comparison this replaced gave.
  return PRIVATE_TIER_CLIENTS.has(sample.clientName ?? '') ? 'self_deployed' : 'anthropic'
}

/** Fold one finished call into the pending deltas. Exported for the tests —
 *  the observer registration is what production calls. */
export function recordSample(sample: LlmUsageSample, at: number = Date.now()): void {
  // The 27B and its thinking twin, NOT every `PRIVATE_TIER_CLIENTS` member, are
  // claims about the 27B specifically — it is awake, and this is how long its
  // cold start took. A 4B describe call is evidence of neither; it has its own
  // clock below. Tier attribution alone cannot prove either box is warm.
  if (
    sample.clientName === SELF_DEPLOYED_CLIENT_NAME ||
    THINKING_CLIENTS.has(sample.clientName ?? '')
  ) {
    noteLargeCallCompleted(at)
    // If this turn announced a cold start, this is the call that paid it, and
    // BAML's own timing for it is the next estimate's raw material. No-op on
    // every other sample, and on a turn that announced nothing — so the
    // history only ever grows from a wait a user actually sat through.
    settleColdStart(sample.durationMs)
  }

  // The 4B's warm clock. Same evidence rule as the 27B's: a call that spent
  // tokens is a box that answered. A cold ingress's immediate 503 spends none.
  if (sample.clientName === 'LocalQwenSmall' && sample.metrics) noteSmallCallCompleted(at)

  // Latency is recorded on its own condition, BEFORE the metrics gate below: a
  // call that failed after reaching the model spent the user's wall-clock time
  // whether or not it reported tokens, and dropping those would bias the median
  // towards the calls that went well. `durationMs` is absent when BAML measured
  // nothing, which is the only case there is nothing to record.
  //
  // And only the SWITCHED roles, unlike the counters above and below, which
  // count every call. The latency is read as a comparison between the two
  // switch positions, so a function whose client does not follow the switch
  // would leave each window holding a different role mix and a user would read
  // that as a model difference. After the second 2026-08-26 owner decision
  // (the injection screen joined the tier, SD-4) that is ZERO functions, so
  // this predicate currently admits everything and the two sets coincide.
  // Kept rather than deleted because it is DERIVED: pull a role back out of
  // `SELF_DEPLOYED_CLIENT_BY_ROLE` and the filter starts excluding again with no edit
  // here. The filter is here rather than in the store so the store's job stays
  // "median of what it was given" and the eligibility rule sits next to the
  // map it comes from.
  if (sample.durationMs !== undefined && TIER_SWITCHED_FUNCTIONS.has(sample.functionName)) {
    noteCallLatency(tierOfSample(sample), sample.durationMs)
  }

  const m = sample.metrics
  // No accounting means the call never reached a model (a pre-flight throw).
  // It did not spend anything and, for the self-deployed tier, did not wake anything either —
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
