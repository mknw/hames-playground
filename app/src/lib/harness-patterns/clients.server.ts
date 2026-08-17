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
 * mixed-chain testing both go through this. One role opts out — the `planner`
 * pins its Anthropic client in both modes; the reason is on the map entry.
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
