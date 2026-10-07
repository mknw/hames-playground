/**
 * Decision-calibration probe — Server Only (#418 T6, D12 / F4)
 *
 * A `typedDecision` whose policy sets `requireCalibrated` abstains on EVERY
 * call until a calibration entry exists for the client that serves it
 * (`configureDecisionCalibration`, keyed `(client, spec.key)`). That is a
 * control present and unreachable: nothing errors, the fallback label is just
 * taken forever. This probe is how it gets noticed — one warning per
 * `(tier, key)` the first time an agent's patterns are built, naming the tier.
 *
 * ## Why per tier, and why derived
 *
 * Calibration is fitted on one model's distribution and does not transfer
 * (F2), so a key calibrated on the private tier's client is still uncalibrated
 * on the Anthropic tier's. One tier-less warning would be silenced by whichever
 * tier happened to have an entry — the exact blind spot the probe exists for.
 *
 * The tier → client mapping is NOT written out here: it is what
 * `resolveClientForRole('decide')` answers under each tier, so a rename or a
 * re-point (T4's `JevDecide` landing, a future `VerdaQwenDecide`) moves the
 * probe with it. The private tier is probed only when it is configured
 * (`verdaConfigured`) — an unconfigured tier cannot serve a call, so a warning
 * about it is noise. The tier is put in a frame that carries NO per-run client
 * override, so the answer is the tier's and not whatever the surrounding run
 * plugged in.
 *
 * The warning names the key and the tier and nothing else: no question, label
 * text or state (the decision state may hold user content).
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import {
  amendRunFrame,
  currentRunFrame,
  withRunFrame,
} from '@hames-ai/harness-patterns/run-frame.server'
import { harnessCalibratedDecisionKeys, type ConfiguredPattern } from '@hames-ai/harness-patterns'
import { decisionCalibrationFor, resolveClientForRole } from '@hames-ai/harness-baml/clients.server'
import { verdaConfigured, type InferenceTier } from './config.server'

assertServerOnImport()

/** The tiers a decision can be served on in THIS deployment, in the order
 *  they are reported. */
function configuredTiers(): InferenceTier[] {
  return verdaConfigured() ? ['anthropic', 'verda'] : ['anthropic']
}

/** The client the decide role resolves to under `tier`, asked the way a call
 *  would ask it. Opened as its own frame (or an amendment of the open one),
 *  because the answer depends on the frame's tier slot and `withRunFrame`
 *  refuses a nested entry that supplies one. */
function decideClientFor(tier: InferenceTier): Promise<string> {
  const read = async () => resolveClientForRole('decide')
  const frame = { inference: { tier } }
  return currentRunFrame() ? amendRunFrame(frame, read) : withRunFrame(frame, read)
}

/** `(tier, key)` pairs already warned about, so a conversation per agent does
 *  not repeat a finding that is a property of the deployment. */
const warned = new Set<string>()

/** For tests: forget what has been warned about. */
export function resetDecisionProbeForTests(): void {
  warned.clear()
}

/**
 * Warn, once per `(tier, key)`, for every `requireCalibrated` decision key in
 * `patterns` that has no calibration entry for the client its tier serves.
 * Returns the messages it emitted. Never throws: a probe that breaks the
 * agent build it observes would be worse than the silence it replaces.
 */
export async function probeDecisionCalibration<T>(
  agentId: string,
  patterns: ConfiguredPattern<T>[],
): Promise<string[]> {
  const emitted: string[] = []
  try {
    const keys = harnessCalibratedDecisionKeys(patterns)
    if (keys.length === 0) return emitted
    for (const tier of configuredTiers()) {
      const client = await decideClientFor(tier)
      for (const key of keys) {
        if (decisionCalibrationFor(client, key)) continue
        const id = `${tier}\u0000${key}`
        if (warned.has(id)) continue
        warned.add(id)
        const message =
          `[decision-probe] agent '${agentId}': decision key '${key}' requires calibration but ` +
          `has no entry for the '${tier}' tier (client ${client}) — every '${key}' decision on ` +
          `that tier will abstain until configureDecisionCalibration is fed for it.`
        console.warn(message)
        emitted.push(message)
      }
    }
  } catch (err) {
    console.warn(
      `[decision-probe] could not probe agent '${agentId}': ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  return emitted
}
