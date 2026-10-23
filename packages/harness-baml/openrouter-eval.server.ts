/**
 * The eval-only OpenRouter route for the 27B leaves — Server Only
 *
 * WHY THIS EXISTS: the 27B eval runs the private tier's heavy roles against
 * `qwen/qwen3.8-27b` on OpenRouter while `describe` and `decide` stay on the
 * private small box. The switch is ENV-ONLY: the eval process points
 * `LARGE_LLM_BASE_URL` / `LARGE_LLM_API_KEY` at OpenRouter. With those vars
 * unset — or pointed at any non-OpenRouter host — this module is inert and
 * nothing on the wire changes: the declared `LargeQwen` client in
 * `baml_src/large-client.baml` is served exactly as before, by the box, under
 * its default model id.
 *
 * THE PROVIDER BLOCK. OpenRouter honours a per-request top-level `provider`
 * object; the eval sends `provider: { zdr: true }` — zero data retention — the
 * OWNER's explicit choice for the eval. It rides the SAME verbatim-forwarding
 * mechanism `chat_template_kwargs` does: `openai-generic` emits every option it
 * does not recognise into the request body as-is. The declared client carries
 * no `provider` key, so the default path forwards nothing new; the block is
 * declared ONLY on the registry client below, which is composed only under the
 * switch.
 *
 * THE MECHANISM: BAML's per-call `ClientRegistry` (`addLlmClient`), handed out
 * through the consumer client layer (`configureConsumerClients` — the
 * "bring your own provider" plug of #374 D1). The registry re-declares
 * `LargeQwen` under the SAME NAME with two deltas — the env-resolved model id
 * (the declared client's `env.LARGE_LLM_MODEL` reference resolves to the same
 * value; here it is resolved in TypeScript because registry options are not
 * compiled BAML and would not substitute) and the provider block. Because the
 * name is unchanged, everything keyed by the client BAML SELECTED — the usage
 * observer, the model tables, prompt budgeting, the private-tier traffic
 * counters — is untouched. Roles are derived from `SELF_DEPLOYED_CLIENT_BY_ROLE`
 * (every role whose value is the 27B), so `describe` (`SmallQwen`) and `decide`
 * (`PrivateSystemOne`) fall through to the built-in tier untouched — the small
 * box keeps its traffic and its time pricing.
 *
 * TWO PROPERTIES WORTH STATING PLAINLY:
 *
 * - **The options below MIRROR the declared client.** BAML offers no partial
 *   override of a declared client, so the registry carries a copy of its
 *   options; `openrouter-eval-body-shape.test.ts` renders both and pins the
 *   bodies equal except the two intended deltas, which is what keeps the copy
 *   from drifting.
 * - **A private-only deployment refuses this layer.** `assertPrivateClient`
 *   (in `clients.server.ts`) rejects any options bag carrying a
 *   `clientRegistry` while `INFERENCE_TIERS=self_deployed` is in force — so a
 *   private-only deployment can never send the private tier to a public
 *   provider through this module, and the eval does not run private-only.
 *   SD-12: pointing the private tier's heavy roles at OpenRouter is a
 *   processor/transfer decision, and this module is that decision's record —
 *   made by the owner for the eval only (zdr on the wire, "O1 in spirit").
 *
 * The warm-state hooks deliberately do NOT fire for this layer: the consumer
 * branch of `clientOverrideFor` returns before `notePrivateCallStart`, which
 * is correct — OpenRouter has no scale-to-zero box, so no warming notice, no
 * wake contribution and no box clock belong to these calls. The eval's own
 * `ensurePrivateTierAwake` skips the large poll under the same condition.
 */

import { ClientRegistry } from '@boundaryml/baml'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import type { BamlClientOverride } from './consumer-clients.server'
import {
  configureConsumerClients,
  SELF_DEPLOYED_CLIENT_BY_ROLE,
  type BamlRole,
} from './clients.server'
import { inferenceEnv, largeLlmModelId, DEFAULT_LARGE_LLM_MODEL } from './inference-env.server'

assertServerOnImport()

/** The declared 27B client the registry mirrors. Same NAME as the .baml
 *  client, deliberately — the unchanged name is what keeps the observer and
 *  the tables honest while the endpoint moves. */
const LARGE_CLIENT_NAME = 'LargeQwen'

/** True when `LARGE_LLM_BASE_URL` names an OpenRouter host (the trailing-dot
 *  form is normalised away — it names the same host to DNS and TLS but not to
 *  a string comparison). Malformed URLs read as "not OpenRouter": the declared
 *  client would fail loudly on its own endpoint assert. */
export function largeOnOpenRouter(): boolean {
  const raw = inferenceEnv('LARGE_LLM_BASE_URL')
  if (!raw) return false
  try {
    const host = new URL(raw).hostname.replace(/\.$/, '')
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai')
  } catch {
    return false
  }
}

/** The registry client's options: the declared `LargeQwen` options with the
 *  model resolved from the env (the SAME resolution `largeLlmModelId()` gives
 *  the declared client's `env.LARGE_LLM_MODEL` reference) and the provider
 *  block added. Exported for the body-shape pin, which renders these options
 *  against the declared client's render.
 *
 *  Registry options are not compiled BAML, so they cannot carry `env.X`
 *  references — they are resolved HERE, from the same vars the declared
 *  client reads. A missing key throws: a half-configured switch must fail
 *  loudly, never quietly fall back to the box or render a null option. */
export function openRouterLargeClientOptions(): Record<string, unknown> {
  const baseUrl = inferenceEnv('LARGE_LLM_BASE_URL')
  const apiKey = inferenceEnv('LARGE_LLM_API_KEY')
  if (!baseUrl || !apiKey)
    throw new Error(
      'The OpenRouter eval switch is on (LARGE_LLM_BASE_URL names an OpenRouter host) ' +
        'but LARGE_LLM_API_KEY is not set; refusing to half-configure the registry client.',
    )
  return {
    base_url: baseUrl,
    api_key: apiKey,
    model: largeLlmModelId(),
    chat_template_kwargs: { enable_thinking: false },
    max_tokens: 4096,
    temperature: 0.2,
    // The owner's choice for the eval, on the wire: zero data retention. Same
    // mechanism as `chat_template_kwargs` — verbatim into the body.
    provider: { zdr: true },
    http: { connect_timeout_ms: 30000, request_timeout_ms: 180000 },
  }
}

/** The consumer override the eval registers: every role the tier routes to the
 *  27B takes the registry; `describe`/`decide` are absent, so they fall through. */
export function openRouterLargeOverride(): BamlClientOverride | undefined {
  if (!largeOnOpenRouter()) return undefined
  const registry = new ClientRegistry()
  registry.addLlmClient(LARGE_CLIENT_NAME, 'openai-generic', openRouterLargeClientOptions())
  registry.setPrimary(LARGE_CLIENT_NAME)
  return { client: LARGE_CLIENT_NAME, clientRegistry: registry }
}

/** Every role whose tier client is the 27B — derived from the map, never
 *  listed, so a role that joins or leaves the 27B follows without a second
 *  edit. `describe` (the 4B) and `decide` (systemone) never appear here. */
export function openRouterLargeRoles(): BamlRole[] {
  return (Object.keys(SELF_DEPLOYED_CLIENT_BY_ROLE) as BamlRole[]).filter(
    (role) => SELF_DEPLOYED_CLIENT_BY_ROLE[role] === LARGE_CLIENT_NAME,
  )
}

/** Activate the eval's consumer layer — a no-op unless the large endpoint is
 *  OpenRouter. The layer is a per-ROLE function: the 27B roles (derived from
 *  the tier map) take the registry bag, every other role returns undefined so
 *  it falls through to the built-in tier — `describe`/`decide` keep the small
 *  box in every configuration. ONE layer per process (a second
 *  `configureConsumerClients` call replaces the first); the eval calls this
 *  once, after its env is set and before any inference. Returns whether the
 *  layer was activated. */
export function activateOpenRouterLargeOverride(): boolean {
  const bag = openRouterLargeOverride()
  if (!bag) {
    configureConsumerClients(undefined)
    return false
  }
  const roles = new Set(openRouterLargeRoles())
  configureConsumerClients((role) => (roles.has(role) ? bag : undefined))
  return true
}

/** The default model id, re-exported beside the switch that overrides it —
 *  `.env.example` and the eval preconditions name both together. */
export { DEFAULT_LARGE_LLM_MODEL }
