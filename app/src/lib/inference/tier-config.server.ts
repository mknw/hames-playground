/** Synchronous, I/O-free tier configuration. Boot can validate a restricted
 * deployment without registering routing policy or activating the default tier.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { parseDecisionsUrl } from '@hames-ai/harness-baml/jev-decide.server'

assertServerOnImport()

export function privateInferenceOnly(): boolean {
  const setting = process.env.INFERENCE_TIERS
  if (setting && setting !== 'private') {
    throw new Error('INFERENCE_TIERS must be unset or private; refusing invalid inference policy.')
  }
  return setting === 'private'
}

// ============================================================================
// Shared endpoint asserts. Kept separate from routing registration so boot can
// check the restriction without activating any unrestricted deployment default.
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
 * Unrestricted deployments keep their first-harness-use check in the composition
 * root. A private-only deployment also calls this synchronously during boot,
 * through `assertInferenceDeploymentConfigured`, before any request is served.
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
    const setting = privateInferenceOnly() ? 'INFERENCE_TIERS=private' : 'USE_VERDA_INFERENCE=1'
    throw new Error(
      `${setting} but ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} not set. ` +
        `Set them (see app/.env.example) or unset ${privateInferenceOnly() ? 'INFERENCE_TIERS' : 'USE_VERDA_INFERENCE'} — this build refuses to ` +
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
 * `SMALL_LLM_API_KEY` is not required by this summarizer-only check because
 * local llama-server can run without authentication. The whole private tier
 * requires it in `assertPrivateTierConfigured` for the systemone bearer key.
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
 * The tier requires the 27B endpoint, the summarizer endpoint and the systemone
 * decisions endpoint (see `VERDA_CLIENT_BY_ROLE`); this function checks their
 * configuration together. Every gate on the
 * tier — the module-load check below, `assertInferenceTier('verda')` (through
 * the seam's registered `assertTierReachable`), and `verdaConfigured()`'s
 * "may a user pick this?" — goes through here.
 *
 * The two halves stay separately callable on purpose: `scripts/smoke-verda.ts`
 * exercises only the 27B roles and must not be refused for a summarizer it never
 * calls.
 */
export function assertPrivateTierConfigured(): void {
  assertVerdaConfigured()
  assertSmallModelConfigured()
  const raw = process.env.SMALL_LLM_DECISIONS_URL
  if (!raw)
    throw new Error(
      'The private inference tier requires SMALL_LLM_DECISIONS_URL; refusing to send a decision to any other endpoint.',
    )
  const endpoint = parseDecisionsUrl(raw)
  if (typeof endpoint === 'string' || endpoint.pathname !== '/v1/systemone') {
    throw new Error(
      'SMALL_LLM_DECISIONS_URL must be a full https: or loopback URL ending in /v1/systemone.',
    )
  }
  if (
    endpoint.hostname === 'api.typesafe.ai' ||
    endpoint.hostname === 'openrouter.ai' ||
    endpoint.hostname.endsWith('.openrouter.ai')
  ) {
    throw new Error(
      'Refusing SMALL_LLM_DECISIONS_URL: it names a public systemone provider; no request was made.',
    )
  }
  if (!process.env.SMALL_LLM_API_KEY) {
    throw new Error(
      'The private inference tier requires SMALL_LLM_API_KEY; refusing to open the tier without its systemone bearer key.',
    )
  }
}

/** A restriction fails at boot; unset leaves existing lazy initialization alone. */
export function assertInferenceDeploymentConfigured(): void {
  if (privateInferenceOnly()) assertPrivateTierConfigured()
}
