/**
 * Client resolution — Server Only
 *
 * Mostly a read-only MIRROR of which BAML client each role runs on: the
 * `client X` line on each function in `baml_src/` is what routes a call, and
 * `CLIENT_BY_ROLE` only restates it for prompt budgeting (see "budgeting, not
 * routing" on that map below). The ONE exception is `clientOverrideFor()`,
 * which really does route — it returns a per-call `client` override that a
 * call site spreads into its BAML options bag, and it is non-empty only while
 * `USE_VERDA_INFERENCE=1` (below).
 *
 * Every BAML function declares an Anthropic-only chain in `baml_src/` —
 * `ControllerAnthropic`, `CriticAnthropic`, and so on. That is what runs
 * unless a single opt-in env flag says otherwise (see `USE_VERDA_INFERENCE`
 * below); no other configuration re-points a call. The mixed-provider chains
 * that used to be swapped in by `USE_MIXED_CHAINS=1` (`ControllerFallback` &c.
 * across Groq / OpenRouter / OpenAI) were removed 2026-08-24 — their combined
 * rate limits made dev iteration too noisy, and one provider is also one
 * processor to paper. See ADR-0001.
 *
 * What survives is the role → client map below, which is how callers learn the
 * name of the model actually behind a call (its context window, its output
 * cap) without hardcoding a client name at the call site. A future provider —
 * a local or self-hosted chain — slots in by re-pointing the `client` lines in
 * `baml_src/` AND updating this map to match; the map alone would only
 * re-budget prompts for a model no call actually reaches.
 *
 * **`USE_VERDA_INFERENCE=1`** takes the other seam — a per-call `client`
 * override, so no `client` line moves and the default posture is one env var
 * away in both directions. It re-points the roles in
 * `VERDA_CLIENT_BY_ROLE` at `VerdaQwen`, the
 * company-hosted vLLM deployment declared in `baml_src/verda-client.baml`.
 * Confidential compute is the point — those prompts stay on infrastructure the
 * company controls. Three properties are deliberate:
 *
 * - **All-or-nothing.** The flag routes every mapped role for the whole
 *   process. There is no per-call, per-agent or sampling variant, because the
 *   endpoint scales to zero and billing follows activity: one warm box for a
 *   session is cheaper than a cold start per stray call.
 * - **Unset changes nothing.** `clientOverrideFor()` returns `undefined`, no
 *   options bag gains a `client` key, and every function runs the Anthropic
 *   chain it declares. The default posture is untouched.
 * - **Misconfiguration fails closed, loudly.** A flag that is on with a
 *   missing or malformed endpoint throws at module load rather than falling
 *   back to Anthropic: a silent fallback would send confidential prompts to
 *   the provider the operator just asked to avoid, which is the one failure
 *   this flag exists to prevent.
 *
 * Roles NOT in the Verda map still call Anthropic while the flag is on — the
 * flag is a routing switch, not a "no prompt leaves the building" guarantee.
 * `describe` in particular sees raw tool results. Widening the map is an owner
 * decision; see the note on the map itself.
 */

import { assertServerOnImport } from './assert.server'

assertServerOnImport()

export type BamlRole =
  | 'controller' // ActorController + LoopController
  | 'planner' // Planner
  | 'critic' // Critic
  | 'compactExecution' // Synthesize
  | 'router' // Router
  // The summarization tier — SIX functions. The canonical list (and the
  // seventh function, `screen`, that shares the chain) is on the
  // DescribeAnthropic block in baml_src/anthropic-only.baml.
  | 'describe'
  | 'screen' // ScreenUntrustedContent (withInjectionGuard's opt-in LLM layer)

/** The BAML-declared client per role — the Anthropic-only chain each function
 *  declares in `baml_src/`. Keep in sync with the `client X` lines there.
 *
 *  BUDGETING, NOT ROUTING. Every reader of this map feeds the name to
 *  `getContextWindow()` or `CLIENT_MAX_OUTPUT_TOKENS`; none of them passes a
 *  client to BAML. Changing an entry therefore re-sizes prompts and describe
 *  batches for a model the calls do not go to — a silent mis-budget, not a
 *  re-point. The re-point is the `client` line in `baml_src/`; this map is the
 *  mirror that has to follow it. */
const CLIENT_BY_ROLE: Record<BamlRole, string> = {
  controller: 'ControllerAnthropic',
  planner: 'PlannerAnthropic',
  critic: 'CriticAnthropic',
  compactExecution: 'SynthesizerAnthropic',
  router: 'RouterAnthropic',
  describe: 'DescribeAnthropic',
  // The injection screen has its OWN role rather than riding `describe`, and
  // that separation is load-bearing even with one provider left: a screen is
  // only worth running on a model that (a) cannot be talked out of reporting
  // by the very content it reviews and (b) copies `spans` VERBATIM — the guard
  // locates and neutralizes them character-for-character, so a paraphrased
  // span is a missed injection. Both are what a cheap summarization model is
  // worst at, and `describe` is the role most likely to be re-pointed at one.
  // (SA-M5). NOTE the asymmetry: the separation exists only HERE. In BAML both
  // roles name the same `DescribeAnthropic` chain, so re-pointing that chain
  // moves the screen too — see the block on it in anthropic-only.baml.
  screen: 'DescribeAnthropic', // injection-screen.baml's declared client
}

/**
 * The roles `USE_VERDA_INFERENCE=1` re-points at the self-hosted Verda
 * deployment (`baml_src/verda-client.baml`).
 *
 * A role that is absent keeps its Anthropic chain even with the flag on, and
 * that is a live choice rather than an oversight:
 *
 * - `router` and `describe` stay Anthropic because they are the short, cheap,
 *   high-frequency calls — a Haiku-tier classification and a per-result
 *   summary — and pointing them at a single scale-to-zero box makes it the
 *   latency floor of every turn.
 * - `screen` stays Anthropic for the SA-M5 reason on `CLIENT_BY_ROLE` above:
 *   the injection screen is only worth running on a model that cannot be
 *   talked out of reporting, and this one is unmeasured on that.
 * - `planner` stays Anthropic because it runs once per chain over the largest
 *   tool catalog in the repo and just throws when structured output fails —
 *   the same reason it opted out of the old mixed chains.
 *
 * The consequence to keep in view: with the flag on, prompts still reach
 * Anthropic through those roles, and `describe` is handed tool results
 * verbatim. Whether the confidential-compute posture wants them here too is a
 * processor decision, not a config tidy-up.
 *
 * ADDING A ROLE HERE IS NOT ENOUGH ON ITS OWN — the call site for that role
 * must also spread `clientOverrideFor(role)` into its BAML options bag, or the
 * entry reads like routing and changes nothing. `clients-verda.test.ts` pins
 * that both halves exist for every role in this map.
 */
const VERDA_CLIENT_BY_ROLE: Partial<Record<BamlRole, string>> = {
  controller: 'VerdaQwen', // LoopController + ActorController
  critic: 'VerdaQwen',
  compactExecution: 'VerdaQwen', // Synthesize
}

/** `USE_VERDA_INFERENCE=1` — the one switch that moves traffic to the
 *  self-hosted deployment. Read per call rather than cached at module load so
 *  a test (and a script that sets it before importing a pattern) sees it. */
export function verdaInferenceEnabled(): boolean {
  return process.env.USE_VERDA_INFERENCE === '1'
}

/**
 * Throws unless the Verda endpoint is configured well enough to reach.
 *
 * FAIL CLOSED, and deliberately: the alternative — warn, then let BAML fall
 * through to the declared Anthropic client — would silently route
 * confidential-compute traffic to the provider the flag exists to avoid, and
 * nothing downstream would look wrong. A boot-time throw is the loud version
 * of the same information.
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

// Checked once, at module load, and only when the flag is on: a misconfigured
// endpoint should stop the process rather than surface as a 404 on the first
// controller turn of someone's conversation. Costs nothing on the default path.
if (verdaInferenceEnabled()) assertVerdaConfigured()

/**
 * `{ client: 'VerdaQwen' }` for a Verda-routed role while
 * `USE_VERDA_INFERENCE=1`, otherwise `undefined` — letting the BAML function
 * fall through to the Anthropic chain it declares.
 *
 * Spread the result into the BAML call's options bag, and branch on whether
 * the bag ended up empty rather than on `collector`:
 *
 *   const opts = { ...(collector ? { collector } : {}), ...clientOverrideFor('controller') }
 *   const hasOpts = Object.keys(opts).length > 0
 *
 * The generated BAML functions take their arguments POSITIONALLY, so passing
 * an empty `{}` where the old code passed nothing is not equivalent — hence
 * the branch (#154).
 */
export function clientOverrideFor(role: BamlRole): { client: string } | undefined {
  if (!verdaInferenceEnabled()) return undefined
  const client = VERDA_CLIENT_BY_ROLE[role]
  return client ? { client } : undefined
}

/**
 * The client BAML uses for `role`. Patterns look up the real model's context
 * window for prompt trimming through this (`getContextWindow(resolveClientForRole(role))`)
 * and `compactBulkData` sizes its batches off the matching output cap, rather
 * than hardcoding a chain name that can silently miss `MODEL_CONTEXT_WINDOWS`
 * and default to 16K.
 *
 * It reports the OVERRIDE when one is active, so a Verda-routed role trims
 * against VerdaQwen's 131K window instead of Anthropic's 200K — over-trimming
 * costs context, under-trimming costs the whole call.
 */
export function resolveClientForRole(role: BamlRole): string {
  return clientOverrideFor(role)?.client ?? CLIENT_BY_ROLE[role]
}
