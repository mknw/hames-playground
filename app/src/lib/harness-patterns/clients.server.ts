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
 * {@link assertPrivateTierConfigured} demands both endpoints. A private tier
 * with no small endpoint does not descale describe back onto the 27B — that
 * would be a routing change nobody asked for, made silently, on the role handed
 * tool results verbatim (SD-10). It refuses the tier instead.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { assertServerOnImport } from './assert.server'
// App-side, and in the same direction the patterns already import
// `settings-context.server` / `sandbox/scope.server`: a process-local clock
// with no database behind it, which is the boundary the library extraction
// actually cares about (see `llm-usage-observer.server.ts`).
import { noteVerdaCallStarting } from '../inference/cold-start.server'
import { VERDA_CLIENT_NAME } from '../inference/verda-activity.server'

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
  //  2. Its output ceiling HALVES — `AnthropicSonnet5`'s 32 768 to 16 384 — on
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
  // `assertPrivateTierConfigured`.
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

/**
 * Which inference tier a run is on.
 *
 * `'verda'` is the self-hosted deployment (`VERDA_CLIENT_BY_ROLE` above);
 * `'anthropic'` is "no override at all", i.e. every function runs the chain it
 * declares. Named rather than boolean because it reaches the browser — a
 * header control shows the user which one their chats are on, and a label is
 * what a preview user can act on.
 */
export type InferenceTier = 'verda' | 'anthropic'

/** `USE_VERDA_INFERENCE=1` — the DEPLOYMENT default: the tier every run takes
 *  when no per-run scope says otherwise. Read per call rather than cached at
 *  module load so a test (and a script that sets it before importing a
 *  pattern) sees it. */
export function verdaInferenceEnabled(): boolean {
  return process.env.USE_VERDA_INFERENCE === '1'
}

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
 * It asks about BOTH endpoints, because the tier needs both (the 27B and the 4B
 * summarizer). A deployment with only the 27B configured therefore leaves the
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
 * FAIL CLOSED on `'verda'`: a scope that names the self-hosted tier while the
 * endpoint is unset throws HERE, before any prompt is built. The alternative —
 * shrug and let BAML fall through to the declared Anthropic chain — is the one
 * failure this whole route exists to prevent, and it is no less dangerous for
 * having come from a user's preference row rather than from an env var.
 */
export function runWithInferenceTier<T>(tier: InferenceTier, fn: () => Promise<T>): Promise<T> {
  if (tier === 'verda') {
    // Rejected, not thrown synchronously: this function's whole contract is
    // "hand me a callback, get a promise", and a caller that only wrote
    // `.catch()` would otherwise take the throw on the stack instead. `fn` is
    // deliberately never invoked — the check is before any prompt is built.
    try {
      assertPrivateTierConfigured()
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
  return tierStore.getStore() ?? (verdaInferenceEnabled() ? 'verda' : 'anthropic')
}

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
 * tier — module load below, `runWithInferenceTier('verda')`, and
 * `verdaConfigured()`'s "may a user pick this?" — goes through here, so adding a
 * third model to the tier is one edit rather than three.
 *
 * The two halves stay separately callable on purpose: `scripts/smoke-verda.ts`
 * exercises only the 27B roles and must not be refused for a summarizer it never
 * calls.
 */
export function assertPrivateTierConfigured(): void {
  assertVerdaConfigured()
  assertSmallModelConfigured()
}

// Checked once, at module load, and only when the flag is on: a misconfigured
// endpoint should fail loudly and closed rather than surface as a 404 mid-
// conversation. Module load is the FIRST use of the harness, not process
// start (see the note on `assertVerdaConfigured` above), so this refuses the
// first agent call — it does not refuse the boot. Costs nothing on the
// default path.
if (verdaInferenceEnabled()) assertPrivateTierConfigured()

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
export function clientOverrideFor(role: BamlRole): { client: string } | undefined {
  const client = verdaClientFor(role)
  if (!client) return undefined
  // A bag naming the SCALE-TO-ZERO BOX is a call about to wait on a container
  // start, which is the moment the cold-start notice exists to catch. #274 wrote
  // this hook when the `router` still answered on Anthropic, so the first bag of
  // a turn belonged to the controller; the 2026-08-26 widening put the router on
  // the tier and the notice moved one call earlier. That was free because the
  // hook is on the SEAM rather than on a role or a position in the chain.
  //
  // What is NOT free is the client test below, and it arrived with the describe
  // flip. The private tier is two models now, and `LocalQwenSmall` does not
  // scale to zero — it is a llama-server somebody is running. A bag naming it is
  // a call that will answer in milliseconds, and announcing "starting GPU, ~146
  // seconds" in front of it would be a countdown for a wait nobody is paying,
  // fired from the highest-frequency role on the tier. So the hook keys on the
  // client, not on "the tier moved this role".
  //
  // `resolveClientForRole` below deliberately does NOT come through here — it is
  // asked the same question for prompt budgeting, potentially more than once and
  // without a call following, and a notice fired from a budgeting lookup would
  // announce a wait nobody is paying either. No-op unless a turn armed a watch
  // (`runWithColdStartWatch`).
  if (client === VERDA_CLIENT_NAME) noteVerdaCallStarting()
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
  return verdaClientFor(role) ?? CLIENT_BY_ROLE[role]
}
