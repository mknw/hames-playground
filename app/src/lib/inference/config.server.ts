import { inferenceEnv } from '@hames-ai/harness-baml/inference-env.server'
/**
 * The inference tier's vocabulary — and, since PR-1a, the APP-POLICY half of
 * the private-tier configuration, registered into the harness client seam.
 *
 * The `InferenceTier` union itself MOVED to `harness-baml/clients.server.ts`
 * (PR-1a of the #225 extraction): the tier scope is that module's seam, so its
 * vocabulary is package-side. This module re-exports it, so every existing
 * importer keeps its path. What stayed here is everything that reads the
 * HOST's environment: `selfDeployedInferenceEnabled`, the endpoint asserts re-exported
 * from `tier-config.server.ts`, and the composition-root registration that FEEDS the seam — the
 * model tables (values from `settings.ts`, which stays beside `baml_src/` per
 * SA-C2), the tier policy (env default, reachability assert, the wake hook),
 * and the EUR rates.
 *
 * Import direction (the one the extraction forbids in the other direction):
 * host policy → the seam. `clients.server.ts` imports NOTHING from this
 * module — not even a type — so the later package move (PR-1b) can lift it
 * byte-identically. The dual-instance property that #342 pinned for the
 * settings scope is pinned here too (`clients-seam.test.ts`): the registration
 * and the resolution must land in the SAME module instance, and the pin goes
 * red when they do not.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { CLIENT_MAX_OUTPUT_TOKENS, MODEL_CONTEXT_WINDOWS, estimateLlmCostEur } from '../settings'
import { eurPerUsdRate, selfDeployedEurPerHour, smallLlmEurPerHour } from '../cost-rates.server'
import { privateInferenceOnly, assertPrivateTierConfigured } from './tier-config.server'
export {
  privateInferenceOnly,
  assertSelfDeployedConfigured,
  assertSmallModelConfigured,
  assertPrivateTierConfigured,
} from './tier-config.server'
import { SELF_DEPLOYED_CLIENT_NAME } from './self-deployed-activity.server'
import { noteBoxCallStarting } from './cold-start.server'
import {
  SELF_DEPLOYED_CLIENT_BY_ROLE,
  THINKING_CLIENTS,
  configureCostPricing,
  configureCostRates,
  configureInferencePolicy,
  configureModelTables,
} from '@hames-ai/harness-baml/clients.server'

assertServerOnImport()

export type { InferenceTier } from '@hames-ai/harness-baml/clients.server'

/** `USE_SELF_DEPLOYED_INFERENCE=1` — the DEPLOYMENT default: the tier every run takes
 *  when no per-run scope says otherwise. Read per call rather than cached at
 *  module load so a test (and a script that sets it before importing a
 *  pattern) sees it. MOVED here verbatim from `clients.server.ts` (PR-1a):
 *  it reads the host's env, which is exactly what stayed behind. */
export function selfDeployedInferenceEnabled(): boolean {
  return privateInferenceOnly() || inferenceEnv('USE_SELF_DEPLOYED_INFERENCE') === '1'
}

// ============================================================================
// THE COMPOSITION ROOT — the host feeds the harness client seam (PR-1a).
//
// One registration per seam accessor, all at module load: every path that can
// reach a BAML call (the turn runner, the eval harness, the smoke scripts)
// loads this module first, because every one of them resolves a tier through
// `tier.server.ts` → here. The wake hook reproduces the filter the old
// `clientOverrideFor` carried inline — the seam announces WHICH private-tier
// client is about to be called; which of them scales to zero and owes the user
// a countdown is host knowledge, so the two-box filter lives here.
// ============================================================================

configureModelTables({
  maxOutputTokens: CLIENT_MAX_OUTPUT_TOKENS,
  contextWindows: MODEL_CONTEXT_WINDOWS,
})

configureInferencePolicy({
  defaultTier: () => (selfDeployedInferenceEnabled() ? 'self_deployed' : 'anthropic'),
  privateOnly: privateInferenceOnly,
  assertTierReachable: assertPrivateTierConfigured,
  onPrivateCallStart: (client: string) => {
    // Key on the resolved CLIENT, not every role in the private tier. The 4B
    // describe client now scales to zero too, so it owes a notice just like the
    // 27B; use the role map so a rename cannot silently drop that notice. This
    // hook only announces inside a turn's watch; it does not wake either box.
    // LocalQwenSmallDecide keeps its separate readout and existing notice
    // policy: this change enrolls describe, not every client sharing its host.
    // Changing the decide transport or its failure policy is a separate change.
    if (client === SELF_DEPLOYED_CLIENT_NAME) noteBoxCallStarting('self_deployed')
    if (client === SELF_DEPLOYED_CLIENT_BY_ROLE.describe) noteBoxCallStarting('small')
  },
})

configureCostRates({ eurPerUsd: eurPerUsdRate, selfDeployedEurPerHour })

// The cost ESTIMATOR stays host-side (its CLIENT_PRICING table is app pricing
// config beside the client-safe UI that renders it — SA-C2 family); the
// package's `computeEventMetrics` calls it through the seam. The time-priced
// client-to-rate mapping rides along: it is what makes a usage-less attempt on the
// scale-to-zero box price as a floor instead of being dropped.
configureCostPricing({
  estimate: estimateLlmCostEur,
  timePricedClients: {
    [SELF_DEPLOYED_CLIENT_NAME]: selfDeployedEurPerHour,
    ...Object.fromEntries([...THINKING_CLIENTS].map((client) => [client, selfDeployedEurPerHour])),
    LocalQwenSmall: smallLlmEurPerHour,
    PrivateSystemOne: smallLlmEurPerHour,
  },
})

// Checked once, at module load, and only when the flag is on: a misconfigured
// endpoint should fail loudly and closed rather than surface as a 404 mid-
// conversation. Module load is the FIRST use of the harness, not process
// start (see the note on `assertSelfDeployedConfigured` above), so this refuses the
// first agent call — it does not refuse the boot. Costs nothing on the
// default path.
if (selfDeployedInferenceEnabled()) assertPrivateTierConfigured()

/**
 * Whether the private tier is configured well enough to be *offered*.
 *
 * The non-throwing sibling of `assertPrivateTierConfigured()`, and the two are
 * not interchangeable: this one answers "may a user pick this tier?" (a header
 * control, a preference default), while the assert answers "this run says it
 * is on the private tier — is that reachable?" and stops the run when it is
 * not. Reaching for this one where the assert belongs is how the fail-closed
 * posture below would quietly become a fall-through to Anthropic.
 *
 * It checks all three endpoints and their required keys: the 27B, the
 * summarizer and systemone decisions. A deployment with only the 27B configured therefore leaves the
 * switch's private position DISABLED and defaults every user to Anthropic — a
 * whole-tier decision the operator can see, rather than a tier that works until
 * the first tool result needs summarizing.
 */
export function selfDeployedConfigured(): boolean {
  try {
    assertPrivateTierConfigured()
    return true
  } catch {
    return false
  }
}
