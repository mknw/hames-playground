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
 * - **All-or-nothing per RUN.** A tier decision routes every mapped role for
 *   the whole turn — there is still no per-call, per-agent or sampling
 *   variant, because the endpoint scales to zero and billing follows activity:
 *   one warm box for a session is cheaper than a cold start per stray call.
 *   What changed for the preview (2026-08-25) is the *granularity of the
 *   decision*, not its scope: `runWithInferenceTier()` below opens an
 *   AsyncLocalStorage scope so one user's turn can run on a different tier
 *   than another's, while everything inside that turn stays on one tier.
 *   `USE_VERDA_INFERENCE` remains the process default for anything running
 *   outside such a scope.
 * - **Unset changes nothing.** With no flag and no scope, `clientOverrideFor()`
 *   returns `undefined`, no options bag gains a `client` key, and every
 *   function runs the Anthropic chain it declares. The default posture is
 *   untouched.
 * - **Misconfiguration fails closed, loudly.** A flag that is on with a
 *   missing or malformed endpoint throws at module load rather than falling
 *   back to Anthropic: a silent fallback would send confidential prompts to
 *   the provider the operator just asked to avoid, which is the one failure
 *   this flag exists to prevent.
 *
 * EVERY role is in the Verda map — there is no longer an exception. `router`,
 * `planner` and `describe` were held out until 2026-08-26 on latency and cost
 * grounds; the owner overruled that (the router is handed the user's raw
 * message and describe is handed tool results verbatim). `screen`, the
 * injection screen, was held out on the separate SD-4 / SA-M5 grounds below,
 * and the owner overruled THAT the same day, in these terms: **no call made
 * under the private tier may be sent to any public AI provider** (owner
 * decision 2026-08-26, answer 7; no exception was sought).
 *
 * So a verda-tier turn now sends NO BAML call off the box. Two things that
 * claim does not cover, stated rather than rounded off:
 *
 * - It is about MODEL calls routed through this file. `EMBEDDINGS_PROVIDER`
 *   (`docs/DATA_STASH.md`) has its own route and its `openrouter` setting would
 *   send the user's query text to a third party; the default is `local`, so the
 *   claim holds as shipped, but it is a different seam.
 * - The screen's move buys the posture and costs a MEASUREMENT: `VerdaQwen` is
 *   unmeasured on the two properties a screener needs (see the map entry). The
 *   trade was made knowingly, so the honest record is "accepted, unmeasured,
 *   measurable" — the eval suite's `screen-on-the-tier` scenario is where the
 *   measurement lands, not a promise in a comment.
 *
 * **The private tier is TWO models, not one** (owner decision 2026-08-26). The
 * heavy roles take `VerdaQwen`, the 27B; `describe` takes `LocalQwenSmall`, the
 * 4B summarizer reached over `SMALL_LLM_BASE_URL` (the #256 env-vars-only
 * contract — "local" names the wire format, not the machine). Summarization is
 * the highest-frequency, lowest-value call in the repo and it was making a
 * scale-to-zero 27B the latency floor of every tool result; the 4B is the model
 * the role was designed around (`baml_src/local-client.baml`). What did NOT
 * follow it is the `screen`, which stays on the 27B: SD-4's separation exists so
 * that a describe flip cannot carry prompt-injection screening onto a 4B, and
 * this is the flip it was written for.
 *
 * Which makes the tier's configuration a CONJUNCTION, and the failure loud:
 * `assertPrivateTierConfigured` (in `lib/inference/config.server.ts`) demands
 * both endpoints. A private tier
 * with no small endpoint does not descale describe back onto the 27B — that
 * would be a routing change nobody asked for, made silently, on the role handed
 * tool results verbatim (SD-10). It refuses the tier instead.
 *
 * ## The host seam (PR-1a of the #225 extraction)
 *
 * This module is package-shaped: it ships in v1 and must not import host-app
 * code — an installed tarball cannot resolve it (the same exit criterion
 * #342/#346 gave `harness-patterns`). So everything APP-side it used to reach
 * for directly — the model tables, the `USE_VERDA_INFERENCE` env default, the
 * endpoint asserts, the cold-start wake hook, the EUR rates — is FED IN instead:
 * the host calls the three `configure*` accessors below at its composition root
 * (`lib/inference/config.server.ts`), and this module reads them through
 * module-level accessors with safe package-side defaults. Mirroring #342's
 * shape: the host opens a scope or passes config; the module never imports back
 * into host policy. The scope the tier rides is `runWithInferenceTier` below —
 * the host opens it through THIS module's own export, so the store and its
 * readers are the same module instance by construction, pinned by
 * `clients-seam.test.ts` (red under the dual-instance mutation).
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { assertServerOnImport } from '@hames/harness-patterns/assert.server'
import type { ModelLimits, CostBasis } from '@hames/harness-patterns/types'
// TYPE-ONLY by design: this module owns the routing seam and reads the
// consumer layer's SHAPE, while `consumer-clients.server.ts` imports the seam
// itself. A value import here would make the consumer module load whenever the
// tier module does — the direction the #225 extraction already ruled out for
// host code, applied one hop closer to the package.
import type { BamlClientOverride, ClientOverride } from './consumer-clients.server'

assertServerOnImport()

/**
 * Which inference tier a run is on.
 *
 * MOVED here from `lib/inference/config.server.ts` (PR-1a): the tier scope
 * below is this module's seam, so its vocabulary is package-side — the union
 * cannot stay host-side without a host import, which is the one direction the
 * extraction forbids. `config.server.ts` re-exports it, so every existing
 * importer keeps its import path.
 *
 * `'verda'` is the self-hosted deployment (`VERDA_CLIENT_BY_ROLE` below);
 * `'anthropic'` is "no override at all", i.e. every function runs the chain it
 * declares. Named rather than boolean because it reaches the browser — a
 * header control shows the user which one their chats are on, and a label is
 * what a preview user can act on.
 */
export type InferenceTier = 'verda' | 'anthropic'

// ============================================================================
// THE HOST SEAM — where the app's configuration is FED IN (PR-1a)
//
// Three `configure*` accessors, called ONCE at the host's composition root
// (`lib/inference/config.server.ts`). Each store starts from a safe
// package-side default so an unregistered consumer degrades loudly or
// harmlessly rather than mis-routing:
//
// - model tables: unknown clients already fell through (`getContextWindow`
//   → 16 384, `limitsFor` → undefined cap), so empty tables degrade the same
//   way an unknown client name always did;
// - tier policy: the default tier is 'anthropic' (no confidential traffic
//   without registration) and a 'verda' scope with no reachability assert is
//   REFUSED, not opened — fail closed, like every gate on this tier;
// - wake hook: absent means no notice, a degraded UX but never a wrong route;
// - cost rates: the two literal fallbacks below, pinned equal to the app's
//   `DEFAULT_EUR_PER_USD` / `DEFAULT_VERDA_EUR_PER_HOUR` by
//   `clients-seam.test.ts` so the copies cannot drift silently.
// ============================================================================

/** The two model tables the host feeds in — the VALUES of `settings.ts`'s
 *  `CLIENT_MAX_OUTPUT_TOKENS` and `MODEL_CONTEXT_WINDOWS`. The tables themselves
 *  stay host-side beside `baml_src/` (SA-C2: every leaf declaring `max_tokens`
 *  in `baml_src/` must be mirrored there, enforced by `client-output-caps.test.ts`);
 *  only the READING moved here (Lane A5's property — the pattern layer asks
 *  this seam, never the table). */
export interface ModelTables {
  maxOutputTokens: Readonly<Record<string, number | undefined>>
  contextWindows: Readonly<Record<string, number>>
}

let modelTables: ModelTables = { maxOutputTokens: {}, contextWindows: {} }

/** Feed the host's model tables in. Called once at the composition root. */
export function configureModelTables(tables: ModelTables): void {
  modelTables = tables
}

/** The app-policy half of the tier seam: what a run takes outside any scope,
 *  whether a 'verda' scope is reachable, and what to announce when a
 *  private-tier client is about to take a call. */
export interface InferenceTierPolicy {
  /** The tier outside any `runWithInferenceTier` scope (a script, a background
   *  job). The host reads `USE_VERDA_INFERENCE` here; the package-side default
   *  is 'anthropic' — the safe direction, never confidential traffic. */
  defaultTier: () => InferenceTier
  /** Fail-closed reachability check, run before a 'verda' scope opens (the
   *  host's `assertPrivateTierConfigured`).
   *  Unregistered → the scope is REFUSED, not opened. */
  assertTierReachable?: (tier: InferenceTier) => void
  /** A private-tier client (`VERDA_CLIENT_BY_ROLE`'s values) is about to take
   *  a call. The host decides what that means — the wake/cold-start notice
   *  filters on its own scale-to-zero client name here, keeping the "which
   *  client scales to zero" knowledge host-side. */
  onPrivateCallStart?: (client: string) => void
}

let tierPolicy: InferenceTierPolicy = { defaultTier: () => 'anthropic' }

/** Feed the host's tier policy in. Called once at the composition root. */
export function configureInferencePolicy(policy: InferenceTierPolicy): void {
  tierPolicy = policy
}

/** EUR rates the host bills under, read per call by `computeEventMetrics`
 *  (baml-adapters.server.ts) so an operator changing a rate mid-process is
 *  seen by the next step. */
export interface CostRates {
  eurPerUsd: () => number
  verdaEurPerHour: () => number
}

// Package-side fallbacks, deliberately LITERALS: settings.ts is client-safe
// and cannot be imported here (the extraction's one direction rule). Kept
// equal to the app's DEFAULT_EUR_PER_USD / DEFAULT_VERDA_EUR_PER_HOUR by
// clients-seam.test.ts — the same deliberate-copy-with-a-pin pattern as
// TIME_PRICED_CLIENT in settings.ts.
const SEAM_DEFAULT_EUR_PER_USD = 0.86
const SEAM_DEFAULT_VERDA_EUR_PER_HOUR = 1.819

let costRates: CostRates = {
  eurPerUsd: () => SEAM_DEFAULT_EUR_PER_USD,
  verdaEurPerHour: () => SEAM_DEFAULT_VERDA_EUR_PER_HOUR,
}

/** Feed the host's EUR rates in. Called once at the composition root. */
export function configureCostRates(rates: CostRates): void {
  costRates = rates
}

/** Internal accessors — `computeEventMetrics` reads these per step, not the
 *  configure functions, so an operator changing a rate mid-step prices two
 *  attempts of one call the same way. */
export function activeCostRates(): CostRates {
  return costRates
}

/** The cost ESTIMATOR the host registers — settings.ts's `estimateLlmCostEur`,
 *  whose CLIENT_PRICING table is app pricing config (SA-C2 family) and stays
 *  host-side beside the client-safe UI that renders it. Structural type: the
 *  host's function is assignable without sharing a nominal type. */
export interface CostEstimate {
  costEur: number
  noCacheEur: number
  basis: CostBasis
  rates?: { inPerMTok: number; outPerMTok: number }
  timeRate?: { eurPerHour: number; durationMs: number }
}

export type CostEstimator = (
  tokens: {
    inputUncachedTokens: number
    inputCacheReadTokens: number
    inputCacheWriteTokens: number
    outputTokens: number
  },
  clientName?: string,
  opts?: { durationMs?: number; eurPerUsd?: number; eurPerHour?: number },
) => CostEstimate | undefined

export interface CostPricing {
  estimate: CostEstimator
  /** The client billed by the second (settings.ts's `TIME_PRICED_CLIENT`).
   *  `computeEventMetrics` prices a usage-less attempt on this client against
   *  wall-clock rather than dropping it. Unregistered → no such client, so a
   *  usage-less attempt is dropped — registration is what restores the floor. */
  timePricedClient?: string
}

let costPricing: CostPricing = {
  estimate: () => undefined,
  timePricedClient: undefined,
}

/** Feed the host's cost estimator in. Called once at the composition root. */
export function configureCostPricing(pricing: CostPricing): void {
  costPricing = pricing
}

export function activeCostPricing(): CostPricing {
  return costPricing
}

// ---------------------------------------------------------------------------
// THE CONSUMER LAYER (issue #374 D1 — bring your own provider or model)
//
// One module-level `ClientOverride`, fed in by the host (or any consumer) via
// `configureConsumerClients` and composed ON TOP of the built-in tier inside
// `clientOverrideFor` below — the one function every adapter call site spreads
// and the one the reference host also feeds to the agents package as
// `AgentDeps.clientOverride`. Composition lives HERE, at the meeting point of
// the two routing paths, so the precedence is explicit rather than accidental:
//
//   - a role the consumer MAPS takes the consumer's client (registry + primary)
//     over the built-in tier, whatever the tier scope says;
//   - a role the consumer does not map falls through to `verdaClientFor`
//     untouched — the declared Anthropic chain, or the built-in private tier
//     under a Verda-tier scope;
//   - with no layer registered this module behaves exactly as it did before
//     the layer existed.
//
// The `screen` role is covered by the same rule by construction: `byRole` is
// keyed by role (SA-M5 / SD-4), so mapping `describe` never moves the screen.
let consumerClients: ClientOverride | undefined

/** Feed the consumer's client layer in (or clear it with `undefined`). Called
 *  once at the composition root, beside the other `configure*` accessors;
 *  `consumer-clients.server.ts`'s `activateConsumerClients` is the convenience
 *  wrapper that keeps the consumer's imports to one subpath. */
export function configureConsumerClients(override: ClientOverride | undefined): void {
  consumerClients = override
}

/** The active consumer layer, if any — introspection for tests and the frame
 *  lane's lift, not a second routing path. */
export function activeConsumerClients(): ClientOverride | undefined {
  return consumerClients
}

/** The LEAF output cap for a client name, from the host-fed table — the
 *  lookup `hitOutputCap` stamping uses (Lane A3). `undefined` for an unknown
 *  client, exactly as the table's own absence behaved. */
export function maxOutputTokensFor(clientName?: string): number | undefined {
  return clientName ? modelTables.maxOutputTokens[clientName] : undefined
}

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
  // the separation is UNCHANGED by the 2026-08-26 decision that moved both to
  // the self-hosted tier. What it protects is not "the screen stays on
  // Anthropic" — it never was. It is that the screen's client can only ever be
  // moved DELIBERATELY: a screen is only worth running on a model that (a)
  // cannot be talked out of reporting by the very content it reviews and (b)
  // copies `spans` VERBATIM — the guard locates and neutralizes them
  // character-for-character, so a paraphrased span is a missed injection. Both
  // are what a cheap summarization model is worst at, and `describe` is the
  // role most likely to be re-pointed at one. With one role, re-pointing
  // summarization would carry prompt-injection screening along as a side
  // effect; with two, moving the screen is its own line, its own owner
  // decision and its own eval scenario. That is exactly what happened
  // (SA-M5 / SD-4): `VERDA_CLIENT_BY_ROLE` below now names both roles, on the
  // record, rather than one edit having moved both.
  //
  // AND THEN THE HYPOTHETICAL HAPPENED. On 2026-08-26 `describe` was re-pointed
  // at `LocalQwenSmall` — a 4B summarizer — on the private tier, which is
  // literally the "re-pointed at a cheap summarization model" this comment had
  // been describing in the abstract since SA-M5. The screen did not move: it is
  // its own line naming `VerdaQwen`, a 27B. This is the role separation paying
  // for itself once, in production, and it is worth noting that the mechanism
  // that saved it was two map lines rather than any test — the tests pin the
  // outcome, the separation is what made the outcome possible to get right.
  //
  // NOTE the asymmetry that survives all of this: the separation exists only
  // HERE. In BAML both roles name the same `DescribeAnthropic` chain, so
  // re-pointing THAT chain still moves the screen implicitly — see the block on
  // it in anthropic-only.baml. The accident this role guards against is still
  // live; only the private tier's deliberate move is settled.
  screen: 'DescribeAnthropic', // injection-screen.baml's declared client
}

/**
 * The roles a verda tier decision re-points at the self-hosted deployment
 * (`baml_src/verda-client.baml`).
 *
 * EVERY role is here. That is the 2026-08-26 owner decision and
 * it replaced a narrower map: `router`, `planner` and `describe` were held out
 * on latency and cost grounds — short, cheap, high-frequency calls that would
 * make a scale-to-zero box the latency floor of every turn. The owner's
 * ruling was that the router was never a special case, and the exclusion cost
 * more than it bought: the router sees the user's raw message and `describe`
 * is handed tool results verbatim (SD-10 — those results can carry mail
 * bodies, calendar entries and file contents), so the private tier was
 * shipping off-box precisely the two payloads it exists to keep. Latency is a
 * preference; the leak was the posture.
 *
 * `screen` — the injection screen — was the last exception, and it is one no
 * longer. It was held back on the SA-M5 / SD-4 grounds recorded on
 * `CLIENT_BY_ROLE` above: `VerdaQwen` is unmeasured both on refusing to be
 * talked out of reporting by the content it reviews and on copying matched
 * spans VERBATIM, and a paraphrased span is a missed injection. The owner
 * settled it on 2026-08-26 (answer 7) on a rule that outranks the measurement
 * gap rather than dismissing it: **no call made under the private tier may be
 * sent to any public AI provider**, and no exception was sought. So the screen
 * moves, the trade is accepted, and the measurement is now OWED rather than
 * pending — the eval suite's `screen-on-the-tier` scenario is where it lands
 * (spans verbatim, injection still reported, on whichever client the run
 * routes). Read that scenario's report before concluding the screen works here.
 *
 * The role SEPARATION is untouched by this and must stay: it is what made this
 * an owner decision with its own line rather than a side effect of moving
 * summarization. See `CLIENT_BY_ROLE` above.
 *
 * NOT EVERY ROLE HERE NAMES THE SAME CLIENT, since 2026-08-26. `describe` names
 * `LocalQwenSmall`. Read the values, never the key set, when you want to know
 * where a role's calls land — `Object.keys(VERDA_CLIENT_BY_ROLE)` answers "does
 * the tier move this role", which is a different question and the one
 * `TIER_SWITCHED_FUNCTIONS` asks.
 *
 * ADDING A ROLE HERE IS NOT ENOUGH ON ITS OWN — the call site for that role
 * must also spread `clientOverrideFor(role)` into its BAML options bag, or the
 * entry reads like routing and changes nothing. `clients-verda.test.ts` pins
 * that both halves exist for every role in this map, `screen` included: the
 * scan that used to require `clientOverrideFor('screen')` to appear NOWHERE now
 * requires the map entry AND the spread inside `b.ScreenUntrustedContent(...)`'s
 * own argument list — extracted by balanced parens, not grepped, because a decoy
 * two statements below the call defeated the regex version. Removing either half
 * is red on its own.
 *
 * EXPORTED for the two consumers that need the VALUES rather than the keys:
 * `metrics/usage-recorder.server.ts` (which client names count as private-tier
 * traffic, so a describe call on the 4B is not counted as an Anthropic call) and
 * the tests that render one request per routed function and have to know which
 * client to render it against. Exported as a read-only type: it is not a seam,
 * and nothing may route through it directly — `clientOverrideFor` is the only
 * thing that routes, because it is the only thing that consults the active tier.
 */
export const VERDA_CLIENT_BY_ROLE: Readonly<Partial<Record<BamlRole, string>>> = {
  controller: 'VerdaQwen', // LoopController + ActorController
  critic: 'VerdaQwen',
  compactExecution: 'VerdaQwen', // Synthesize
  router: 'VerdaQwen',
  // THE COMPOSITE CONSEQUENCE OF THIS ONE LINE, stated whole because each piece
  // is individually mild and the set is not. This is the authoritative
  // statement; `CLAUDE.md`, `evals/client.ts` and `createPlannerAdapter` point
  // here rather than restating it.
  //
  //  1. `PlannerAnthropic`'s documented justification is "thinking left ON —
  //     the reasoning IS the deliverable". `VerdaQwen` declares
  //     `chat_template_kwargs { enable_thinking false }`, so on this tier that
  //     justification does not hold: the planner reasons without a thinking
  //     budget, in the same tokens as its output.
  //  2. Its output ceiling drops EIGHTFOLD — `AnthropicSonnet5`'s 32 768 to
  //     `VerdaQwen`'s 4 096 (the F2 timeout derivation on PR #279) — on
  //     the role whose output is longest, over the largest tool catalog in the
  //     repo (~134 tools in the preview deployment).
  //  3. Cap-hits are detected (`VerdaQwen` is in `CLIENT_MAX_OUTPUT_TOKENS`, so
  //     `planParseRetry` fires), but the recovery is ONE retry of the same
  //     prompt with guidance appended. A plan that truncated once on a halved
  //     ceiling truncates again, and then the adapter throws.
  //  4. `patterns/planner.server.ts` catches that throw, records an `error`
  //     event and CLEARS `scope.data.plan`, so the chain runs unplanned. The
  //     user gets a normal-looking answer from an executor that re-derives its
  //     approach every turn — the exact behaviour the planner exists to
  //     replace. Visible in the observability panel, invisible in the chat.
  //  5. It has no `getContextWindow(resolveClientForRole('planner'))` trim, so
  //     its INPUT is unbudgeted against the 131 072 ceiling — and it is the
  //     role where that bites, because the tool catalog IS its prompt. (It is
  //     not the only untrimmed role: `critic` has no trim either and the screen
  //     bounds itself by characters instead. Both take bounded inputs; the
  //     planner's grows with the gateway's tool count.) Headroom is real today
  //     — that catalog is tens of thousands of tokens, not 131k — and nothing
  //     holds it.
  //
  // Net: on this tier the planner degrades to "unplanned, quietly" rather than
  // to a visible failure, and until the eval suite's `planner-plan-shape`
  // scenario is run against a client, nothing measures 1–3. That scenario
  // exists precisely so this stops being four flags in four files.
  planner: 'VerdaQwen',
  // THE ONE ROLE ON THIS TIER THAT IS NOT THE 27B. Owner decision 2026-08-26,
  // and the composite consequence stated whole in the style of `planner:` above,
  // because three of the four pieces are improvements and the fourth is not.
  //
  //  1. LATENCY, which is why it moved. Six short high-frequency functions —
  //     per-result and batched summaries, run titles, intent compaction, the
  //     retriever's query rewrite, the citation picker — were queueing behind a
  //     single-replica scale-to-zero 27B. A turn with four tool results is four
  //     more calls into that queue, where concurrency is queueing rather than
  //     scaling (measured 2026-08-25, `smoke-verda-load.ts`).
  //  2. The POSTURE is unchanged, which is the only reason this is allowed at
  //     all: `SMALL_LLM_BASE_URL` is infrastructure the company runs, so the
  //     2026-08-26 rule — no call made under the private tier may be sent to any
  //     public AI provider — still holds, and it holds for the role that carries
  //     the most sensitive payload of the twelve (`describe` is handed tool
  //     results VERBATIM: mail bodies, calendar entries, file contents, SD-10).
  //  3. The OUTPUT CEILING drops 16 384 → 2 048 and the window 131 072 → 32 768.
  //     Both are already in `CLIENT_MAX_OUTPUT_TOKENS` / `MODEL_CONTEXT_WINDOWS`,
  //     so `resolveClientForRole('describe')` re-budgets automatically — which is
  //     the whole reason that mirror reports the override. The visible effect is
  //     `maxBatchItems()` returning 5 instead of 8, i.e. MORE describe calls per
  //     turn, each far cheaper and none of them on the queue in (1).
  //  4. COST is €0.00, on a basis of its own. `LocalQwenSmall` is in
  //     `LOCAL_PRICED_CLIENTS` (settings.ts) rather than in `CLIENT_PRICING` or
  //     `TIME_PRICED_CLIENT`, so a private-tier step that summarized a result
  //     renders an exact zero labelled "local" — not cost-unknown, which is what
  //     it read as until the owner settled this on 2026-08-26. The distinction is
  //     the whole decision: unknown means unmeasured, and a call served by a
  //     model process on infrastructure with no marginal bill is not unmeasured.
  //     It is a claim about the CLIENT, so moving that endpoint onto metered
  //     infrastructure means moving the client into the priced set — the same
  //     edit this map already requires.
  //
  // If `SMALL_LLM_BASE_URL` is unset the tier is REFUSED, not descaled — see
  // `assertPrivateTierConfigured` in lib/inference/config.server.ts.
  describe: 'LocalQwenSmall', // the six summarization functions
  // The composite consequence of THIS line, in the style the `planner:` entry
  // above sets: the screen now inherits the scale-to-zero LATENCY profile as
  // well as the routing. A guarded tool result can wait a 146s cold start — or
  // the client's 180s `request_timeout_ms`, or the platform's 55s 504 — before
  // `withInjectionGuard`'s fail-open gives up and records `screen unavailable:`
  // (`patterns/withInjectionGuard.server.ts`). The degradation IS emitted, so SD-4's
  // "recorded rather than hidden" still holds and the guard's own regex layer is
  // untouched by it; what the tier buys back is that no such payload leaves the
  // box. Blast radius is zero today because no agent enables the LLM screen.
  screen: 'VerdaQwen', // ScreenUntrustedContent — owner decision 2026-08-26, above
}

/**
 * The BAML functions behind each role the map above re-points.
 *
 * It exists so a consumer can ask "is THIS call one a tier decision moves?" —
 * the header's rolling latency compares the two tiers, and a window that also
 * held the roles running on Anthropic in *both* switch positions would compare
 * different role mixes rather than two models (`metrics/call-latency.server.ts`).
 *
 * Roles the switch never moves would be deliberately ABSENT rather than listed
 * as unmoved — nothing derived from this needs them — and as of the 2026-08-26
 * screen decision there are NONE: every role is here, so the derived set below
 * is every BAML function in the repo and the filter it feeds currently excludes
 * nothing. That is honest rather than redundant. The mechanism stays because it
 * is derived: pull a role back out of `VERDA_CLIENT_BY_ROLE` and the filter
 * starts excluding again with no second edit. The key set is pinned equal to
 * `VERDA_CLIENT_BY_ROLE`'s by `clients-verda.test.ts`, so a role added there
 * without its functions here fails CI instead of quietly dropping out of the
 * comparison.
 *
 * The `describe` list IS the second copy of a list whose canonical home is the
 * `DescribeAnthropic` block in `baml_src/anthropic-only.baml`, and there is no
 * way around that once the role moves: this file needs the function NAMES and
 * BAML has no export of them. `clients-verda.test.ts` reads the six `client
 * DescribeAnthropic` declarations out of `baml_src/` and pins them equal to
 * this array, which is what stops the copy drifting — and, more to the point,
 * what fails if a seventh describe function is added and forgotten here, since
 * that function would otherwise run on Anthropic through a turn the user asked
 * to keep on the box.
 */
export const SWITCHED_FUNCTIONS_BY_ROLE: Partial<Record<BamlRole, readonly string[]>> = {
  controller: ['LoopController', 'ActorController'],
  critic: ['Critic'],
  compactExecution: ['Synthesize'],
  router: ['Router'],
  planner: ['Planner'],
  describe: [
    'ResultDescribe',
    'ResultDescribeBatch',
    'GenerateConversationTitle',
    'CompactIntent',
    'RetrieveQuery',
    'ReferenceSelector',
  ],
  screen: ['ScreenUntrustedContent'],
}

/**
 * BAML function names a tier decision re-points, and therefore the only calls
 * whose duration means the same thing in both switch positions.
 *
 * Derived from `VERDA_CLIENT_BY_ROLE` — the authority on what moves — rather
 * than written out again, and independent of whether the flag or a scope is on:
 * the two windows have to hold the same role mix in every position, or neither
 * figure is comparable with the other.
 *
 * It followed the 2026-08-26 widening automatically, and the CONSEQUENCE did
 * not: the set went from four heavy functions to twelve, nine of which are
 * short cheap calls, so the median it filters for dropped — the same route,
 * measured over a different mix. The comparison it protects still holds
 * (everything in here moves with the switch, in both positions), and the
 * number beside the switch now answers "what does a model call on this tier
 * cost" over the whole moved mix rather than over the controller alone. The
 * header copy says "model call", which is what makes that readable.
 *
 * The screen decision later the same day made it ALL THIRTEEN, so the filter
 * this feeds now admits every call the app makes and the window is simply
 * "recent model calls per tier". Nothing about that is a change of meaning —
 * the invariant was always "the same role mix in both positions", and the
 * whole mix satisfies it trivially. It stops being trivial the moment a role
 * is pulled back out, which is why the filter stays.
 *
 * WHAT DID CHANGE THE MEANING is the describe flip: the private tier's window
 * now blends TWO models, and by call count the fast one dominates (six describe
 * functions on a 4B against six heavy ones on the 27B, and a turn makes more
 * describe calls than controller calls). So the private-tier median answers
 * "what does a model call on this tier cost" — which is what the header copy
 * says — and NOT "how fast is the self-hosted box". Those were the same number
 * until 2026-08-26 and are not any more. The invariant this set protects is
 * untouched: both positions still hold the same thirteen functions, so the two
 * medians still compare like with like.
 */
export const TIER_SWITCHED_FUNCTIONS: ReadonlySet<string> = new Set(
  (Object.keys(VERDA_CLIENT_BY_ROLE) as BamlRole[]).flatMap(
    (role) => SWITCHED_FUNCTIONS_BY_ROLE[role] ?? [],
  ),
)

const tierStore = new AsyncLocalStorage<InferenceTier>()

/**
 * Run `fn` with `tier` as the active inference tier for everything inside it.
 *
 * This is the per-user switch's only mechanism. A tier is a property of the
 * RUN, not of a call site, so it rides an AsyncLocalStorage scope exactly like
 * `settings-context.server.ts` and `injection-guard-scope.server.ts` do: the
 * turn runner opens one scope and every adapter deep inside the call graph
 * picks it up through `clientOverrideFor()` without a single signature change.
 *
 * FAIL CLOSED on `'verda'`: a scope that names the self-hosted tier is checked
 * through the host-registered `assertTierReachable` before anything runs, and
 * a scope opened with NO policy registered is REFUSED outright — the
 * fail-closed default, matching every other gate on this tier. The alternative
 * — shrug and let BAML fall through to the declared Anthropic chain — is the
 * one failure this whole route exists to prevent, and it is no less dangerous
 * for having come from a user's preference row rather than from an env var.
 */
export function runWithInferenceTier<T>(tier: InferenceTier, fn: () => Promise<T>): Promise<T> {
  if (tier === 'verda') {
    // Rejected, not thrown synchronously: this function's whole contract is
    // "hand me a callback, get a promise", and a caller that only wrote
    // `.catch()` would otherwise take the throw on the stack instead. `fn` is
    // deliberately never invoked — the check is before any prompt is built.
    const assertReachable = tierPolicy.assertTierReachable
    if (!assertReachable) {
      return Promise.reject(
        new Error(
          "The 'verda' inference tier was requested but no inference policy is registered. " +
            'The host registers one at its composition root (lib/inference/config.server.ts, ' +
            'via configureInferencePolicy); refusing rather than guessing is the fail-closed default.',
        ),
      )
    }
    try {
      assertReachable(tier)
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }
  return tierStore.run(tier, fn)
}

/**
 * The tier in force right now: the enclosing `runWithInferenceTier` scope, or
 * the deployment default when there is no scope (a script, a background job,
 * anything off the turn path).
 */
export function activeInferenceTier(): InferenceTier {
  return tierStore.getStore() ?? tierPolicy.defaultTier()
}

/**
 * `{ client: 'VerdaQwen' }` for a Verda-routed role while the active tier is
 * `'verda'` (a `runWithInferenceTier` scope, or `USE_VERDA_INFERENCE=1` as the
 * deployment default), otherwise `undefined` — letting the BAML function fall
 * through to the Anthropic chain it declares.
 *
 * Read at CALL time, not at scope entry, which is what makes one turn's tier
 * cover every adapter inside it without threading a parameter anywhere.
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
export function clientOverrideFor(role: BamlRole): BamlClientOverride | undefined {
  // THE COMPOSITION RULE, stated where it is enforced (pinned — see the
  // module's own test): the consumer's client wins over the built-in tier for
  // a role the consumer maps; everything else falls through unchanged. A
  // mapped role returns BEFORE the verda path, so the consumer's registry and
  // primary ride the options bag and the private-call hook below does not fire
  // — the consumer's client is not the private tier and owes nobody a wake.
  const consumerBag = consumerClients?.(role)
  if (consumerBag) return consumerBag
  const client = verdaClientFor(role)
  if (!client) return undefined
  // A bag naming a private-tier client is a call about to take the override —
  // #274 wrote this hook when the `router` still answered on Anthropic, so the
  // first bag of a turn belonged to the controller; the 2026-08-26 widening put
  // the router on the tier and the notice moved one call earlier. That was free
  // because the hook is on the SEAM rather than on a role or a position in the
  // chain. The module announces WHICH client is about to be called; what that
  // MEANS (which one scales to zero and owes the user a countdown) is host
  // policy, so the filter lives in the host's registered `onPrivateCallStart`
  // (lib/inference/config.server.ts), not here.
  //
  // `resolveClientForRole` below deliberately does NOT come through here — it is
  // asked the same question for prompt budgeting, potentially more than once and
  // without a call following, and a notice fired from a budgeting lookup would
  // announce a wait nobody is paying either.
  tierPolicy.onPrivateCallStart?.(client)
  return { client }
}

/** The Verda client for `role` while the active tier says so, with no side
 *  effect — the shared half of {@link clientOverrideFor} and
 *  {@link resolveClientForRole}, which differ only in whether asking counts as
 *  a call. */
function verdaClientFor(role: BamlRole): string | undefined {
  if (activeInferenceTier() !== 'verda') return undefined
  return VERDA_CLIENT_BY_ROLE[role]
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
  // Same composition as `clientOverrideFor`, and for the same reason: this
  // function's docstring promises "the client BAML uses for `role`", so a
  // mapped role must report the consumer's client — budgeting against a chain
  // no call reaches is the silent mis-budget this file already warns about.
  // A consumer client name is unknown to the host-fed tables until the host
  // adds it, which falls back SAFELY: a 16 384 window and the fixed batch
  // ceiling (over-trimming, never overflowing) — see the consumer module's
  // header.
  return consumerClients?.(role)?.client ?? verdaClientFor(role) ?? CLIENT_BY_ROLE[role]
}

/**
 * Context window (tokens) for a BAML client name. Falls back to 16K if the
 * client is unknown. MOVED here from `token-budget.server.ts` in Lane A5:
 * it reads the host-fed `contextWindows` table (see `configureModelTables` —
 * the VALUES live host-side beside `baml_src/` per SA-C2), beside
 * `resolveClientForRole` (which names the client) — the pattern layer no
 * longer touches the table.
 */
export function getContextWindow(clientName?: string): number {
  if (clientName && modelTables.contextWindows[clientName]) {
    return modelTables.contextWindows[clientName]
  }
  return 16_384
}

/**
 * The context window and output cap of the model the call for `role` will
 * ACTUALLY take (#225 Lane A5) — the budgets the five core trim/batch sites
 * spend against.
 *
 * PER CALL, not per construction: a tier decision is an AsyncLocalStorage
 * scope, so a value captured at pattern-construction time would budget a
 * verda-tier turn against the wrong model. `resolveClientForRole` reads the
 * scope that is active at the moment of the call — which is why the patterns
 * ask the seam (`controller.limits()`) immediately before dispatching, and
 * why the adapter implementations answer through THIS function rather than
 * caching a number.
 *
 * Floor vs leaf (do not conflate): `maxOutputTokens` is the CHAIN FLOOR —
 * `CLIENT_MAX_OUTPUT_TOKENS` keys the resolved chain name to its weakest
 * leaf's cap — and it budgets (`maxBatchItems`, SA-M6). The LEAF cap is a
 * different lookup by a different key (`llmCall.clientName`) and is what
 * `hitOutputCap` stamping uses (Lane A3, untouched here). Conflating the two
 * silently resizes describe batches on the Anthropic tier.
 */
export function limitsFor(role: BamlRole): ModelLimits {
  const client = resolveClientForRole(role)
  return {
    contextWindow: getContextWindow(client),
    maxOutputTokens: modelTables.maxOutputTokens[client],
  }
}
