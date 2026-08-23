/**
 * Client overrides — Server Only
 *
 * Single source of truth for per-call BAML client overrides.
 *
 * **Default behaviour:** every BAML function's declared client in `baml_src/`
 * is the Anthropic-only variant (`ControllerAnthropic`, `CriticAnthropic`,
 * etc.). The runtime override is `undefined` — no swap happens.
 *
 * **`USE_MIXED_CHAINS=1`:** the override returns the function's mixed-provider
 * fallback (`ControllerFallback`, `CriticFallback`, etc.) defined in
 * `baml_src/clients.baml`. Call sites spread the override into the BAML
 * options bag to swap at runtime. Production deployments and occasional
 * mixed-chain testing both go through this. Two roles opt out — `planner` and
 * `screen` pin their Anthropic clients in both modes; the reasons are on the
 * map entries.
 *
 * Why default to Anthropic: cross-provider rate limits (Groq + OpenRouter +
 * OpenAI) interfered too much during dev iteration of multi-turn / actorCritic
 * scenarios. See `SCRATCHPAD.md` P1.5 for context.
 */

import { assertServerOnImport } from './assert.server'

assertServerOnImport()

export type BamlRole =
  | 'controller' // ActorController + LoopController
  | 'planner' // Planner
  | 'critic' // Critic
  | 'compactExecution' // Synthesize
  | 'router' // Router
  | 'describe' // ResultDescribe + GenerateConversationTitle + ReferenceSelector
  | 'screen' // ScreenUntrustedContent (withInjectionGuard's opt-in LLM layer)

const MIXED_CLIENT_BY_ROLE: Record<BamlRole, string> = {
  controller: 'ControllerFallback',
  // The planner does NOT join the mixed chains — it stays on the client
  // planner.baml declares, in both modes.
  //
  // Why not `ControllerFallback` (which it used to borrow, as the same
  // "reason over a tool catalog, emit structured output" workload): that
  // chain's Groq `gpt-oss-120b` is the one client documented to fail
  // structured output on larger context, which is exactly why BOTH controller
  // adapters carry a manual GroqGPT120B → GroqFast escalation on
  // `BamlValidationError`. The planner has no such ladder — it runs ONCE per
  // chain, over `tools.all` (the largest catalog in the repo), so it is the
  // likeliest call to hit that failure and the least able to absorb it: it
  // just throws, and the chain silently runs unplanned. Pinning the declared
  // Anthropic client is the smaller, simpler correction; the planner's share
  // of a mixed-provider budget is one call per conversation turn anyway.
  planner: 'PlannerAnthropic',
  critic: 'CriticFallback',
  compactExecution: 'SynthesizerFallback',
  router: 'RouterFallback',
  describe: 'DescribeFallback',
  // The injection screen does NOT join the mixed chains either — pinned like
  // the planner, but for a security reason rather than a reliability one. It
  // used to ride the `describe` role, which under USE_MIXED_CHAINS=1 silently
  // put prompt-injection screening on DescribeFallback's first leaf (GroqFast,
  // the weakest model in the repo) while the guard's docs promised
  // DescribeAnthropic. The screen is only worth running on a model that (a)
  // cannot be talked out of reporting by the very content it reviews and (b)
  // copies `spans` VERBATIM — the guard locates and neutralizes them
  // character-for-character, so a paraphrased span is a missed injection.
  // Both properties are exactly what the weakest model is worst at. The cost
  // of pinning is one Haiku-tier call per otherwise-clean untrusted result on
  // agents that opted in — screening was never on the default path. (SA-M5)
  screen: 'DescribeAnthropic',
}

/** The BAML-declared (default) client per role — the Anthropic-only chain each
 *  function declares in `baml_src/`. Used to resolve the *actual* model behind
 *  a call when no mixed-chain override is active. Keep in sync with the
 *  `client X` lines in baml_src/*.baml. */
const DECLARED_CLIENT_BY_ROLE: Record<BamlRole, string> = {
  controller: 'ControllerAnthropic',
  planner: 'PlannerAnthropic',
  critic: 'CriticAnthropic',
  compactExecution: 'SynthesizerAnthropic',
  router: 'RouterAnthropic',
  describe: 'DescribeAnthropic',
  screen: 'DescribeAnthropic', // injection-screen.baml's declared client
}

/**
 * Returns `{ client: 'XFallback' }` when `USE_MIXED_CHAINS=1` is set,
 * otherwise `undefined` — letting the BAML function fall through to its
 * declared client (the Anthropic variant).
 *
 * Spread the result into the BAML call's options bag:
 *   await b.ActorController(..., { ...(collector ? { collector } : {}), ...clientOverrideFor('controller') })
 *
 * The adapter's manual `BamlValidationError` fallback (Groq → Groq) only
 * fires when the override IS active — it's only useful inside the mixed
 * chain where Groq's structured-output issues actually surface.
 */
export function clientOverrideFor(role: BamlRole): { client: string } | undefined {
  if (process.env.USE_MIXED_CHAINS !== '1') return undefined
  return { client: MIXED_CLIENT_BY_ROLE[role] }
}

/**
 * The client BAML will actually use for `role` right now: the mixed-chain
 * override when `USE_MIXED_CHAINS=1`, else the function's declared Anthropic
 * client. Patterns use this to look up the real model's context window for
 * prompt trimming (`getContextWindow(resolveClientForRole(role))`) instead of
 * hardcoding the `*Fallback` label — which, when missing from
 * `MODEL_CONTEXT_WINDOWS`, silently defaulted to 16K and over-trimmed prompts.
 */
export function resolveClientForRole(role: BamlRole): string {
  return clientOverrideFor(role)?.client ?? DECLARED_CLIENT_BY_ROLE[role]
}
