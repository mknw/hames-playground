/**
 * Client resolution — Server Only
 *
 * A read-only MIRROR of which BAML client each role runs on. It does not route
 * anything: the `client X` line on each function in `baml_src/` is what routes
 * a call, and nothing here overrides it. See "budgeting, not routing" on
 * CLIENT_BY_ROLE below.
 *
 * Every BAML function declares an Anthropic-only chain in `baml_src/` —
 * `ControllerAnthropic`, `CriticAnthropic`, and so on. Nothing overrides it at
 * runtime: Anthropic is the only provider. The mixed-provider chains that used
 * to be swapped in by `USE_MIXED_CHAINS=1` (`ControllerFallback` &c. across
 * Groq / OpenRouter / OpenAI) were removed 2026-08-24 — their combined rate
 * limits made dev iteration too noisy, and one provider is also one processor
 * to paper. See ADR-0001.
 *
 * What survives is the role → client map below, which is how callers learn the
 * name of the model actually behind a call (its context window, its output
 * cap) without hardcoding a client name at the call site. A future provider —
 * a local or self-hosted chain — slots in by re-pointing the `client` lines in
 * `baml_src/` AND updating this map to match; the map alone would only
 * re-budget prompts for a model no call actually reaches.
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
 * The client BAML uses for `role`. Patterns look up the real model's context
 * window for prompt trimming through this (`getContextWindow(resolveClientForRole(role))`)
 * and `compactBulkData` sizes its batches off the matching output cap, rather
 * than hardcoding a chain name that can silently miss `MODEL_CONTEXT_WINDOWS`
 * and default to 16K.
 */
export function resolveClientForRole(role: BamlRole): string {
  return CLIENT_BY_ROLE[role]
}
