/**
 * Dev-only inference redirect — the seam the BROWSER e2e layer reaches through.
 *
 * ## The problem this exists for
 *
 * `app/e2e/` drives the app path in-process, so it can redirect BAML by simply
 * installing a `ClientRegistry` on the generated client it imported
 * (`e2e/lib/baml-route.ts` explains why a registry and not an env var: a
 * `base_url env.ANTHROPIC_BASE_URL` in `baml_src/clients.baml` would be a
 * PRODUCTION configuration that re-points production prompts at an arbitrary
 * host — the switch ADR-0001 deleted, and the posture `SD-12` records).
 *
 * `app/e2e-browser/` cannot do that. The app runs in its own process, behind a
 * real dev server, driven by a real browser; the suite has no handle on the
 * `b` that process constructed. And it cannot simply run every turn on the
 * self-hosted tier and reach the fake through `VerdaQwen`'s shipped
 * `base_url env.VERDA_INFERENCE_ENDPOINT` seam either, because the tier switch
 * moves exactly the roles in `VERDA_CLIENT_BY_ROLE` — a verda-tier turn still
 * makes its `router` / `describe` / `screen` / `planner` and title calls on the
 * Anthropic chains they declare. Without this module those calls leave the
 * machine, on the developer's own key, from a suite advertised as hermetic.
 *
 * So the redirect has to be installed from INSIDE the server process, which
 * means one dev-only module in `src/`. That is the entire justification, and
 * the shape is copied deliberately from the one piece of precedent this repo
 * already has for "a test needs the real server to behave differently":
 * `lib/auth/dev-bypass.ts` (`SD-15`).
 *
 * ## Why this is not the switch ADR-0001 deleted
 *
 * Both gates below must pass, and the FIRST is a compile-time constant:
 *
 *   1. `import.meta.env.DEV` — Vite statically replaces this with `false` in a
 *      production build, so this branch (and the `ClientRegistry` it builds) is
 *      dead code eliminated out of the bundle `pnpm build` produces. There is
 *      no production configuration that can turn it on, which is precisely the
 *      property `base_url env.ANTHROPIC_BASE_URL` would NOT have had.
 *   2. `E2E_FAKE_INFERENCE_URL` — the explicit opt-in, read from
 *      `process.env` rather than `import.meta.env` because this module is
 *      server-only and nothing in the browser bundle may learn the value.
 *
 * `browser-e2e-not-in-ci.test.ts` pins both gates, and
 * `dev-fake-inference.test.ts` pins that a missing opt-in installs nothing.
 *
 * ## What it changes, and what it does not
 *
 * A `ClientRegistry` primary answers any call that does not name a client. A
 * per-call `client` override — which is how `clientOverrideFor()` routes the
 * self-hosted tier — still wins over it, so `resolveInferenceTier()` and the
 * whole tier mechanism run untouched and are still consulted. All this changes
 * is where the resulting HTTP request lands:
 *
 *   - no override (the anthropic tier, and every role the switch never moves)
 *     → the registry's primary → the fake, reporting `FAKE_ANTHROPIC_TIER_MODEL`
 *   - `clientOverrideFor('controller')` → `setPrimary('VerdaQwen')` → the
 *     declaration in `baml_src/verda-client.baml` → the fake, reporting the
 *     self-hosted model id
 *
 * which is the split the browser suite's routing assertions read.
 *
 * The registry is rebuilt PER CALL, through a getter, because `setPrimary` is a
 * mutation: one shared instance would keep `VerdaQwen` as primary after the
 * first verda-routed call and every later anthropic-tier call would silently be
 * attributed to the wrong tier — a green tier-switch scenario proving nothing.
 */

import { assertServerOnImport } from '../harness-patterns/assert.server'

assertServerOnImport()

/**
 * The client name the registry declares. Never appears in `baml_src/`, and the
 * browser suite reads it back off the fake's recorded `model` field as direct
 * evidence that a call took the Anthropic-chain route.
 */
export const DEV_FAKE_CLIENT = 'DevFakeInference'

/** The `model` the fake client reports. Mirrored by `e2e-browser/lib/env.ts`. */
export const DEV_FAKE_MODEL = 'e2e-fake-anthropic-tier'

/**
 * The fake endpoint's OpenAI-compatible base, or `null` when the redirect is
 * off — which is every ordinary `pnpm dev`, and every production build.
 */
export function devFakeInferenceUrl(): string | null {
  if (import.meta.env.DEV !== true) return null
  const url = process.env.E2E_FAKE_INFERENCE_URL?.trim()
  return url ? url : null
}

/** The generated `b`, narrowed to the one field this module writes. */
type BamlSingleton = { bamlOptions?: unknown }

let installed = false

/**
 * Point every un-overridden BAML call at the fake, if both gates pass.
 *
 * Returns what it did, so the caller can say so in the log rather than leaving
 * a developer to guess whether a "hermetic" browser run was hermetic. Callers
 * must treat `false` as "the app will call real providers".
 *
 * Idempotent, and deliberately not reversible: a redirect that could be
 * un-installed could also be half-installed, and "half" here means live calls.
 *
 * ASYNC, and `ClientRegistry` is imported inside rather than at the top of this
 * module, for a reason that is not style: a static `@boundaryml/baml` import
 * here reaches the server ENTRY chunk through `src/middleware.ts`, and nitro
 * then links the native runtime into `.output/server/index.mjs` — where a
 * production container dies at boot with `Cannot find module
 * '…/@boundaryml/baml/native'` before serving a request. Nothing else in
 * `src/` imports BAML at module scope either (`const { b } = await import(…)`
 * is the house idiom); this module has to follow it, and `pnpm build` will not
 * tell you when it stops. CI's `docker image · build · boot` job is what does.
 */
export async function installDevFakeInference(b: unknown): Promise<boolean> {
  const baseUrl = devFakeInferenceUrl()
  if (!baseUrl) return false
  if (installed) return true

  const { ClientRegistry } = await import('@boundaryml/baml')
  const build = (): InstanceType<typeof ClientRegistry> => {
    const registry = new ClientRegistry()
    registry.addLlmClient(DEV_FAKE_CLIENT, 'openai-generic', {
      base_url: baseUrl,
      // Never the developer's key: a request that somehow escaped the redirect
      // must fail with a loud 401 rather than succeed and bill someone.
      api_key: 'e2e-browser-no-real-provider-calls',
      model: DEV_FAKE_MODEL,
    })
    registry.setPrimary(DEV_FAKE_CLIENT)
    return registry
  }

  Object.defineProperty(b as BamlSingleton, 'bamlOptions', {
    get: () => ({ clientRegistry: build() }),
    configurable: true,
  })
  installed = true
  console.warn(
    `[dev-fake-inference] BAML is redirected to ${baseUrl}. No call reaches a real ` +
      'provider. This is dev-only (import.meta.env.DEV) and is compiled out of production builds.',
  )
  return true
}

// Surface the leakage path, exactly as `dev-bypass.ts` does for its own: a
// production build with the opt-in still set. `devFakeInferenceUrl()` already
// returns null there (the DEV gate), but a silent no-op would hide a
// misconfiguration — and this one's silent failure mode is real provider
// traffic from something a developer believed was faked.
if (import.meta.env.DEV !== true && process.env.E2E_FAKE_INFERENCE_URL) {
  console.warn(
    '[dev-fake-inference] E2E_FAKE_INFERENCE_URL is set in a production build. The redirect ' +
      'is ignored (gated on import.meta.env.DEV) and every BAML call goes to its real provider.',
  )
}
