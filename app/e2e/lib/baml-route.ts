/**
 * How a hermetic run reaches the fake — and why the two tiers get there
 * differently.
 *
 * ## The verda tier: the shipped seam, unmodified
 *
 * `VerdaQwen` declares `base_url env.VERDA_INFERENCE_ENDPOINT`, and BAML
 * resolves `env.*` references from `process.env` at CALL time (see the generated
 * `async_client.ts`: `{ ...process.env, ...options.env }`). Setting that
 * variable to the fake's base is therefore not a trick — it is what a developer
 * does when they run the deployment locally. Nothing in `src/` changes, the
 * `chat_template_kwargs` and `max_tokens` the client declares still go on the
 * wire, and `assertVerdaConfigured()` still runs its `/v1` check.
 *
 * ## The anthropic tier: a test-only client registry, and no new env switch
 *
 * There is no equivalent seam for the Anthropic chains, and adding one is the
 * option this file exists to avoid. A `base_url env.ANTHROPIC_BASE_URL` on the
 * leaves in `baml_src/clients.baml` would be a production configuration that
 * re-points production prompts at an arbitrary host — precisely the switch
 * ADR-0001 deleted on 2026-08-24 and the posture `SD-12` records. The eval
 * runner refused the same widening for the same reason (`app/evals/README.md`,
 * "How the client override works, and why it is not a new switch").
 *
 * So the redirection lives entirely here, in the test process, using BAML's own
 * `ClientRegistry`: a client the registry declares becomes the PRIMARY for any
 * call that does not name one. The generated functions merge instance options
 * under per-call options —
 *
 *   const __options__ = { ...this.bamlOptions, ...(__baml_options__ || {}) }
 *
 * — and then, if a per-call `client` string is present, apply it to that same
 * registry with `setPrimary`. Which gives exactly the split the suite needs:
 *
 *   - no override (the anthropic tier, and every role the switch never moves)
 *     → the registry's primary → the fake, reporting `FAKE_ANTHROPIC_TIER_MODEL`
 *   - `clientOverrideFor('controller')` → `setPrimary('VerdaQwen')` → the
 *     declaration in `baml_src/` → the fake, reporting `VERDA_MODEL`
 *
 * The registry is rebuilt PER CALL, through a getter, because `setPrimary` is a
 * mutation: one shared instance would keep `VerdaQwen` as primary after the
 * first verda-routed call, and every later anthropic-tier call would silently
 * be attributed to the wrong tier. That would not fail — it would produce a
 * green tier-switch scenario that proves nothing.
 *
 * ## What this does not do
 *
 * It does not touch `clients.server.ts`, `clientOverrideFor`, or any BAML file.
 * Production resolution runs untouched and is still consulted — the tier a turn
 * takes is decided by `resolveInferenceTier()` reading the user's stored
 * preference, exactly as it is in the app. All this changes is where the
 * resulting HTTP request lands.
 */

import { ClientRegistry } from '@boundaryml/baml'
import { FAKE_ANTHROPIC_TIER_MODEL, HERMETIC_ANTHROPIC_KEY } from './mode'

/** The registry-declared client name. Never appears in `baml_src/`. */
const FAKE_CLIENT = 'E2EFakeAnthropicTier'

/** The generated `b`, narrowed to the one field this module writes. */
type BamlSingleton = { bamlOptions?: unknown }

let installed = false

/**
 * Point every un-overridden BAML call at `baseUrl`.
 *
 * Idempotent, and deliberately not reversible: a suite that could un-install
 * the redirect could also half-install it, and "half" here means live calls.
 */
export function installHermeticRouting(b: unknown, baseUrl: string): void {
  if (installed) return
  const build = (): ClientRegistry => {
    const registry = new ClientRegistry()
    registry.addLlmClient(FAKE_CLIENT, 'openai-generic', {
      base_url: baseUrl,
      api_key: HERMETIC_ANTHROPIC_KEY,
      model: FAKE_ANTHROPIC_TIER_MODEL,
    })
    registry.setPrimary(FAKE_CLIENT)
    return registry
  }
  Object.defineProperty(b as BamlSingleton, 'bamlOptions', {
    get: () => ({ clientRegistry: build() }),
    configurable: true,
  })
  installed = true
}

/**
 * Prove the redirect took, before a single scenario runs.
 *
 * A silent no-op here is the one failure that would turn this suite into a
 * source of real, billed, prompt-leaking calls, so it is checked by OBSERVATION
 * — a real BAML call has to arrive at the fake — rather than by trusting that
 * `Object.defineProperty` did what it says. `mode.ts` also poisons
 * `ANTHROPIC_API_KEY` so the failure mode of a failed check is a 401 rather
 * than a completed request.
 *
 * @param call     Makes one cheap BAML call through the app's own client.
 * @param served   How many requests the fake has recorded so far.
 */
export async function assertHermeticRouting(
  call: () => Promise<unknown>,
  served: () => number,
): Promise<void> {
  const before = served()
  await call()
  const after = served()
  if (after <= before) {
    throw new Error(
      'e2e preflight: a BAML call completed WITHOUT reaching the fake endpoint. The hermetic ' +
        'client registry did not install (a @boundaryml/baml upgrade may have renamed the ' +
        "generated client's options field). Refusing to run: every scenario would otherwise " +
        'issue real provider calls. See e2e/lib/baml-route.ts.',
    )
  }
}
