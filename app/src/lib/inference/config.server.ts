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
import { inferenceEnv } from '@hames-ai/harness-baml/inference-env.server'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { CLIENT_MAX_OUTPUT_TOKENS, MODEL_CONTEXT_WINDOWS, estimateLlmCostEur } from '../settings'
import { eurPerUsdRate, largeEurPerHour, smallLlmEurPerHour } from '../cost-rates.server'
import { privateInferenceOnly, assertPrivateTierConfigured } from './tier-config.server'
export {
  privateInferenceOnly,
  assertLargeModelConfigured,
  assertSmallModelConfigured,
  assertPrivateTierConfigured,
} from './tier-config.server'
import { LARGE_LLM_CLIENT_NAME } from './large-activity.server'
import { noteBoxCallStarting } from './cold-start.server'
import {
  SELF_DEPLOYED_CLIENT_BY_ROLE,
  configureCostPricing,
  configureCostRates,
  configureInferencePolicy,
  configureModelTables,
  type InferenceTierPolicy,
} from '@hames-ai/harness-baml/clients.server'

assertServerOnImport()

export type { InferenceTier } from '@hames-ai/harness-baml/clients.server'

/** `USE_SELF_DEPLOYED_INFERENCE=1` — the BOOT-TIME switch: the self-deployed tier
 *  must be configured, checked when this module loads. It is NOT the tier of a
 *  run that names none: that is always the self-deployed tier (the ONE tier
 *  rule, `harness-baml/tier.server.ts`), refused when unconfigured. Read per
 *  call rather than cached at module load so a test (and a script that sets it
 *  before importing a pattern) sees it. MOVED here verbatim from
 *  `clients.server.ts` (PR-1a): it reads the host's env, which is exactly what
 *  stayed behind. */
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

/** The host's tier policy, exported so a test double can spread it and change
 *  one field instead of copying its shape. */
export const hostInferencePolicy: InferenceTierPolicy = {
  // The ONE tier rule (ruling E): a run that names no tier is a self-deployed-tier
  // run whatever the flag says. A deployment that has not configured the tier
  // REFUSES such a run (`assertTierReachable`, run by `activeInferenceTier()` on a
  // defaulted tier) — it never routes it to Anthropic.
  defaultTier: () => 'self_deployed',
  privateOnly: privateInferenceOnly,
  assertTierReachable: assertPrivateTierConfigured,
  onPrivateCallStart: (client: string) => {
    // Key on the resolved CLIENT, not every role in the private tier. The 4B
    // describe client now scales to zero too, so it owes a notice just like the
    // 27B; use the role map so a rename cannot silently drop that notice. This
    // hook only announces inside a turn's watch; it does not wake either box.
    // PrivateSystemOne keeps its separate readout and existing notice
    // policy: this change enrolls describe, not every client sharing its host.
    // Changing the decide transport or its failure policy is a separate change.
    // The THINK twin is the same box on the modal route, so a reasoning-
    // configured turn owes the same notice; on the OpenRouter route the
    // resolved name is `LargeQwenThinkOR`, which matches nothing here — there
    // is no box to warm.
    if (client === LARGE_LLM_CLIENT_NAME || client === 'LargeQwenThink') {
      noteBoxCallStarting('large')
    }
    if (client === SELF_DEPLOYED_CLIENT_BY_ROLE.describe) noteBoxCallStarting('small')
  },
}
configureInferencePolicy(hostInferencePolicy)

configureCostRates({ eurPerUsd: eurPerUsdRate, largeEurPerHour })

// The cost ESTIMATOR stays host-side (its CLIENT_PRICING table is app pricing
// config beside the client-safe UI that renders it — SA-C2 family); the
// package's `computeEventMetrics` calls it through the seam. The time-priced
// client-to-rate mapping rides along: it is what makes a usage-less attempt on
// a metered box price as a floor instead of being dropped. Both boxes' clients
// are here — the 27B leaves under the owner's 2026-10-13
// metered-infrastructure decision (TIME_PRICED_CLIENTS in settings.ts), the 4B
// summarizer and the private systemone client at their own rate. The
// OpenRouter-route twins are deliberately ABSENT: when the eval re-points the
// large endpoint at a per-token public API, those calls have no GPU-hour bill
// and price off the provider's reported `usage.cost` instead.
configureCostPricing({
  estimate: estimateLlmCostEur,
  timePricedClients: {
    LargeQwen: largeEurPerHour,
    LargeQwenThink: largeEurPerHour,
    SmallQwen: smallLlmEurPerHour,
    PrivateSystemOne: smallLlmEurPerHour,
  },
})

// Checked once, at module load, and only when the flag is on: a misconfigured
// endpoint should fail loudly and closed rather than surface as a 404 mid-
// conversation. Module load is the FIRST use of the harness, not process
// start (see the note on `assertLargeModelConfigured` above), so this refuses the
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
