/**
 * The inference tier's vocabulary — and, since PR-1a, the APP-POLICY half of
 * the private-tier configuration, registered into the harness client seam.
 *
 * The `InferenceTier` union itself MOVED to `harness-baml/clients.server.ts`
 * (PR-1a of the #225 extraction): the tier scope is that module's seam, so its
 * vocabulary is package-side. This module re-exports it, so every existing
 * importer keeps its path. What stayed here is everything that reads the
 * HOST's environment: `verdaInferenceEnabled`, the three fail-closed endpoint
 * asserts, and the composition-root registration that FEEDS the seam — the
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
import { assertServerOnImport } from '@hames/harness-patterns/assert.server'
import {
  CLIENT_MAX_OUTPUT_TOKENS,
  MODEL_CONTEXT_WINDOWS,
  TIME_PRICED_CLIENT,
  estimateLlmCostEur,
} from '../settings'
import { eurPerUsdRate, verdaEurPerHour } from '../cost-rates.server'
import { runAppBamlClientCheckOnce } from '../baml-client-check.server'
import { VERDA_CLIENT_NAME } from './verda-activity.server'
import { noteVerdaCallStarting } from './cold-start.server'
import {
  configureCostPricing,
  configureCostRates,
  configureInferencePolicy,
  configureModelTables,
} from '@hames/harness-baml/clients.server'

assertServerOnImport()

export type { InferenceTier } from '@hames/harness-baml/clients.server'

/** `USE_VERDA_INFERENCE=1` — the DEPLOYMENT default: the tier every run takes
 *  when no per-run scope says otherwise. Read per call rather than cached at
 *  module load so a test (and a script that sets it before importing a
 *  pattern) sees it. MOVED here verbatim from `clients.server.ts` (PR-1a):
 *  it reads the host's env, which is exactly what stayed behind. */
export function verdaInferenceEnabled(): boolean {
  return process.env.USE_VERDA_INFERENCE === '1'
}

// ============================================================================
// The endpoint asserts — MOVED verbatim from `clients.server.ts` (PR-1a).
// They read the host's env, so they live host-side; the seam consumes them
// through `configureInferencePolicy` below.
// ============================================================================

/**
 * Throws unless the Verda endpoint is configured well enough to reach.
 *
 * FAIL CLOSED, and deliberately: the alternative — warn, then let BAML fall
 * through to the declared Anthropic client — would silently route
 * confidential-compute traffic to the provider the flag exists to avoid, and
 * nothing downstream would look wrong. Throwing is the loud version of the
 * same information.
 *
 * WHEN it throws is narrower than "startup": nothing on the server-boot path
 * imports this module. `src/middleware.ts` arms only the routine scheduler,
 * and every importer of this file (`baml-adapters.server.ts`, the patterns,
 * `compactBulkData`) is reached from a server function or a routine's dynamic
 * `import()`. So a flag-on deployment with a typo'd endpoint BOOTS GREEN and
 * throws on the first call that touches the harness — not on `start`.
 *
 * `base_url` is handed to `openai-generic` verbatim (BAML options take an
 * `env.X` reference, not an expression, so nothing can append a path for us),
 * which is why the env var must already BE the OpenAI-compatible base — the
 * deployment root plus `/v1`. Without the suffix the first request 404s
 * mid-conversation on `<root>/chat/completions`.
 */
export function assertVerdaConfigured(): void {
  const endpoint = process.env.VERDA_INFERENCE_ENDPOINT
  const missing = [
    ['VERDA_INFERENCE_ENDPOINT', endpoint],
    ['VERDA_INFERENCE_API_KEY', process.env.VERDA_INFERENCE_API_KEY],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name)
  if (missing.length > 0) {
    throw new Error(
      `USE_VERDA_INFERENCE=1 but ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set. ` +
        'Set them (see app/.env.example) or unset USE_VERDA_INFERENCE — this build refuses to ' +
        'quietly send the flagged roles to Anthropic instead.',
    )
  }
  if (!/\/v1\/?$/.test(endpoint as string)) {
    throw new Error(
      'VERDA_INFERENCE_ENDPOINT must be the OpenAI-compatible base URL, i.e. end in `/v1` ' +
        '(the deployment root plus the version path). BAML passes it to openai-generic verbatim, ' +
        'so a root URL makes every call 404 on `<root>/chat/completions`.',
    )
  }
}

/**
 * Throws unless the 4B summarizer the private tier's `describe` role runs on is
 * reachable — `SMALL_LLM_BASE_URL`, the #256 env-vars-only contract.
 *
 * FAIL CLOSED, and this one is a NAMED OWNER DECISION (2026-08-26) rather than
 * an inherited posture: describe must never silently descale back onto the 27B.
 * A fallback would look harmless — the calls would succeed, on infrastructure
 * the company still controls, so the confidential-compute property would hold —
 * and that is exactly what makes it the wrong default. It would be a routing
 * change nobody asked for, invisible in every log, moving the highest-frequency
 * role in the repo onto the model the tier's whole latency budget was rearranged
 * to keep it off, and doing it on the role that is handed tool results verbatim
 * (SD-10). "It still works" is not the property being protected.
 *
 * `SMALL_LLM_API_KEY` is deliberately NOT required. llama-server authenticates
 * nothing, so a local `make llm-small` has no key to set; `openai-generic` sends
 * the header regardless and a remote endpoint that checks one fails loudly on
 * its own with a 401. Demanding it here would refuse the tier for the common
 * local case.
 *
 * The URL is checked for the `/v1` suffix for `assertVerdaConfigured`'s reason:
 * BAML hands `base_url` to `openai-generic` verbatim, so a root URL 404s every
 * call on `<root>/chat/completions` — mid-conversation, which is the failure
 * this whole family of checks exists to move forward in time.
 */
export function assertSmallModelConfigured(): void {
  const base = process.env.SMALL_LLM_BASE_URL
  if (!base) {
    throw new Error(
      'The private inference tier routes the `describe` role to LocalQwenSmall, but ' +
        'SMALL_LLM_BASE_URL is not set. Set it (see app/.env.example — `make llm-small` serves ' +
        'http://localhost:8095/v1) or use the anthropic tier. This build refuses to quietly ' +
        'descale summarization back onto the 27B: that would re-route the role handed tool ' +
        'results verbatim, invisibly, and nobody asked for it.',
    )
  }
  if (!/\/v1\/?$/.test(base)) {
    throw new Error(
      'SMALL_LLM_BASE_URL must be the OpenAI-compatible base URL, i.e. end in `/v1`. BAML passes ' +
        'it to openai-generic verbatim, so a root URL makes every describe call 404 on ' +
        '`<root>/chat/completions`.',
    )
  }
}

/**
 * Throws unless EVERY endpoint the private tier needs is configured.
 *
 * The tier is two models (see `VERDA_CLIENT_BY_ROLE`), so its configuration is
 * a conjunction and this is the only function that says so. Every gate on the
 * tier — the module-load check below, `runWithInferenceTier('verda')` (through
 * the seam's registered `assertTierReachable`), and `verdaConfigured()`'s
 * "may a user pick this?" — goes through here, so adding a third model to the
 * tier is one edit rather than three.
 *
 * The two halves stay separately callable on purpose: `scripts/smoke-verda.ts`
 * exercises only the 27B roles and must not be refused for a summarizer it never
 * calls.
 */
export function assertPrivateTierConfigured(): void {
  assertVerdaConfigured()
  assertSmallModelConfigured()
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
// a countdown is host knowledge (VERDA_CLIENT_NAME), so the filter lives here.
// ============================================================================

configureModelTables({
  maxOutputTokens: CLIENT_MAX_OUTPUT_TOKENS,
  contextWindows: MODEL_CONTEXT_WINDOWS,
})

configureInferencePolicy({
  defaultTier: () => (verdaInferenceEnabled() ? 'verda' : 'anthropic'),
  assertTierReachable: assertPrivateTierConfigured,
  onPrivateCallStart: (client: string) => {
    // The client test arrived with the describe flip: the private tier is two
    // models, and `LocalQwenSmall` does not scale to zero — it is a
    // llama-server somebody is running. A bag naming it is a call that will
    // answer in milliseconds, and announcing "starting GPU, ~146 seconds" in
    // front of it would be a countdown for a wait nobody is paying, fired from
    // the highest-frequency role on the tier. So the hook keys on the CLIENT,
    // not on "the tier moved this role". No-op unless a turn armed a watch
    // (`runWithColdStartWatch`).
    if (client === VERDA_CLIENT_NAME) noteVerdaCallStarting()
  },
})

configureCostRates({ eurPerUsd: eurPerUsdRate, verdaEurPerHour: verdaEurPerHour })

// The cost ESTIMATOR stays host-side (its CLIENT_PRICING table is app pricing
// config beside the client-safe UI that renders it — SA-C2 family); the
// package's `computeEventMetrics` calls it through the seam. The time-priced
// client name rides along: it is what makes a usage-less attempt on the
// scale-to-zero box price as a floor instead of being dropped.
configureCostPricing({ estimate: estimateLlmCostEur, timePricedClient: TIME_PRICED_CLIENT })

// The APP tree's BAML-client staleness check (the package tree's own check
// fires from the package's module load). One-shot, fire-and-forget.
runAppBamlClientCheckOnce()

// Checked once, at module load, and only when the flag is on: a misconfigured
// endpoint should fail loudly and closed rather than surface as a 404 mid-
// conversation. Module load is the FIRST use of the harness, not process
// start (see the note on `assertVerdaConfigured` above), so this refuses the
// first agent call — it does not refuse the boot. Costs nothing on the
// default path.
if (verdaInferenceEnabled()) assertPrivateTierConfigured()

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
 * It asks about BOTH endpoints, because the tier needs both (the 27B and the
 * 4B summarizer). A deployment with only the 27B configured therefore leaves the
 * switch's private position DISABLED and defaults every user to Anthropic — a
 * whole-tier decision the operator can see, rather than a tier that works until
 * the first tool result needs summarizing.
 */
export function verdaConfigured(): boolean {
  try {
    assertPrivateTierConfigured()
    return true
  } catch {
    return false
  }
}
