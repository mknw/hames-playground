/**
 * Harness Patterns - Types
 *
 * Pure TypeScript interfaces plus the LLM call-envelope error class. Safe to
 * import from client and server.
 */

/**
 * The data types the harness patterns exchange with their LLM layer.
 *
 * Declared here (core), not imported from the generated BAML client: these
 * twelve shapes are the wire contract every pattern reads, and core must own
 * them so the injected-function seam (#225 Lane A1) can drop the generated
 * `types` module from the module graph. Field-for-field identical to the
 * generated definitions in `types.baml` — including the `| null` unions BAML
 * emits for optional-with-null fields — so no call site's inference changes.
 * When a field changes in `baml_src/`, it changes HERE in the same PR.
 */

/** Tool call event */
export interface ToolCall {
  tool: string
  args: string
}

/** Tool execution result */
export interface ToolResult {
  tool: string
  result: string
  success: boolean
  error?: string | null
}

/**
 * One extra tool call inside a multi-call turn (ControllerAction.additional_calls).
 * Field names deliberately match ControllerAction's singular fields — one
 * vocabulary, demonstrated everywhere (see the few-shot encoding lesson in
 * simpleLoop.baml: disagreeing demonstrations are defects).
 */
export interface ToolCallRequest {
  tool_name: string
  tool_args: string
}

/**
 * A ref:<id> argument that was expanded inline during a turn
 */
export interface ExpandedRef {
  ref_id: string
  content: string
}

/**
 * Description of an available tool, passed to patterns at runtime
 */
export interface ToolDescription {
  name: string
  description: string
  args_schema?: string | null
}

/**
 * Action decision returned by loop and actor controllers
 */
export interface ControllerAction {
  reasoning: string
  tool_name: string
  tool_args: string
  additional_calls?: ToolCallRequest[] | null
  status?: string | null
  is_final?: boolean | null
}

/**
 * A single turn in a loop-based pattern
 */
export interface LoopTurn {
  n: number
  reasoning?: string | null
  status?: string | null
  tool_call?: ToolCall | null
  additional_calls?: ToolCallRequest[] | null
  tool_result?: ToolResult | null
  expansions?: ExpandedRef[] | null
}

/**
 * A previous attempt for actor-critic retry loop
 */
export interface Attempt {
  n: number
  action: ControllerAction
  result: string
  error?: string | null
  feedback?: string | null
}

/**
 * Critic evaluation result
 */
export interface CriticResult {
  is_sufficient: boolean
  explanation: string
  suggested_approach?: string | null
}

/**
 * A compact reference to a tool result from a previous task/turn.
 * The LLM can pass ref:<ref_id> as a tool argument value to retrieve full data.
 */
export interface PriorResult {
  ref_id: string
  tool: string
  summary: string
  expanded_in_turn?: number | null
}

/**
 * A canonical example of how the agent should pick a tool for a given user request.
 * Few-shots are domain-specific — pass at config time on a per-route basis (e.g., a
 * neo4j route ships graph-query examples; a web route ships search-formulation examples).
 */
export interface FewShot {
  user: string
  reasoning: string
  tool: string
  args: string
}

/**
 * Strategic plan produced by the `planner` pattern BEFORE any tool runs.
 * The planner never executes a tool — it only describes the approach, which
 * downstream loop patterns receive as their trailing `planContext` argument
 * (harness-patterns/patterns/planner.server.ts → `formatPlanContext`).
 * `LoopController` takes it as its own `plan_context` parameter (tier 2);
 * `ActorController` merges it into `context`, which is cache-safe there.
 */
export interface PlanResult {
  /**
   * Field name deliberately matches ControllerAction.reasoning — one
   * vocabulary for "why this course of action", wherever it is produced.
   */
  reasoning: string
  plan: string
  n_steps: number
}

/**
 * How a cost figure was arrived at — the UI needs this to know whether the
 * number is an estimate of a token bill, a FLOOR on a time bill, or an exact
 * €0 for a call that was served locally and has no bill at all — or, on
 * `'provider'`, the figure the provider itself reported (USD, converted once at
 * the static rate; #418 T4).
 *
 * Defined here because it labels `EventMetrics.basis` — core owns the event
 * vocabulary it rides on. Moved from app's `settings.ts` at Step 1d: the
 * package was type-importing it across the package→app boundary, which a
 * published tarball cannot resolve. app's `settings.ts` re-exports this
 * definition, so app-side importers are unchanged.
 */
export type CostBasis = 'tokens' | 'time' | 'local' | 'provider'

/** How a loop pattern handles multi-call turns (ControllerAction.additional_calls).
 *  - 'parallel'   — affordance advertised; independent calls run concurrently
 *                   (capped at MAX_PARALLEL_TOOL_CALLS in flight)
 *  - 'sequential' — affordance advertised; calls run strictly in order, a
 *                   failure skips the rest of the batch (effect-chains)
 *  - 'off'        — no affordance in the prompt; an un-advertised batch is
 *                   still tolerated and executed like 'sequential'
 *  The schema field is shared by every agent, so 'off' cannot prevent a model
 *  from emitting a batch — it only stops the prompt from inviting one. */
export type MultiCallMode = 'parallel' | 'sequential' | 'off'

/** What a simpleLoop asks its controller to put in the terminal `Return`
 *  action's `tool_args` (#149).
 *  - 'summary' (default) — a one-or-two-sentence completion summary. The loop's
 *    prose reaches no user: `Synthesize` renders `tool_result.tool` / `.result`
 *    only and never `tool_call.args`, which is where the terminal action's
 *    prose lands, so a downstream `compactExecution` composes the user-facing
 *    answer from the FULL tool results. Composing it twice cost ~2.1k output
 *    tokens and ~22s on a measured 5-turn run, for a text nothing read.
 *  - 'answer' — the pre-#149 wording: compose the complete answer in
 *    `tool_args`. Prompt-only: the loop still sets no `data.response`, so a
 *    downstream `compactExecution` remains the author (passthrough is #149
 *    Option B, not built). For a loop whose Return prose is itself the
 *    deliverable — e.g. under a custom `synthesize` that reads the action. */
export type ReturnStyle = 'summary' | 'answer'

/** Max concurrently in-flight sub-calls of a 'parallel' multi-call turn. Also
 *  the batch-size guidance rendered into the controller prompts (keep in sync
 *  with LoopMultiCalls / ActorMultiCalls in baml_src). */
export const MAX_PARALLEL_TOOL_CALLS = 4

/**
 * Script execution event for actor-critic pattern.
 * Internal type used by actorCritic to track the actor's tool executions.
 *
 * `toolName` records the actor's actual `action.tool_name` so the BAML
 * adapter can render each rejected/executed attempt with the right tool
 * name (not a placeholder). `actorCritic` always sets it; the adapter falls
 * back to `'unknown'` for a caller that builds these events itself.
 */
export interface ScriptExecutionEvent {
  toolName?: string
  script: string
  output: string
  error?: string | null
  /** The critic's reason for rejecting THIS attempt, stamped by actorCritic
   *  when the critic returns `is_sufficient: false`. Both adapters map it onto
   *  `Attempt.feedback`, which is what the actor's attempt log renders — the
   *  channel that makes actorCritic more than simpleLoop-with-extra-steps.
   *  Absent on an attempt the critic never judged (cadence skip) or accepted. */
  feedback?: string
  /** Calls 2..N of a multi-call attempt, exactly as the actor emitted them —
   *  carried so the adapter's Attempt construction replays the real batch
   *  action instead of fabricating a singular one. */
  additionalCalls?: ToolCallRequest[]
}

// ============================================================================
// Core Context
// ============================================================================

/** Status of context */
export type CtxStatus = 'running' | 'paused' | 'done' | 'error'

// ============================================================================
// UnifiedContext - Source of Truth
// ============================================================================

/** All possible event types in the context */
export type EventType =
  | 'user_message'
  | 'assistant_message'
  | 'tool_call'
  | 'tool_result'
  | 'controller_action'
  | 'critic_result'
  | 'pattern_enter'
  | 'pattern_exit'
  /** @deprecated Legacy: superseded by `hitl_request` (#433). Rendered
   *  metadata-only into LLM-facing views and never read by `readHitl`. */
  | 'approval_request'
  /** @deprecated Legacy: superseded by `hitl_response` (#433). Rendered
   *  metadata-only into LLM-facing views and never read by `readHitl`, so a
   *  stored `{ approved: true }` can never answer a request. */
  | 'approval_response'
  | 'error'
  | 'reference_attached'
  | 'intent_compacted'
  | 'plan_created'
  | 'content_sanitized'
  | 'warning'
  | 'loop_recovery'
  /** A person is asked to decide (#433). Only core writes it — see `readHitl`. */
  | 'hitl_request'
  /** The decision on one `hitl_request` (#433). Only core writes it. */
  | 'hitl_response'
  /** One typed decision the policy layer evaluated (#418). Metadata only —
   *  the `state` the decision was asked over can hold sanitized mail bodies
   *  or tool results (SD-3/SD-10), so the event carries `stateChars`, the
   *  SIZE, and never the text. See `DecisionMadeEventData`. */
  | 'decision_made'
  /** What the memory recall step did on a turn (#419): the ids it attached, or
   *  why it attached nothing. IDS ONLY — never memory content. See
   *  `MemoryRecalledEventData`. */
  | 'memory_recalled'
  /** One memory the store step wrote or reinforced (#419 M2). METADATA ONLY —
   *  ids, kind, tier and a content HASH, never the content. See
   *  `MemoryWrittenEventData`. */
  | 'memory_written'

/** Accounting record for one harness step (#122): token and cost totals
 *  summed across EVERY physical API call the step made — including truncation
 *  retries and fallback-chain attempts that never surface in `llmCall` (which
 *  describes only the selected exchange). Stamped at event-creation time so
 *  costs reflect the rates in force when the call happened; `rates` makes the
 *  figure auditable/recomputable. Never rendered into LLM-facing
 *  serializations (formatEvent reads only `data`). */
export interface EventMetrics {
  /** Input tokens billed at the full base rate (not served from cache) */
  inputUncachedTokens: number
  /** Input tokens read from cache (0.1× base input rate) */
  inputCacheReadTokens: number
  /** Input tokens written to cache (1.25× base input rate) */
  inputCacheWriteTokens: number
  /** Output tokens (no cached variant exists — caching covers the request prefix) */
  outputTokens: number
  /** Physical API calls this step made (>1 ⇒ retries/fallbacks burned spend) */
  attempts: number
  /** Estimated cost in EUR — one currency everywhere a price renders. Absent
   *  when any token-bearing attempt could not be priced (unknown beats
   *  silently wrong). Summed across attempts, which may mix bases: a
   *  token-priced fallback and a time-priced attempt each contribute their own
   *  arithmetic. */
  costEur?: number
  /** Same call priced with zero caching — the savings baseline. Equal to
   *  `costEur` for a time-priced attempt: caching cannot save wall-clock. */
  noCacheEur?: number
  /** How the final priced attempt was billed — the audit label, not the test
   *  for a floor. A step can MIX bases (a self-hosted attempt, an Anthropic
   *  retry), and then this names only the one that happened to run last: read
   *  {@link EventMetrics.timePricedAttempts} to decide whether the figure is a
   *  floor. */
  basis?: CostBasis
  /** Priced attempts in this step billed by wall-clock. `> 0` ⇒ `costEur` is a
   *  FLOOR: it covers the duration of the calls themselves and not the idle
   *  scale-down window after the last one or the cold start before the first,
   *  both of which the box is also paid for. Render such a figure with a `≥`.
   *  Absent on a purely token-priced step, and on events stamped before this
   *  field existed — `isTimePricedStep` in `metrics/aggregate.ts` is the one
   *  place that knows to fall back to `basis` for those. */
  timePricedAttempts?: number
  /** €/MTok applied to the last token-priced attempt (audit trail) — the
   *  vendor's USD list price already converted at the EUR-per-USD rate. */
  rates?: { inPerMTok: number; outPerMTok: number }
  /** €/h and the measured wall-clock it was applied to, SUMMED over the step's
   *  time-priced attempts, so it describes the same seconds `costEur` charged
   *  for rather than the last attempt's alone. */
  timeRate?: { eurPerHour: number; durationMs: number }
  /** @deprecated Pre-EUR stamp, in USD. Events persisted before the currency
   *  fix carry this instead of `costEur`; the folds convert it at the DEFAULT
   *  USD→EUR rate, because the rate in force when it was stamped was never
   *  recorded. Never written by new code. */
  costUsd?: number
  /** @deprecated Pre-EUR stamp, in USD. See {@link EventMetrics.costUsd}. */
  noCacheUsd?: number
}

/** A single event in the context stream */
export interface ContextEvent {
  /** Unique event identifier for cross-referencing */
  id?: string
  type: EventType
  ts: number
  patternId: string
  data: unknown
  /** LLM call data - present when event involved an LLM call */
  llmCall?: LLMCallData
  /** Step-level token/cost accounting — lifted from `llmCall.metrics` at
   *  trackEvent time. First-class so any consumer (panel, exports,
   *  recordings, dashboards) folds events without knowing llmCall internals. */
  metrics?: EventMetrics
}

/** UnifiedContext - single source of truth for session state */
export interface UnifiedContext<T = Record<string, unknown>> {
  /** Session identifier */
  sessionId: string
  /** When the session was created */
  createdAt: number
  /** Full event stream */
  events: ContextEvent[]
  /** Current execution status */
  status: CtxStatus
  /** Error message if status is 'error' */
  error?: string
  /** Accumulated pattern data */
  data: T
  /** Current user input */
  input: string
}

/** Isolated workspace for a pattern's execution */
export interface PatternScope<T = Record<string, unknown>> {
  /** Pattern identifier */
  id: string
  /** Local events (not yet committed to context) */
  events: ContextEvent[]
  /** Pattern-specific data */
  data: T
  /** When pattern execution started */
  startTime: number
}

// ============================================================================
// Pattern Configuration
// ============================================================================

/** When to commit events to context */
export type CommitStrategy =
  | 'always' // Commit all tracked events regardless of outcome
  | 'on-success' // Commit only if pattern completes without error
  | 'last' // Commit only the final event
  | 'never' // Discard all events (dry-run / preview mode)

/** What event types to track */
export type TrackHistory =
  | boolean // true = all types, false = none
  | EventType // Single type: 'tool_result'
  | EventType[] // Multiple: ['tool_call', 'tool_result']

/** Configuration for what events a pattern receives */
/** Read-time event transform — takes a ContextEvent, returns a new one (never mutates).
 *  Applied by EventView in get()/serialize() as a view-level lens.
 *  ctx.events and serializeContext() are NEVER transformed. */
export type ContentTransform = (event: ContextEvent) => ContextEvent

export interface ViewConfig {
  /** Specific pattern IDs to read from */
  fromPatterns?: string[]
  /** Last N patterns */
  fromLastN?: number
  /** Only previous pattern (default: true) */
  fromLast?: boolean
  /** Filter by event type */
  eventTypes?: EventType[]
  /** Max events to include */
  limit?: number
  /** Rolling window: include only events from the last N user turns.
   *  A "turn" boundary is defined by a user_message event.
   *  Applied before type/pattern filters so boundaries can be detected. */
  fromLastNTurns?: number
  /** Read-time content transforms applied in get()/serialize().
   *  Each transform receives a ContextEvent and returns a new one.
   *  Compose: [stripThinkBlocks, truncateToolResults(2000)] — each feeds into the next.
   *  Storage (ctx.events, serializeContext) is never affected. */
  contentTransforms?: ContentTransform[]
}

/** Base configuration for all patterns */
export interface PatternConfig {
  /** Explicit ID for referencing later */
  patternId?: string
  /** When to commit events (default varies by pattern) */
  commitStrategy?: CommitStrategy
  /** What event types to track */
  trackHistory?: TrackHistory
  /** Configure EventView input for this pattern */
  viewConfig?: ViewConfig
  /** Error severity classification for this pattern (default varies by pattern) */
  errorSeverity?: 'recoverable' | 'irrecoverable'
  /** Stream this pattern's events to the harness `onEvent` listener as they're
   *  tracked, instead of buffering until commit. Default: false. */
  liveEvents?: boolean
}

// ============================================================================
// Controller & Critic Seam Inputs
// ============================================================================

/** The controller seam's one named input (#225 Lane A4) — replaces the old
 *  eleven-argument positional tail (`user_message, intent, previous_results:
 *  string, n_turn, ...extra: any[]`). `turns` is the TYPED turn array, which
 *  is what deletes the JSON.stringify → duck-typed-parse round-trip and its
 *  silent-`[]` catch: the loop already holds real `LoopTurn` objects, so
 *  there is no string to re-parse and nothing to mis-parse.
 *
 *  The live callable is `ControllerFn` (in `baml-adapters.server.ts` beside
 *  its implementation — it carries a legacy positional overload for the
 *  adapter-level tests, deleted with the file at A6). */
export interface ControllerInput {
  userMessage: string
  intent: string
  /** The ONE tool list (L14, #225 Lane B3): the loop's allowlist arrives as
   *  part of the input, so the controller advertises exactly what the loop
   *  will accept — the same names, declared once. There is no second channel:
   *  a factory-captured list (the old divergence where the prompt advertised
   *  a set the loop could refuse, or silently under-advertised) cannot exist
   *  any more. */
  tools: readonly string[]
  /** TYPED. Replaces `previous_results: string`. */
  turns: readonly LoopTurn[]
  turn: number
  /** Was `schema`. Rendered in the prompt's tier-1 cache marker alongside the
   *  factory's `contextPrefix`. */
  context?: string
  priorResults?: readonly PriorResult[]
  fewShots?: readonly FewShot[]
  multiCallMode?: 'parallel' | 'sequential'
  planContext?: string
  returnStyle?: ReturnStyle
}

/** The actor seam's one named input (#225 Lane A4) — replaces the positional
 *  tail of the actor seam. `previousAttempts` was already a typed array;
 *  nothing here is stringified or re-parsed. The live callable is
 *  {@link ActorFn}. */
export interface ActorInput {
  userMessage: string
  intent: string
  /** Part of the seam shape per the design note; the implementation resolves
   *  its own allowlist from the factory options and does not read this — it
   *  was accepted-and-ignored positionally before A4 too. */
  availableTools: readonly string[]
  previousAttempts: readonly ScriptExecutionEvent[]
  attemptNumber?: number
  maxAttempts?: number
  multiCallMode?: 'parallel' | 'sequential'
  planContext?: string
}

/** Result of a controller/actor call: the action plus the implementation-
 *  stamped call record (Lane A3). Lives in core because it IS the seam's
 *  return type. */
export interface ControllerCallResult {
  action: ControllerAction
  llmCall?: LLMCallRecord
}

/** Result of a critic call with optional LLM observability data. Lives in
 *  core because it IS the critic seam's return type (same rule as
 *  {@link ControllerCallResult}); the harness-baml adapter re-exports it for
 *  existing import paths. */
export interface CriticCallResult {
  result: CriticResult
  llmCall?: LLMCallRecord
}

/** The critic seam `actorCritic` consumes. Moved into core from
 *  `harness-baml/baml-adapters.server` (BAML-companion seam lane): a type-only
 *  import from app code is still an import, and core never imports a
 *  companion (#225 L3). The adapter's optional collector parameter is an
 *  implementation detail the pattern never passes, so the seam is the two
 *  arguments the loop actually hands over. */
export type CriticFnWithLLMData = (
  intent: string,
  previous_attempts: ScriptExecutionEvent[],
) => Promise<CriticCallResult>

/** The model budgets a call must respect — the context window and output cap
 *  of the model the call will ACTUALLY take (#225 Lane A5).
 *
 *  Per CALL, not per construction: a tier decision is an AsyncLocalStorage
 *  scope, so a value captured at pattern-construction time would budget a
 *  verda-tier turn against the wrong model. `limitsFor(role)` in
 *  `clients.server.ts` resolves per call; the adapter-backed seam functions
 *  expose it as `limits()`. */
export interface ModelLimits {
  contextWindow: number
  /** Absent means UNKNOWN, never "no cap". Preserves the
   *  `llmCallHitOutputCap` semantics: an unknown client is not-detectable,
   *  never a false positive. This is the CHAIN FLOOR (the weakest leaf's cap,
   *  SA-M6) — budget with it; the per-attempt leaf cap is what
   *  `hitOutputCap` stamping uses, and the two must not be conflated. */
  maxOutputTokens?: number
}

/** The controller seam callable (Lane A4): takes the whole input as ONE named
 *  object. `simpleLoop` accepts this; the adapter factories return it (with a
 *  legacy positional form attached for the untouched acceptance tests — see
 *  `baml-adapters.server.ts`).
 *
 *  `limits` (Lane A5) is OPTIONAL because a custom injected implementation
 *  may not know its model's budgets; the adapter implementations always
 *  provide it, and a seam without one falls back to the conservative 16K
 *  window (the same default `getContextWindow` carried). */
export type ControllerFn = {
  (input: ControllerInput): Promise<ControllerCallResult>
  /** Per-call model budgets (Lane A5). Optional: a custom injected
   *  implementation may not know them — the adapter implementations always
   *  provide it, and a seam without one falls back to the conservative 16K
   *  window (the same default `getContextWindow` carried). */
  limits?: () => ModelLimits
}

/** The actor seam callable (Lane A4). `actorCritic` accepts this. */
export type ActorFn = (input: ActorInput) => Promise<ControllerCallResult>

// ============================================================================
// The remaining seam callables (#225 Lane A6) — the six functions that stop
// being BAML-wired inside core and become REQUIRED config on their patterns.
// All of them are plain callables the app supplies via `bamlPatterns()`
// (`lib/harness-baml`); core declares the shapes and hosts no implementation.
//
// `limits?` follows the controller seam's Lane A5 shape: OPTIONAL, because a
// custom injected implementation may not know its model's budgets, while the
// adapter implementations always provide it (resolved per call — a tier
// decision is an ALS scope). A seam without one falls back to the
// conservative 16K window, the same default `getContextWindow` carried.
// ===========================================================================

/** Shared input for the history-rewriting describe functions (`CompactIntent`,
 *  `RetrieveQuery`): the conversation history ALREADY TRIMMED by the caller
 *  against the fn's own `limits().contextWindow`, plus the latest user
 *  message. The trim stays with the pattern so its event data keeps reporting
 *  the length it actually sent; the fn is a pure model call. */
export interface HistoryQueryInput {
  history: Array<{ role: string; content: string }>
  latest: string
}

/** The compactIntent seam: REQUIRED config on `compactIntent`. Rewrites the
 *  latest message into a self-contained intent brief; on failure it throws
 *  {@link LLMCallError} (the pattern degrades recoverably to the raw
 *  message — it never blocks the chain). */
export type CompactIntentFn = {
  (input: HistoryQueryInput): Promise<LLMResult<string>>
  limits?: () => ModelLimits
}

/** The RetrieveQuery seam: REQUIRED config on `retriever`. Rewrites the latest
 *  message into a search query; on failure it throws {@link LLMCallError} and
 *  the retriever falls back to the raw message. */
export type RetrieveQueryFn = {
  (input: HistoryQueryInput): Promise<LLMResult<string>>
  limits?: () => ModelLimits
}

/** What a planner call returns: the plan plus the record of the call that
 *  produced it, and the size of the tool catalog the model was ACTUALLY shown
 *  (the resolved one — an active sandbox scope's in-VM tools plus the gateway
 *  tools that resolved — not the raw name list). */
export interface PlanCallResult {
  plan: PlanResult
  llmCall?: LLMCallRecord
  toolCount: number
}

/** The planner seam: REQUIRED config on `planner`. Positional like the
 *  adapter it replaces — the schema rides per call (`planner`'s own config
 *  carries it), and there is no collector slot: the implementation owns its
 *  collector and returns the record. */
export type PlannerFn = (
  userMessage: string,
  intent: string,
  context?: string,
) => Promise<PlanCallResult>

/** One tool result queued for a batched describe call. `id` is a
 *  caller-assigned label, unique within the batch, that the model echoes back
 *  on its summary. */
export interface DescribeBatchItem {
  id: string
  tool: string
  toolArgs: string
  reasoning: string
  result: string
}

/** The single-result describe seam: REQUIRED config on `compactBulkData`.
 *  A FAILED call throws; `''` means the model answered with nothing worth
 *  keeping. The two are different facts and `compactBulkData` treats them
 *  differently: either way the result keeps its raw output, but only a throw
 *  is recorded as a `warning` event (#420). (Until #420 failure was reported
 *  as `''` too, which is why nothing anywhere said a summarizer was down. An
 *  implementation that still does that keeps working — it just stays silent.) */
export type DescribeFn = (
  tool: string,
  toolArgs: string,
  reasoning: string,
  result: string,
) => Promise<string>

/** The batched describe seam: REQUIRED config on `compactBulkData`. Returns a
 *  map of item `id` → summary; missing ids (dropped, blank) are the caller's
 *  cue to fall back per item, and so is a throw — a FAILED call throws, like
 *  {@link DescribeFn}, so the failure can be told apart from a thin answer.
 *  `limits` is what `maxBatchItems` sizes batches against (the CHAIN FLOOR,
 *  SA-M6). */
export type DescribeBatchFn = {
  (items: DescribeBatchItem[]): Promise<Map<string, string>>
  limits?: () => ModelLimits
}

/** The two describe fns `compactBulkData` requires. Structurally the
 *  `describe` / `describeBatch` members of `BamlPatterns` (`harness-baml`). */
export interface BulkDescribeFns {
  describe: DescribeFn
  describeBatch: DescribeBatchFn
}

/** What a routing call returns. Lives in core so the router's `route`
 *  override is declarable without core importing the implementation. */
export interface RouteMessageResult {
  intent: string
  tool_call_needed: boolean
  tool_name: string | null
  response_text: string
  llmCall?: LLMCallRecord
}

/** The router seam. The implementation (`routeMessageOp`, harness-baml)
 *  satisfies this shape and is REQUIRED config: core hosts no default, so the
 *  composition root supplies it — `router(routes, { route: baml.router })` in
 *  the app (see `BamlPatterns.router`). Core declares only the type. */
export type RouteFn = {
  (
    message: string,
    history: Array<{ role: string; content: string }>,
    routes?: Array<{ name: string; description: string }>,
    extra?: RouteExtra,
  ): Promise<RouteMessageResult>
  limits?: () => ModelLimits
}

/** What a turn can hand the router besides the message (#419 M5a). Optional and
 *  TRAILING, so a `RouteFn` written before it keeps its meaning. The router
 *  passes it only when it has something to pass: a call with nothing recalled
 *  carries no fourth argument at all. */
export interface RouteExtra {
  /** The block `memoryRecall` formatted for this turn (`data.memoryContext`):
   *  background about the user, rendered as DATA — never an instruction, never
   *  a routing signal on its own. */
  memoryContext?: string
}

// ============================================================================
// Pattern Configuration
// ============================================================================

/** Result handed to `onToolResult` and returned (mutated) back to the loop. */
export interface ToolCallResult {
  success: boolean
  data: unknown
  error?: string
}

/** Hook called by simpleLoop / actorCritic between `callTool()` and the
 *  `tool_result` event being committed. Returning `{ data }` replaces
 *  `result.data`; returning void/undefined leaves it unchanged. Throwing
 *  is non-fatal — the loop logs an `error` event and continues with the
 *  original result. Closes #7. */
export type OnToolResult = (
  toolName: string,
  result: ToolCallResult,
  context: { callId?: string; args: unknown },
) => Promise<{ data?: unknown } | void> | { data?: unknown } | void

/** Configuration for simpleLoop pattern */
export interface SimpleLoopConfig extends PatternConfig {
  /** Optional schema to inject (for neo4j) */
  schema?: string
  /** Max turns before forcing exit (default: 5) */
  maxTurns?: number
  /** Include tool results from prior turns in controller context (default: true) */
  rememberPriorTurns?: boolean
  /** Number of prior user turns to include (default: 3) */
  priorTurnCount?: number
  /** Include failed tool results in prior turn context (default: false) */
  includeFailedResults?: boolean
  /** Domain-specific few-shot examples rendered into the LoopController prompt.
   *  Each shot is a `(user, reasoning, tool, args)` tuple shown verbatim under
   *  an "EXAMPLES" section. Keep the list short (3-5) — the prompt grows with
   *  every shot and is sent on every turn.
   *
   *  Filtered by the loop's allowlist before the controller sees them (#401):
   *  a shot whose `tool` the loop would refuse is dropped, so one list can
   *  serve a loop that holds a tool and one that does not. Shots of the
   *  loop-control actions (`Return`, `expandPreviousResult`) always stay. */
  fewShots?: FewShot[]
  /** Hook to enrich/transform a tool result before the `tool_result` event is
   *  committed. See `OnToolResult`. */
  onToolResult?: OnToolResult
  /** Per-tool omit-list for the CONTROLLER TURN LOG only: fields deleted
   *  (recursively, at every object level including array elements) from the
   *  result shown to the loop LLM. The `tool_result` EVENT keeps the full
   *  result — the compactExecution, citation extractors and session persistence are
   *  untouched, so e.g. dropping `webUrl` here still leaves the final answer
   *  its links. Keyed by tool name; tools without an entry pass through
   *  unchanged. See `omitResultFields` in content-transforms.ts. */
  resultOmit?: Record<string, string[]>
  /** Regex matched against `action.tool_name` after the strict allowlist
   *  fails. Lets agents accept dynamically-created tools (e.g. from an MCP
   *  gateway that registers tools at runtime) without enumerating every
   *  possible name upfront. */
  dynamicToolPattern?: RegExp
  /** Multi-call turns: 'parallel' (default) | 'sequential' | 'off'.
   *  See `MultiCallMode`. */
  multiToolCalls?: MultiCallMode
  /** Terminal `Return` style: 'summary' (default) | 'answer'. See
   *  `ReturnStyle`. Every registered agent's loop is followed by a
   *  `compactExecution`, which is the better-informed author (full-fidelity
   *  results, across patterns, including the fields `resultOmit` hides from the
   *  controller), so the default asks the loop for a summary only. */
  returnStyle?: ReturnStyle
  /** The consecutive-recovery cap (default: 1): how many answers the loop
   *  cannot use it will feed back IN A ROW. An unusable answer is one that would
   *  not parse, `tool_args` that would not parse, a tool off the allowlist, or a
   *  multi-call turn of which no call could be dispatched. Up to the cap, each is
   *  fed back as that round's result; the next one ends the loop exactly as it
   *  did before #437, marked `kind: 'recovery_exhausted'` — so by default a loop
   *  stops on its second unusable answer in a row. A round that dispatches a
   *  tool resets the count, whatever the tool returns; a tool that ran and
   *  FAILED is never counted. `0` permits no recovery (the pre-#437 behaviour
   *  for those failures), `Infinity` leaves only `maxTurns`; values below 0 are
   *  clamped to 0. */
  maxConsecutiveRecoveries?: number
}

/** Configuration for actorCritic pattern */
export interface ActorCriticConfig extends PatternConfig {
  /** Max retries before giving up (default: 3) */
  maxRetries?: number
  /** Hook to enrich/transform a tool result before the `tool_result` event is
   *  committed. See `OnToolResult`. */
  onToolResult?: OnToolResult
  /** Regex matched against `action.tool_name` after the strict allowlist
   *  fails. Lets agents accept dynamically-created tools (e.g. from an MCP
   *  gateway that registers tools at runtime) without enumerating every
   *  possible name upfront. */
  dynamicToolPattern?: RegExp
  /** Async closure resolved per actor invocation. Returns the live allowlist
   *  the loop should use *in addition to* `tools` and `dynamicToolPattern`.
   *  Mirrors `ActorAdapterOptions.toolNamesProvider` so the actor's prompt
   *  and the loop's strict allowlist stay in sync when the user mutates the
   *  selection mid-conversation. */
  dynamicToolAllowlist?: () => Promise<string[]>
  /** How often the critic runs, in successful actor turns (default: 1 = every
   *  turn, the original behavior). With `criticCadence: N` the actor free-runs a
   *  sequence of tool calls and the critic — still the loop's SOLE exit
   *  authority — evaluates only (a) every Nth successful turn, (b) whenever the
   *  actor sets `is_final: true` ("I think I'm done"), and (c) on the final
   *  attempt. This lets a multi-step deliverable (e.g. write a script, THEN run
   *  it) finish before the critic judges, so it can't wrongly accept an
   *  intermediate state as complete — the failure in
   *  `.harness-logs/context-3817275e-*.json`, where a critic ran right after the
   *  report script was WRITTEN (before it ran) and exited with no .docx. Values
   *  < 1 are clamped to 1 so the critic can never be disabled. Note: with N > 1,
   *  `maxRetries` bounds actor turns (tool steps), not critic evaluations. */
  criticCadence?: number
  /** Multi-call turns: 'parallel' (default) | 'sequential' | 'off'.
   *  See `MultiCallMode`. */
  multiToolCalls?: MultiCallMode
  /** The consecutive-recovery cap (default: 1), counted in ATTEMPTS — the same
   *  rule as `SimpleLoopConfig.maxConsecutiveRecoveries`. An actor answer that
   *  would not parse, unparseable `tool_args`, a refused tool name and a
   *  multi-call attempt that dispatched nothing count; an attempt that
   *  dispatches a tool resets the count, and a tool that ran and failed is never
   *  counted, so the fail-fix-fail iteration a sandbox actor debugs by is
   *  untouched. A refusal against a tool surface that resolved to nothing (no
   *  static or dynamic names, no scoped transport, no `dynamicToolPattern`)
   *  neither counts nor resets: the actor had no valid name to choose. */
  maxConsecutiveRecoveries?: number
}

/** Synthetic tool injected into LoopController's tools list when prior results
 *  are present. simpleLoop intercepts this name before MCP dispatch — see
 *  `simpleLoop.server.ts` for the resolver. tool_args is the raw `ref:<id>`
 *  string (not JSON). */
export const EXPAND_TOOL_NAME = 'expandPreviousResult'

/** A compact reference candidate offered to a selector or attached to a pattern */
export interface ReferenceCandidate {
  ref_id: string
  tool: string
  summary: string
  tool_args?: string
  ts: number
}

/** Custom selector function for `withReferences`. Override the default LLM-driven
 *  selector when you want deterministic policies (tests, evals, fast-path). */
export type SelectorFn = (input: {
  intent: string
  recentMessages: Array<{ role: 'user' | 'assistant'; content: string }>
  candidates: ReferenceCandidate[]
}) => Promise<{
  selected: Array<{ ref_id: string; reason: string }>
  reasoning: string
}>

/** Configuration for `withReferences` meta-pattern wrapper */
export interface WithReferencesConfig extends PatternConfig {
  /** Which patterns' tool_results are eligible. Default: 'global' */
  scope?: 'self' | 'global'
  /** Explicit patternId allow-list. Overrides `scope` when set. */
  source?: string | string[]
  /** Cap on attached refs after selection. Default: 5 */
  maxRefs?: number
  /** REQUIRED: the selector implementation. Core hosts no default — the
   *  composition root supplies the BAML-backed one (`bamlPatterns().selector`)
   *  or its own deterministic policy. */
  selector: SelectorFn
}

// ============================================================================
// Patterns
// ============================================================================

/** Forward declaration for EventView (implemented in event-view.server.ts) */
export interface EventView {
  fromPattern(patternId: string): EventView
  fromPatterns(patternIds: string[]): EventView
  fromLastPattern(): EventView
  fromLastNPatterns(n: number): EventView
  /** No pattern filter — but the ViewConfig's own filters still apply. */
  fromAll(): EventView
  /** Same context, NO filters at all (ViewConfig included). */
  unfiltered(): EventView
  ofType(type: EventType): EventView
  ofTypes(types: EventType[]): EventView
  tools(): EventView
  messages(): EventView
  actions(): EventView
  errors(): EventView
  last(n: number): EventView
  first(n: number): EventView
  since(ts: number): EventView
  /** Rolling window: keep only events from the last N user turns */
  fromLastNTurns(n: number): EventView
  get(): ContextEvent[]
  serialize(): string
  serializeCompact(options?: { recentTurns?: number }): string
  exists(): boolean
  count(): number
  hasErrors(): boolean
  lastError(): string | undefined
}

/** Pattern signature with isolated scope and event view */
export type ScopedPattern<T> = (scope: PatternScope<T>, view: EventView) => Promise<PatternScope<T>>

/** Settings consulted by `estimateTurns` — patterns whose effective `maxTurns`
 *  / `maxRetries` come from runtime settings need these to project a cost. */
export interface TurnEstimateSettings {
  maxToolTurns: number
  maxRetries: number
}

/** Configured pattern with metadata for chain/harness */
export interface ConfiguredPattern<T> {
  name: string
  fn: ScopedPattern<T>
  config: PatternConfig
  /** Optional projection of how many "turns" this pattern will produce.
   *  Used by `harness()` to stamp `chainTurnEstimate` on the initial
   *  `user_message` event so progress consumers can size themselves up front.
   *  Wrapper patterns delegate to their child(ren). Returning `undefined` is
   *  equivalent to a contribution of 1. */
  estimateTurns?: (settings: TurnEstimateSettings) => number
  /** Wrapped sub-patterns, for combinators that compose others
   *  (`chain`, `routes`, `parallel`, `withReferences`). Leaf patterns omit it.
   *  Purely for static introspection of the pattern graph — execution runs
   *  through `fn`, never this — so it's safe and additive. See
   *  `pattern-capabilities.ts` (`harnessHasRetriever`) for the canonical walk. */
  children?: ConfiguredPattern<T>[]
  /** Set by `withInjectionGuard`: the untrusted sources it declared. Same
   *  charter as `children` — purely for static introspection, never read during
   *  execution (the guard travels by AsyncLocalStorage). It exists so an
   *  agent's trust boundary is READABLE rather than only observable by running
   *  the agent: without it, emptying an agent's namespace list would be
   *  invisible to every test and every tool. Deliberately NOT on `config`, so
   *  the wrapper stays config-transparent (`pattern.config` remains the inner
   *  pattern's own object). */
  injectionGuard?: { namespaces: string[]; tools: string[] }
  /** Statically declared capabilities — see {@link PatternCapabilities}. Same
   *  charter as `children` and `injectionGuard`: introspection only, never read
   *  during execution, and NOT part of `config`, so a wrapper that declares one
   *  stays config-transparent. */
  capabilities?: PatternCapabilities
}

/**
 * What a pattern DECLARES about itself for a host to read without running it.
 *
 * Every field is a capability in the host's own vocabulary, named for what it
 * DOES rather than for the package that supplies it — core hosts the contract,
 * other packages fill it in. The probes in `pattern-capabilities.ts` walk a
 * pattern graph and read these; nothing here is consulted during execution.
 *
 * It is one typed field instead of the ad-hoc config keys it replaced
 * (`backendKinds`, `sandboxSyncWorkspace`), because those rode between packages
 * as STRINGS: the declaring side widened `PatternConfig` with a cast and the
 * reading side widened it back with a second, independent cast, so renaming
 * either one compiled on both sides and silently turned the capability off.
 * With the fact in a type core owns, a rename is a compile error in every
 * package that names it — which is the whole reason the field exists.
 *
 * Adding a capability means adding a field here. That is deliberate friction:
 * a cross-package fact should be declared once, in the type, rather than
 * agreed by convention at two call sites that never see each other.
 */
export interface PatternCapabilities {
  /** Names of the retrieval backends this pattern will query (the
   *  `RetrieverBackend.name`s it was built with). Declared by `retriever`. A
   *  host gates on the backend it owns — `'redis'` is the local Data Stash
   *  vector path, which is what makes an upload worth auto-ingesting. */
  retrievalBackends?: readonly string[]
  /** This pattern's subtree runs against a DURABLE workspace: files are
   *  restored into it on entry and deliverables promoted back out on exit, so
   *  the workspace outlives the container. Declared by a wrapper that actually
   *  performs that sync — a host reads it to decide whether it must hydrate the
   *  workspace itself when it is the first to boot the session's container. */
  workspaceSync?: boolean
  /** The decision keys this pattern will decide (#418) — the `DecisionSpec.key`
   *  / `DecisionSetSpec.key` values whose calibration and thresholds a host
   *  can fit and feed (`configureDecisionCalibration`, keyed `(client,
   *  spec.key)`). Declared so a boot probe can warn when a key a policy
   *  requires calibration for has no entry for a configured tier (D12) —
   *  a `requireCalibrated` decision with no entry always abstains, which is a
   *  control present and unreachable, exactly the shape the field exists to
   *  surface. Read by `harnessDecisionKeys` (`pattern-capabilities.ts`). */
  decisionKeys?: readonly string[]
  /** The subset of {@link decisionKeys} whose policy sets `requireCalibrated`
   *  (#418 T6, coordinator decision G4). `decisionKeys` says which keys exist;
   *  this says which of them ABSTAIN FOREVER without a calibration entry, which
   *  is the only subset a boot probe has a reason to warn about. Declared next
   *  to the key rather than read back from `config`, because the patterns
   *  destructure `policy` out of it. Read by `harnessCalibratedDecisionKeys`. */
  calibratedDecisionKeys?: readonly string[]
  /** This pattern reads (or writes) the user's persistent memory (#419).
   *  Declared by `memoryRecall`; read by `harnessUsesMemory`, the ONE probe a
   *  host gates the memory wake and the post-reply store on — so an agent that
   *  never opted in never wakes the memory boxes. */
  memory?: true
}

// ============================================================================
// Tools
// ============================================================================

export interface MCPToolDescription {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface ToolCallResult {
  success: boolean
  data: unknown
  error?: string
  /** Set by `withInjectionGuard` (in `callTool`) when this result's content —
   *  `data`, or `error` for a demoted failure — was neutralized. Loop patterns
   *  copy this onto the `tool_result` event. Redacted by construction; the
   *  verbatim spans live only on the `content_sanitized` event. */
  sanitized?: import('./injection-guard').SanitizeSummary
}

export type ToolSet = Record<string, string[]> & { all: string[] }

// ============================================================================
// Results
// ============================================================================

export interface HarnessResult<T> {
  response: string
  data: T
  status: CtxStatus
  duration_ms: number
}

// ============================================================================
// Loop History (for thread mode synthesis)
// ============================================================================

/** Single iteration in a loop pattern */
export interface LoopIteration {
  turn: number
  action: ControllerAction
  result: unknown
  timestamp: number
}

/** Full history of a loop pattern's execution */
export interface LoopHistory {
  iterations: LoopIteration[]
  startTime: number
  endTime?: number
}

/** Data that includes loop history */
export interface WithLoopHistory {
  loopHistory?: LoopHistory
}

// ============================================================================
// compactExecution Types
// ============================================================================

/** Mode for compactExecution pattern */
export type CompactExecutionMode = 'message' | 'response' | 'thread'

/** Input to compactExecution based on mode */
export interface CompactExecutionInput {
  mode: CompactExecutionMode
  userMessage: string
  intent: string
  response?: string
  data?: unknown
  loopHistory?: LoopHistory
  /** Whether an error occurred in upstream patterns */
  hasError?: boolean
  /** Error message from upstream patterns */
  errorMessage?: string
  /** The block `memoryRecall` formatted for this turn (`data.memoryContext`),
   *  present ONLY when something was recalled (#419 M5a). Background about the
   *  user for the synthesizer to render as DATA; never a tool result. */
  memoryContext?: string
}

/** Custom synthesis function type */
export type SynthesisFn = (input: CompactExecutionInput) => Promise<LLMResult<string>>

/** Configuration for compactExecution pattern */
export interface CompactExecutionConfig extends PatternConfig {
  mode: CompactExecutionMode
  /** REQUIRED: the synthesis implementation. Core hosts no default — the
   *  composition root supplies the BAML-backed one
   *  (`bamlPatterns().synthesize`). */
  synthesize: SynthesisFn
  /** Skip synthesis if response already exists */
  skipIfHasResponse?: boolean
}

/** Data interface for compactExecution */
export interface CompactExecutionData {
  response?: string
  synthesizedResponse?: string
  intent?: string
  loopHistory?: LoopHistory
  /** Written by `memoryRecall`, cleared by it every turn; read here (#419 M5a). */
  memoryContext?: string
}

// ============================================================================
// Event Data Payloads
// ============================================================================

/** Data payload for user_message event */
export interface UserMessageEventData {
  content: string
  /** Best-effort estimate of total chain turns, set by `harness()` from the
   *  composed patterns' `estimateTurns` projections. UI progress bars use
   *  this as the initial denominator before any pattern_enter arrives. */
  chainTurnEstimate?: number
}

/** Data payload for assistant_message event */
export interface AssistantMessageEventData {
  content: string
  /** Set to true on the compactExecution's user-facing final response. Used by
   *  chat-history replay to filter out intermediate router status messages
   *  (e.g. "Let me look into that…") that share the same event type.
   *  Absent / false on router/intermediate emits. */
  final?: boolean
}

/** Data payload for tool_call event */
export interface ToolCallEventData {
  /** Correlation ID linking this call to its result */
  callId?: string
  /** Shared ID grouping the sub-calls of one multi-call turn. Absent on
   *  singular calls. Purely observability metadata — pairing stays callId-based. */
  batchId?: string
  tool: string
  args: unknown
  /** Set when `args` did NOT come out of a strict `JSON.parse` of the model's
   *  `tool_args` — i.e. `repairJsonTracked` had to reconstruct them. A repaired
   *  call is otherwise indistinguishable downstream from one the model emitted
   *  cleanly, which #217(b) tracks as a hidden-repair-loop concern: without
   *  this the only record that a tool ran on rebuilt arguments is that it ran.
   *  Absent on the overwhelming majority of calls. */
  repaired?: import('./json-repair').JsonRepairNote
}

/** Data payload for tool_result event */
export interface ToolResultEventData {
  /** Correlation ID linking this result to its call */
  callId?: string
  /** Shared ID grouping the sub-calls of one multi-call turn (see ToolCallEventData). */
  batchId?: string
  tool: string
  result: unknown
  success: boolean
  error?: string
  /** LLM-generated summary of result (populated async after response) */
  summary?: string
  /** Hidden from LLM context (grayed out in Data tab, excluded from serializeCompact) */
  hidden?: boolean
  /** Moved to Archived section (also excluded from LLM context) */
  archived?: boolean
  /** Set by `withInjectionGuard` when this result's content was neutralized.
   *  `result` above already holds the SANITIZED content; this is the REDACTED
   *  audit pointer — counts, rule ids and the id of the `content_sanitized`
   *  event holding the verbatim spans. Deliberately NOT the full report: this
   *  payload is JSON-dumped wholesale by `judge` (and anything else that
   *  serializes `event.data`), so a full report here would hand the neutralized
   *  injection to the next LLM. See `SanitizeSummary`. */
  sanitized?: import('./injection-guard').SanitizeSummary
  /** The id of the request this result was HELD for (#433). Set when a resume,
   *  a supersede or an expiry replaced the `HeldResult` placeholder with the
   *  outcome; the placeholder's `summary` is deleted in the same step, so a
   *  compaction summary of "waiting for a decision" can never mask the
   *  outcome (#433 Δ2). */
  heldBy?: string
}

/** Data payload for controller_action event */
export interface ControllerActionEventData {
  action: ControllerAction
  /** 0-indexed turn within this loop pass — set by simpleLoop / actorCritic. */
  turn?: number
  /** Effective max turns for this loop instance (post-settings resolution).
   *  Loop patterns include this so consumers (e.g. progress UI) can size
   *  themselves without having to read the pattern config — which doesn't
   *  reflect runtime overrides like `settings.maxToolTurns`. */
  maxTurns?: number
}

/** Data payload for critic_result event */
export interface CriticResultEventData {
  result: CriticResult
}

/** Data payload for pattern_enter event */
export interface PatternEnterEventData {
  pattern: string
  /** Pattern's configured maxTurns (simpleLoop/actorCritic) — used by the UI
   *  progress bar to compute fill ratio per controller_action. */
  maxTurns?: number
}

/** Data payload for pattern_exit event */
export interface PatternExitEventData {
  status: CtxStatus
  error?: string
}

/** Data payload for error event */
export interface ErrorEventData {
  error: string
  stack?: string
  /** Whether the error is recoverable or terminal */
  severity?: 'recoverable' | 'irrecoverable'
  /** User-facing hint for resolving the error */
  hint?: string
  /** Loop turn number (0-indexed) when the error occurred */
  turn?: number
  /** Retry iteration (for actorCritic, 0-indexed) */
  iteration?: number
  /** The round budget in force when the loop stopped — always set alongside
   *  `kind: 'budget_exhausted'`, so a reader has BOTH halves of "7 of 8" and
   *  the panel can render the fraction. Absent on every other error. */
  maxTurns?: number
  /** The consecutive-recovery cap that ended the loop, in recoveries permitted
   *  — always set alongside `kind: 'recovery_exhausted'`, absent on every other
   *  error. */
  maxConsecutiveRecoveries?: number
  /** Origin of the error.
   *
   *  `llm_call` means the failure is attributable to an LLM call and the event
   *  carries that call's observability data on `ContextEvent.llmCall` —
   *  including `rawOutput`, the only record of what the model actually said.
   *  Two families qualify:
   *   - the CALL failed (parse error, fallback exhausted, network) — the
   *     adapters wrap these as `LLMCallError` so the pattern can re-attach;
   *   - the call SUCCEEDED and its content is the defect (a tool name off the
   *     allowlist, unparseable or output-cap-truncated `tool_args`).
   *
   *  `budget_exhausted` means nothing FAILED: the loop was stopped by its own
   *  round budget with the controller still working, so the turn's answer is
   *  whatever the completed rounds produced (#83, #269). It is a marker rather
   *  than a prose match because that is the difference between a panel badge
   *  and a test that can be broken by rewording a sentence — the two loops used
   *  to be identifiable only by `/^Loop exhausted/` and `/^Max retries/`. Read
   *  `maxTurns` beside it for the budget, `turn` / `iteration` for how far it
   *  got.
   *
   *  `recovery_exhausted` means the loop's consecutive-recovery cap ended it
   *  (`SimpleLoopConfig.maxConsecutiveRecoveries` /
   *  `ActorCriticConfig.maxConsecutiveRecoveries`): the loop had already fed
   *  back that many unusable answers in a row, and the next one is fatal
   *  exactly as it was before #437. The rest of the event is that failure's —
   *  its verbatim message, the pattern's severity and, as for `llm_call`, the
   *  failed call on `ContextEvent.llmCall` — so this marker REPLACES `llm_call`
   *  on that event rather than joining it. Read `maxConsecutiveRecoveries`
   *  beside it for the cap.
   *
   *  Absent for non-LLM errors (MCP failures, tool errors, etc.). */
  kind?: 'llm_call' | 'budget_exhausted' | 'recovery_exhausted'
}

/**
 * The side tasks a turn can lose without failing (#420): conveniences the turn
 * routes around rather than part of the answer the user asked for. Most are
 * `describe`-role calls; a task of another kind joins by getting its own member,
 * deliberately — never by reusing one of these (`skills_mount` is the first).
 * A marker, so the UI and the tests key on it rather than on the wording of
 * {@link WarningEventData.message}.
 */
export type WarningTask =
  /** The first-turn conversation title (`GenerateConversationTitle`). */
  | 'title'
  /** The post-turn tool-result summaries (`compactBulkData`). */
  | 'result_summaries'
  /** `compactIntent`'s standalone rewrite of the latest message. */
  | 'intent_compaction'
  /** The retriever's history-aware query rewrite. */
  | 'query_rewrite'
  /** `withReferences`' choice of prior results to attach. */
  | 'reference_selection'
  /** `@hames-ai/sandbox`'s mount of the run's skills into `/skills` (#415). */
  | 'skills_mount'

/**
 * Data payload for a `warning` event: a side task failed and the turn carried
 * on without it, on the fallback named in {@link WarningEventData.fallback}.
 *
 * Deliberately NOT an `error` event with a softer severity. Every reader of
 * `error` events treats one as a statement about the turn — `settleTurn` turns
 * "no response + an error" into a failed turn, `runChain` stops on an
 * irrecoverable one, and `compactExecution` hands `hasErrors()` to the
 * synthesizer, which then apologises for it in the answer. A side failure must
 * reach none of them, and a separate TYPE is what guarantees that: no error
 * reader can match it by accident, now or after the next one is written.
 *
 * Human-facing only. `formatEventData` renders it from `task` + `message`, never
 * from `error` — that string is the failed call's message verbatim, and a
 * describe call is handed tool results verbatim, so a parse failure can echo
 * them back.
 */
export interface WarningEventData {
  task: WarningTask
  /** What did not happen, in one sentence for the person reading the chat. */
  message: string
  /** What the turn did instead — the fallback it ran on. */
  fallback: string
  /** The underlying failure, verbatim, for the observability drill-down. */
  error?: string
}

/**
 * What a loop recovered from (#437 slice 1). A marker, so the panel and the
 * tests key on it rather than on the wording of {@link LoopRecoveryEventData.error}.
 */
export type LoopRecoveryFailure =
  /** The tool ran and reported failure. */
  | 'tool_error'
  /** Every call of a multi-call turn failed — ran and failed, or was refused
   *  before running. The per-call reasons are in `error`. */
  | 'batch_failed'
  /** The model named a tool that is not on the loop's allowlist. */
  | 'tool_not_allowed'
  /** The model's `tool_args` did not parse — malformed, or cut off at the
   *  output cap. */
  | 'invalid_tool_args'
  /** The controller's or actor's ANSWER could not be parsed into an action at
   *  all: the implementation threw an `LLMCallError` marked `recoverable`. */
  | 'unparseable_output'

/**
 * Data payload for a `loop_recovery` event: one failure inside `simpleLoop` or
 * `actorCritic` that was fed back to the model as that round's observation,
 * with the loop continuing on its remaining budget.
 *
 * Deliberately NOT an `error` event, for the reason `warning` is not one
 * (#420): every reader of `error` treats it as a statement about the TURN —
 * `settleTurn` turns "no response + an error" into a failed turn, `runChain`
 * stops on an irrecoverable one, `compactExecution` hands `hasErrors()` to the
 * synthesizer, which then apologises, and the chat paints a red bubble. A
 * failure the loop routed around is none of those (#235), and a separate TYPE
 * is what keeps every error reader from matching it by accident. If the loop
 * never recovers, the turn-level error comes from whichever bound it reaches
 * first: the budget (`kind: 'budget_exhausted'`), or — for a run of answers the
 * loop cannot use — the consecutive-recovery cap (`kind: 'recovery_exhausted'`),
 * whose final failure is that `error` and not one more `loop_recovery`.
 *
 * Always committed, and rendered metadata-only into LLM-facing serializations:
 * `error` can quote a tool's error text or a parse error that echoes the
 * model's own output, and the next prompt already carries both through the
 * loop's turn log.
 */
export interface LoopRecoveryEventData {
  failure: LoopRecoveryFailure
  /** The failure, verbatim — a tool's error, the refusal, or the parse error. */
  error: string
  /** The tool involved, when there is one. */
  tool?: string
  /** 0-indexed round (`simpleLoop`) or attempt (`actorCritic`) that failed. */
  turn: number
  /** The budget in force, so a reader has both halves of "3 of 12". */
  maxTurns: number
}

/** Data payload for reference_attached event — emitted by `withReferences` on pattern entry */
export interface ReferenceAttachedEventData {
  candidates: Array<{ ref_id: string; tool: string; summary: string }>
  selected: Array<{ ref_id: string; reason: string }>
  reasoning: string
  /** Set when the selector wasn't called (skip optimization fast-path) */
  skipped?: 'empty' | 'single' | 'cached'
}

/** Data payload for intent_compacted event — emitted by `compactIntent` once
 *  per chain invocation. Carries the rewritten brief and enough provenance to
 *  audit the rewrite in the observability panel. `llmCall` (on the
 *  ContextEvent) holds the BAML call detail. */
export interface IntentCompactedEventData {
  /** The self-contained brief written to `scope.data.intent`. */
  intent: string
  /** The user's raw latest message before rewriting. */
  latest: string
  /** Number of prior history messages fed to the rewrite. */
  historyLength: number
  /** Set when the LLM call was skipped (turn 1 has no back-references to
   *  resolve, so the latest message passes through unchanged). */
  skipped?: 'no-history'
}

/** Data payload for plan_created event — emitted by `planner` once per chain
 *  invocation. Mirrors `intent_compacted`: a dedicated observability event for
 *  an LLM step that produces no tool call. Deliberately NOT a
 *  `controller_action` (which #27 originally proposed): that payload is a real
 *  `ControllerAction`, and `compactExecution`'s thread mode turns every
 *  controller_action in view into a tool iteration — a synthetic one would
 *  render as a tool call that never happened. `llmCall` (on the ContextEvent)
 *  holds the BAML call detail. */
export interface PlanCreatedEventData {
  /** The plan written to `scope.data.plan` (post-truncation). Absent when
   *  `skipped` is set — there is no plan in that case. */
  plan?: PlanResult
  /** Number of tools the planner was shown — the catalog the adapter actually
   *  resolved (sandbox + gateway), not the raw name list the factory took. */
  toolCount: number
  /** Set when the plan text was capped by `PlannerConfig.maxPlanChars`. */
  truncated?: boolean
  /** Set when no LLM call was made: the context held no user message to plan
   *  for, so the chain runs unplanned. Mirrors
   *  `IntentCompactedEventData.skipped`. */
  skipped?: 'no-message'
}

/** Data payload for `content_sanitized` — emitted by `withInjectionGuard`
 *  whenever it neutralizes untrusted tool-result content (or when its optional
 *  LLM screen was unavailable). One event per affected tool result.
 *
 *  ⚠ `findings[].match` holds the injection VERBATIM. That is the one place the
 *  original text survives, and it is human-only: `formatEventData` renders this
 *  event type from metadata alone, precisely so a neutralized instruction can
 *  never be handed back to an LLM through a serialized event stream. Anything
 *  new that serializes events for a prompt must keep that property — see
 *  `__tests__/lib/harness-patterns/injection-guard-composition.test.ts`. */
export interface ContentSanitizedEventData {
  tool: string
  /** `inferServer(tool)` — the untrusted namespace the content came from. */
  namespace: string
  findings: import('./injection-guard').SanitizeFinding[]
  /** True when the LLM-visible content differs from the source — which includes
   *  a bare `spotlight: 'always'` fence, so this is NOT a synonym for "something
   *  was detected". Read `findings.length` for that: an event with no findings
   *  exists solely to report a screen outage, whatever `neutralized` says. See
   *  `SanitizeReport.neutralized`. */
  neutralized: boolean
  spotlighted: boolean
  /** Characters of untrusted text scanned. */
  scanned: number
  /** The LLM screen's reason, or why the screen could not run. */
  screenReason?: string
}

// ============================================================================
// Human in the loop (#433): the two events
// ============================================================================
//
// A request and its answer are two events in the context and nothing else:
// no decision rides `ctx.data`, and no store outside the context decides a
// resume (ADR-0009). `readHitl` (hitl.server.ts) derives the run's pending
// requests and its replay journal from them. Only core writes them: the
// public event paths refuse both types (`createEvent`, `trackEvent`) or drop
// any core did not mint (`commitEvents`, `chain()`).
//
// Both render METADATA ONLY into LLM-facing views — the kind, the request id,
// the choice and who made it. `question`, `summary`, `options` and
// `resolution` can hold strings an attacker chose (a sender, a filename), so
// they never reach a prompt (SD-3).

/** A boolean sub-choice collected with one option (provenance: `markInjected`). */
export interface HitlFlag {
  readonly id: string
  readonly label: string
  readonly default: boolean
  /** Choosing the option requires this flag to be true: a second confirmation. */
  readonly required?: boolean
}

/** One choice. A request's array order is its display order. */
export interface HitlOption<C extends string = string> {
  readonly id: C
  readonly label: string
  readonly description?: string
  /** The unattended rule may pick it. Default FALSE: an option is human-only
   *  unless it says otherwise. */
  readonly unattended?: boolean
  /** Choosing it ends the run; nothing is re-entered. */
  readonly stopsRun?: boolean
  /** Shown, not selectable, with this reason. */
  readonly unavailable?: string
  readonly flags?: readonly HitlFlag[]
  /** Presentation only. */
  readonly tone?: 'default' | 'caution' | 'danger'
}

/** What happens when nobody is there to ask. */
export type HitlUnattended = 'apply-default' | 'park' | 'stop'

/** Payload of a `hitl_request` event (`v: 1`). */
export interface HitlRequestEventData {
  readonly v: 1
  /** `crypto.randomUUID()`: unique, and an identifier, not a credential. */
  readonly requestId: string
  /** Informational: the id of the run's `user_message`. Binding uses the run
   *  window and `requestId`, never this. */
  readonly runId: string
  /** The replay key, always stored as `${kind}:${key}`. It must cover
   *  everything the decision authorizes [F8]. */
  readonly key: string
  /** Opaque to core: 'provenance', 'memory.confirm', 'confirm', … */
  readonly kind: string
  /** Consumer text. Never rendered into an LLM-facing view. */
  readonly question: string
  /** A frozen copy of the options: an answer is validated against THESE. */
  readonly options: readonly HitlOption[]
  readonly defaultOption: string
  readonly unattended: HitlUnattended
  /** Display only, and untrusted. Never rendered into an LLM-facing view. */
  readonly summary: Readonly<Record<string, string | number | boolean | null>>
  /** A handle into a host store: the payload itself never rides an event. */
  readonly payloadRef?: string
  readonly expiresAt?: number
  /** False for an out-of-run proposal, which never pauses a run and whose
   *  answer never replays into a gate. */
  readonly blocking: boolean
  /** Where a resume re-enters: the top-level index and the full top-level
   *  name list. */
  readonly resumeAt?: { readonly index: number; readonly names: readonly string[] }
  /** The opaque inference tier the run took. */
  readonly tier?: string
}

/** Who decided: a person, the unattended rule, or nobody (`expired`,
 *  `superseded`, whose `choice` is null). */
export type HitlDecidedBy = 'person' | 'unattended' | 'expired' | 'superseded'

/** Payload of a `hitl_response` event (`v: 1`): the decision on one request. */
export interface HitlResponseEventData {
  readonly v: 1
  readonly requestId: string
  readonly key: string
  readonly kind: string
  /** An option id, or null when nobody chose. */
  readonly choice: string | null
  readonly flags?: Readonly<Record<string, boolean>>
  readonly by: HitlDecidedBy
  /** Stamped by the host from its session, never taken from a client body. */
  readonly principal?: string
  /** What the host's resolve step returned. Never rendered into an
   *  LLM-facing view. */
  readonly resolution?: unknown
}

// ============================================================================
// Human in the loop (#433): asking, from inside a run
// ============================================================================

/** What a consumer asks: the input to `askHuman` (hitl.server.ts). Validated
 *  when it is raised — an invalid request throws `HitlRequestError`, because
 *  it is a wiring bug and never a runtime condition. */
export interface HitlRequest<C extends string = string> {
  /** Opaque to core: 'provenance', 'memory.confirm', 'confirm', … It must not
   *  contain ':', so the stored `${kind}:${key}` form is never ambiguous. */
  readonly kind: string
  /** Consumer text. Never an attacker-chosen string [m7]. */
  readonly question: string
  /** At least two, with unique ids. Array order IS display order. */
  readonly options: readonly HitlOption<C>[]
  /** Must name an option that exists and is available. */
  readonly defaultOption: C
  /** Replay identity within a run. It must cover everything the decision
   *  authorizes [F8]. Default: the sha256 of the question, the option-id set
   *  and the summary. Always stored as `${kind}:${key}`. */
  readonly key?: string
  /** Display only, and untrusted: never rendered into an LLM-facing view. */
  readonly summary?: Readonly<Record<string, string | number | boolean | null>>
  /** A handle into a host store; the payload itself never rides an event. */
  readonly payloadRef?: string
  /** What happens when nobody is there to ask. Default `'apply-default'`. */
  readonly unattended?: HitlUnattended
  readonly expiresInMs?: number
}

/** What `askHuman` tells its caller. `pending`: the run stops at the next
 *  boundary and a gated executor returns `held(outcome)` meanwhile. */
export type HitlOutcome<C extends string = string> =
  | {
      readonly status: 'answered'
      readonly requestId: string
      /** null when the unattended rule found nothing it may pick, and stopped. */
      readonly choice: C | null
      readonly flags: Readonly<Record<string, boolean>>
      readonly by: HitlDecidedBy
    }
  | { readonly status: 'pending'; readonly requestId: string }

/** What a gated tool executor returns while the run waits: the placeholder,
 *  never the content. A resume substitutes the outcome for it, sanitized, and
 *  marks the result `heldBy` (#433 S3). */
export interface HeldResult {
  readonly held: true
  readonly requestId: string
  readonly note: string
}

/** One answer to `resumeHarness`: a bare option id, or the id with the
 *  option's flags. Nothing else — no principal and no resolution: a client
 *  body passed straight through can choose only what a person chooses (#433,
 *  F4). The host stamps `principal`, and `resolve` returns the resolution. */
export type HitlAnswer =
  string | { readonly choice: string; readonly flags?: Readonly<Record<string, boolean>> }

/** `resumeHarness`'s answers, keyed by the `requestId` each one answers. Every
 *  request the run waits on must be answered, in one call. */
export type HitlAnswers = Readonly<Record<string, HitlAnswer>>

// ============================================================================
// Decisions (#418): the typedDecision seam
// ============================================================================
// Three layers: the raw seam (`DecideFn` → `DecideResult`) — one call, one
// distribution, no policy; the policy layer (`evaluateDecision`/`decide()` →
// `Decision`, `patterns/typedDecision.server.ts`) — applies a
// `DecisionPolicy`, records `decision_made`, never throws; and the transport
// behind the raw seam (a logprob readout on the private tier, Jev on the
// Anthropic tier, an explicitly configured verbalized secondary). Core owns
// the types and the pure policy math; the transports live in harness-baml and
// the app (#418 T3/T4/T5).

/** Cap on the label count of a `DecisionSpec` (D13). vLLM's default
 *  `--max-logprobs` is 20, and the logprob readout reads top-k logprobs — a
 *  spec wider than that cannot be read out faithfully. Refused at
 *  construction; `mode: 'joint'` refuses a LABEL PRODUCT above it, because a
 *  joint pass reads the product's mass from the same top-k window. */
export const MAX_DECISION_LABELS = 20

/** One label of a typed decision. `description` is the ONLY text the model
 *  sees for this label — the id is an identifier, not prose. */
export interface DecisionLabel<L extends string = string> {
  readonly id: L
  readonly description: string
}

/** One typed question over a closed label set. `key` is the prompt fragment,
 *  the calibration lookup, the threshold scope and the event key — one string,
 *  the same everywhere. `labels` carries 2..{@link MAX_DECISION_LABELS} unique
 *  ids; array order is display order (and the scorer's tie-break order). */
export interface DecisionSpec<L extends string = string> {
  readonly key: string
  readonly question: string
  readonly labels: readonly DecisionLabel<L>[]
}

/** The owner's "ONE call, SEVERAL typed fields" (D6). The PROVIDER decides how
 *  the set is served: Jev answers every field as its own typed question in ONE
 *  request; a logprob client runs one pass per field with a byte-identical
 *  state prefix (so the backend prefix cache serves it), unless `mode` is
 *  'joint'. */
export interface DecisionSetSpec<F extends Record<string, string>> {
  readonly key: string
  /** (F5) 'fields' (default) = one pass per field; 'joint' = score the label
   *  product in one pass and marginalise, only when the product is ≤
   *  {@link MAX_DECISION_LABELS}. A provider that is already one call (Jev)
   *  ignores this. */
  readonly mode?: 'fields' | 'joint'
  readonly fields: { readonly [K in keyof F]: DecisionSpec<F[K]> }
}

/** How the decision was read out. 'logprob' = answer-letter logprobs (the
 *  private tier); 'jev' = the hosted Jev decision model (Anthropic tier,
 *  calibrated); 'verbalized' = a chat model asked to state a choice — never
 *  calibrated. Widens to `string` at the merged consumer
 *  (`classifierFromDecide`), so a transport naming another method still
 *  typechecks there. */
export type DecisionMethod = 'logprob' | 'jev' | 'verbalized'

/** Why a decision was NOT taken. The scorer abstains in this order:
 *  'no-state' → 'error' → 'uncalibrated' → 'low-coverage' → 'method-mismatch'
 *  → 'low-confidence' → 'low-margin' — first reason wins, and the fallback
 *  label answers. */
export type AbstainReason =
  | 'low-confidence'
  | 'low-margin'
  | 'uncalibrated'
  | 'low-coverage'
  | 'error'
  | 'no-state'
  /** (F2) The serving method is not the method the static thresholds were
   *  fitted on (`policy.thresholdMethod`) and the applied calibration entry
   *  carries no cut of its own — a threshold tuned on one distribution means
   *  nothing on the other. */
  | 'method-mismatch'

/** The outcome the policy layer hands its consumer. `label` is the verdict to
 *  ACT ON — the top label when the policy passed, the policy's fallback
 *  otherwise. `top` is the argmax, `null` only when there is no distribution
 *  at all (an error or an empty state). */
export interface Decision<L extends string = string> {
  readonly key: string
  /** ACT ON THIS: `top` when the policy passed, else `policy.fallback`. */
  readonly label: L
  readonly top: L | null
  readonly probs: Readonly<Partial<Record<L, number>>>
  readonly margin: number
  /** (K·p_max − 1)/(K − 1) — p_max re-centred on the chance floor, so 0 is
   *  chance and 1 is certain regardless of K. */
  readonly confidence: number
  readonly abstained: boolean
  readonly reason?: AbstainReason
  readonly method?: DecisionMethod
  readonly calibrated: boolean
  /** Logprob only — the probability mass the top-k read attributed to a
   *  label. Not a Jev concept; stays absent there. */
  readonly coverage?: number
  /** Set by the policy layer after the `decision_made` event is committed. */
  readonly eventId?: string
}

/** The consumer's failure policy. `fallback` is REQUIRED (D8): the seam never
 *  throws, so a failed or abstained decision must always have a verdict to
 *  return, and an unexamined fallback is the defect. */
export interface DecisionPolicy<L extends string = string> {
  readonly fallback: L
  readonly minConfidence?: number
  readonly minMargin?: number
  /** (F2) The method these STATIC thresholds were fitted on. Default
   *  'logprob'. Applied only when the serving method equals it, unless the
   *  applied calibration entry carries its own cuts (which win) — otherwise
   *  the decision abstains 'method-mismatch'. */
  readonly thresholdMethod?: DecisionMethod
  /** Require a calibrated readout. Known-non-calibratable clients are refused
   *  BEFORE the call (F3) — a policy that would discard the result must not
   *  pay for it. */
  readonly requireCalibrated?: boolean
  /** Logprob floor on `coverage` — the mass the top-k read captured. An
   *  absent coverage fails the floor: unknown beats silently wrong. */
  readonly minCoverage?: number
}

/** Host-fed calibration for one (client, spec.key) pair. The temperature and
 *  bias are applied in log space by the logprob transport. Jev accepts fitted
 *  cuts only and refuses temperature or bias, including identity values (G7).
 *  The cuts, when present,
 *  are the entry's own and WIN over the policy's static thresholds (F2) —
 *  they are fitted on the very (client, question) pair that serves the call,
 *  so they are on-distribution by construction. */
export interface DecisionCalibrationEntry {
  readonly temperature?: number
  readonly bias?: Readonly<Record<string, number>>
  readonly minConfidence?: number
  readonly minMargin?: number
  readonly n?: number
  readonly fittedAt?: string
}

/** One raw-seam call: one spec, one state, no policy. The state is the TEXT
 *  the decision is asked over — the transport records it in
 *  `llmCall.variables` (the prompt drill-down), and nowhere else: no event
 *  carries it. */
export interface DecideInput<L extends string = string> {
  readonly spec: DecisionSpec<L>
  readonly state: string
}

/** The raw seam's outcome: one distribution over the spec's labels, with the
 *  method that produced it. No policy has been applied. Structurally the
 *  shape the merged `classifierFromDecide` consumer already accepts — its
 *  extra members (`coverage`, `llmCall`) are additions it ignores (D7). */
export interface DecideResult<L extends string = string> {
  readonly probs: Readonly<Record<L, number>>
  readonly method: DecisionMethod
  readonly calibrated: boolean
  readonly coverage?: number
  readonly llmCall?: LLMCallRecord
}

/** The raw decision seam. `limits` follows every other seam callable's shape
 *  (Lane A5): optional, resolved per call, and what the state trimmer trims
 *  against — a REST adapter has no model table to fall back on and reports
 *  its own cap (`JevDecide` → 32 000, D13). */
export type DecideFn = {
  <L extends string>(input: DecideInput<L>): Promise<DecideResult<L>>
  limits?: () => ModelLimits
  serving?: DecideServing
}

/** What a transport knows about the client it WILL serve a decision from,
 *  resolved per call from the spec key — the adapter's half of the F2/F3
 *  contract (T3/T4 fill it; `evaluateDecision` reads it).
 *
 *   - `method` is known BEFORE the call, which is what lets a
 *     `requireCalibrated` policy abstain without paying (F3).
 *   - `calibration` is the host-fed entry for (serving client, `key`); its
 *     cuts win over the policy's static thresholds (F2).
 *
 *  OPTIONAL, and its absence removes only the pre-call shortcut: the post-call
 *  `method-mismatch` / `uncalibrated` checks still run on the result's own
 *  `method` / `calibrated`. */
export type DecideServing = (key: string) => {
  readonly method?: DecisionMethod
  readonly calibration?: DecisionCalibrationEntry
}

/** The structured entry: several typed fields over one state (D6). NOTE (F6):
 *  no set-level `coverage` — coverage is per field, and the floors consume it
 *  there. */
export type DecideAllFn = {
  <F extends Record<string, string>>(input: {
    readonly spec: DecisionSetSpec<F>
    readonly state: string
  }): Promise<{ readonly fields: { readonly [K in keyof F]: DecideResult<F[K]> } }>
  limits?: () => ModelLimits
  serving?: DecideServing
}

/** Data payload for `decision_made` — one typed decision the policy layer
 *  evaluated (#418). METADATA ONLY, like `content_sanitized` and the `hitl_*`
 *  pair: the `state` the decision was asked over can hold sanitized mail
 *  bodies or tool results (SD-3/SD-10), and this payload is JSON-dumped
 *  wholesale by anything that serializes `event.data` — so the event carries
 *  `stateChars`, the SIZE, and never the text. The state survives in exactly
 *  one place, the transport's `llmCall.variables` (the prompt drill-down).
 *  Pinned by `decision-state-sentinel`. */
export interface DecisionMadeEventData {
  key: string
  question: string
  labels: Array<{ id: string; description: string }>
  probs: Record<string, number>
  /** The verdict — the top label when the policy passed, the fallback when
   *  abstained. */
  label: string
  top: string | null
  margin: number
  confidence: number
  abstained: boolean
  reason?: AbstainReason
  /** The policy AS DECLARED — the audit record of what was asked, including
   *  the `thresholdMethod` its static cuts were fitted on (F2). */
  policy: {
    fallback: string
    minConfidence?: number
    minMargin?: number
    thresholdMethod?: DecisionMethod
    requireCalibrated?: boolean
    minCoverage?: number
  }
  method?: DecisionMethod
  calibrated: boolean
  coverage?: number
  /** The SIZE of the state, never the text. */
  stateChars: number
  shadow?: true
}

// ============================================================================
// Memory recall (#419 M1)
// ============================================================================
//
// The injected seams and event payload of the `memoryRecall` chain step. Core
// hosts no database, no embedder and no provider vocabulary: a tier is an
// OPAQUE string (the run frame's own rule), and the store is whatever the host
// binds to its own owner.

/** A kind of memory — the closed set the store gate also writes. */
export type MemoryKind = 'episodic' | 'semantic' | 'preference' | 'trait'

/** One stored memory as recall reads it. `distance` is the COSINE DISTANCE
 *  between the query embedding and this row's embedding, computed by the
 *  store (`1 - distance` is the semantic similarity `s_v`). */
export interface MemoryCandidate {
  readonly id: string
  readonly kind: MemoryKind
  /** The tier this memory was written under. Opaque to core. */
  readonly tier: string
  readonly content: string
  /** The embedding space the row was embedded in. */
  readonly embedSpace: string
  readonly distance: number
  readonly lastSeenAt: Date | string | number
}

/**
 * The persistence seam recall reads through. HOST-BOUND TO ITS OWNER: no method
 * takes a user, so a call site cannot name another one. The store resolves its
 * owner on EVERY call, from the same supplier the host passes as `owner`:
 * patterns are built once and reused across turns, so an owner captured at
 * construction would serve whichever request reuses them. A `null` owner
 * refuses every method.
 *
 * Recall's query is EXACT — every active row of the owner in the requested
 * tiers, with its cosine distance; no `ORDER BY`/`LIMIT` — because BM25's
 * document frequencies are computed over exactly this corpus.
 */
export interface MemoryStore {
  /** How many rows of the owner's are visible in `tiers`. 0 ends recall
   *  before any gate or embedding is paid for. */
  count(tiers: readonly string[]): Promise<number>
  /** Every row of the owner's in `tiers`, with its distance to `embedding`.
   *  `embedSpace` is the space the query was embedded in; a row from another
   *  space is returned as it is and REFUSED by recall (a distance across two
   *  spaces is a number that means nothing). */
  candidates(query: {
    readonly embedding: readonly number[]
    readonly embedSpace?: string
    readonly tiers: readonly string[]
  }): Promise<MemoryCandidate[]>
}

/** The query half of the embedder seam (the document half is the store's). */
export interface MemoryQueryEmbedder {
  /** Embed a QUERY (the model's query instruction applies). */
  query(text: string): Promise<readonly number[]>
  /** The embedding space this embedder produces (`embeddingSpaceId()`). */
  readonly spaceId: string
}

/** The wake wait recall's gate shares with the host's wake — structurally
 *  the host's `awaitMemoryWake` (the app's joint memory wake). */
export type MemoryWakeWait = (budgetMs: number) => Promise<'awake' | 'skipped'>

/** Why recall attached nothing. */
export type MemorySkipReason =
  /** No owner resolved for the turn. */
  | 'no-user'
  /** The user's memory switch is off. */
  | 'disabled'
  /** No memory visible in this turn's tiers (no gate, no embedding paid). */
  | 'empty'
  /** The turn has no user message to ask about. */
  | 'no-query'
  /** The joint memory wake had not landed within the gate's budget (or failed). */
  | 'waking'
  /** The gate answered `skip`, abstained, errored or was out-of-set. */
  | 'gate'
  /** The gate budget expired with the wake already up. */
  | 'timeout'
  /** The gate said retrieve and nothing cleared the floors. */
  | 'no-match'
  /** Embedding, the store, the settings read or a space mismatch failed. */
  | 'error'

/** The gate's outcome as `memory_recalled` records it — the numbers, never the
 *  state it was asked over. (Recall records NO separate `decision_made`.) */
export interface MemoryGateRecord {
  readonly label: string
  readonly top: string | null
  readonly probs: Readonly<Record<string, number>>
  readonly margin: number
  readonly confidence: number
  readonly abstained: boolean
  readonly reason?: AbstainReason
  readonly method?: DecisionMethod
  readonly calibrated: boolean
  /** The SIZE of the gate state, never the text. */
  readonly stateChars: number
}

/** Data payload for `memory_recalled`. IDS ONLY (SD-3): a memory's content is
 *  user data and this payload is JSON-dumped wholesale by anything that
 *  serializes `event.data`. Pinned by `event-hygiene`. */
export interface MemoryRecalledEventData {
  /** The ids attached to the prompt, best first. Empty when `skipped`. */
  readonly attached: readonly string[]
  /** Rows read from the store (after the tier filter). */
  readonly considered: number
  /** Rows that cleared the floors, before the cap. */
  readonly survivors: number
  /** The turn's tier, as the run frame named it. */
  readonly tier?: string
  /** Estimated tokens of the attached block. */
  readonly tokens: number
  readonly skipped?: MemorySkipReason
  readonly gate?: MemoryGateRecord
  /** The joint wake's outcome as the gate saw it. */
  readonly wake?: 'awake' | 'skipped'
  /** The thrown error's CLASS, for `skipped: 'error'`. The message is logged,
   *  not recorded: an error can quote what it was reading. */
  readonly errorKind?: string
}

// ============================================================================
// Memory store (#419 M2)
// ============================================================================
//
// The injected seams and event payload of `settleMemory`, the store half of
// `withMemory`. Same rules as the recall half above: no database, no embedder,
// no provider vocabulary in core — the host binds the owner into the store it
// hands in, and a tier is an opaque string.

/** One candidate memory as the extractor returns it — UNFILTERED. `kind` is a
 *  plain string on purpose: the closed set is core's deterministic acceptance,
 *  and a candidate the adapter quietly dropped would be one acceptance could
 *  never log (structurally the harness-baml `ExtractedMemory`). */
export interface MemoryExtractedCandidate {
  readonly kind: string
  readonly content: string
  readonly evidence: string
}

/** What the extractor is handed (the `describe`-role call): the store gate's
 *  kind as a HINT, the labelled window, and the current user message bare so
 *  the evidence rule has ONE text to point at. */
export interface MemoryExtractInput {
  readonly kindHint: string
  readonly window: string
  readonly latestUser: string
}

/** The extractor seam — at most the first three candidates are read. */
export type MemoryExtractFn = (
  input: MemoryExtractInput,
) => Promise<LLMResult<readonly MemoryExtractedCandidate[]>>

/** The full embedder seam: recall's query half plus the DOCUMENT side (no
 *  query instruction). Company-run; the host pins its provider. */
export interface MemoryEmbedder extends MemoryQueryEmbedder {
  /** Embed stored texts, one vector per text, in order. */
  documents(texts: string[]): Promise<number[][]>
}

/** The nearest ACTIVE memory of the owner to a candidate, same tier and same
 *  embedding space, with its cosine SIMILARITY (`1 - distance`). */
export interface MemoryNeighbor {
  readonly id: string
  readonly kind: MemoryKind
  readonly content: string
  readonly similarity: number
}

/** A memory to insert. The host encrypts `content`/`evidence` on write. */
export interface MemoryInsertRow {
  readonly id: string
  readonly kind: MemoryKind
  readonly tier: string
  readonly content: string
  readonly evidence: string
  /** The `user_message` event `evidence` quotes (#419 erasure semantics (b)).
   *  The host stores it BESIDE the text it describes, on the memory row, and
   *  replaces both together on `update`. Required, so every writer (M3's
   *  compaction insert included) is a compile error without it. */
  readonly evidenceEventId: string
  readonly embedding: readonly number[]
  readonly embedSpace: string
}

/** The provenance row: which conversation event a memory was built from.
 *
 *  Erasure semantics (#419 owner decision (b)): a source row is NEVER removed
 *  because a memory's text moved on. An `update` (and M3's compaction) keeps
 *  every row that ever supported the memory, including those that no longer
 *  support its current text, so deleting a conversation removes every memory
 *  that EVER drew on it. A host's only legitimate deletions are the
 *  conversation delete, the memory's own forget, and the cascade between them. */
export interface MemorySourceRow {
  readonly memoryId: string
  readonly eventId: string
  readonly ordinal: number
  readonly conversationId: string
}

/**
 * The write half of the persistence seam, handed to ONE transaction. Owner-bound
 * like {@link MemoryStore}: no method takes a user.
 *
 * Every call here belongs to the transaction `MemoryWriteStore.transaction`
 * opened — they commit together or roll back together, which is the whole of
 * the idempotency guarantee (F9).
 */
export interface MemoryWriteTx {
  /** Nearest memory of the owner's in `tier` and `embedSpace`, or null. */
  nearest(q: {
    readonly embedding: readonly number[]
    readonly embedSpace: string
    readonly tier: string
  }): Promise<MemoryNeighbor | null>
  insert(row: MemoryInsertRow): Promise<void>
  /** Count this sighting: `evidence_count + 1`, `last_seen_at = now`. */
  reinforce(id: string): Promise<void>
  /** Replace a memory's text and vector with a newer statement of the same
   *  fact, and count the sighting. It replaces `evidence` and
   *  `evidenceEventId` together and DELETES NO `memory_sources` row: the rows
   *  that supported the old text stay (decision (b), see `MemorySourceRow`). */
  update(
    id: string,
    next: {
      readonly content: string
      readonly evidence: string
      readonly evidenceEventId: string
      readonly embedding: readonly number[]
      readonly embedSpace: string
    },
  ): Promise<void>
  /** Insert the provenance row. On a primary-key conflict on
   *  `(owner, eventId, ordinal)` — this candidate was written before — insert
   *  nothing and return `{ inserted: false, memoryId }` with the memory the
   *  EXISTING row points at (`ON CONFLICT DO NOTHING RETURNING`; a bare INSERT
   *  would abort the whole transaction). */
  addSource(
    src: MemorySourceRow,
  ): Promise<{ inserted: true } | { inserted: false; memoryId: string }>
  /** Read one memory of the owner's by id, or null. Used only to re-record a
   *  lost `memory_written` on a retry. */
  read(id: string): Promise<{ kind: MemoryKind; content: string } | null>
  /** Rows the owner has, all tiers (the compaction threshold's input). */
  count(): Promise<number>
}

/**
 * The write seam. `transaction(fn)` MUST: open ONE database transaction; take
 * the owner's advisory lock inside it (`pg_advisory_xact_lock`), so two
 * concurrent stores for one user — and compaction — serialize; run `fn`;
 * COMMIT if it resolved; ROLLBACK and rethrow if it threw. A host whose
 * transaction does not roll back on a throw breaks idempotency.
 */
export interface MemoryWriteStore {
  transaction<R>(fn: (tx: MemoryWriteTx) => Promise<R>): Promise<R>
}

/** What a stored memory's event says happened to it. */
export type MemoryWriteAction = 'inserted' | 'reinforced' | 'updated'

/** Data payload for `memory_written`. METADATA ONLY (SD-3): ids, kind, tier and
 *  action — no content and no value derived from it. A hash of a short memory
 *  is a confirmable fingerprint of the text, and the event outlives the memory
 *  in every other conversation that recorded it (#541). Pinned by
 *  `event-hygiene`. */
export interface MemoryWrittenEventData {
  readonly memoryId: string
  readonly kind: MemoryKind
  readonly tier: string
  /** The `user_message` event the memory was built from. */
  readonly eventId: string
  readonly ordinal: number
  readonly action: MemoryWriteAction
}

// ============================================================================
// LLM Call Observability
// ============================================================================

/** LLM call observability data - attached to events involving LLM calls */
export interface LLMCallData {
  /** BAML function name (e.g., 'LoopController', 'Critic', 'Synthesize') */
  functionName: string
  /** Input parameters passed to the BAML function */
  variables: Record<string, unknown>
  /** BAML prompt template with {{ variable }} placeholders */
  promptTemplate?: string
  /** Rendered prompt / HTTP request body */
  rawInput?: string
  /** Raw LLM response string before parsing */
  rawOutput?: string
  /** Structured output after BAML parsing */
  parsedOutput?: unknown
  /** Token usage of the SELECTED exchange (the prompt/response pair shown in
   *  the drill-down). For the step's total spend across all attempts, use
   *  `metrics` / `event.metrics`. */
  usage?: {
    /** Input tokens NOT served from cache (Anthropic: `input_tokens`) */
    inputTokens: number
    outputTokens: number
    /** Cache-READ input tokens (0.1× rate; Anthropic: `cache_read_input_tokens`) */
    cachedInputTokens: number
    /** Cache-WRITE input tokens (1.25× rate; Anthropic: `cache_creation_input_tokens`) */
    cacheCreationInputTokens?: number
    /** All tokens processed: uncached + cache read + cache write + output */
    totalTokens: number
  }
  /** Step-level accounting summed across ALL attempts this call made
   *  (truncation retry, fallback chains). Lifted onto `event.metrics` by
   *  trackEvent — this field is the carrier from adapter to event. */
  metrics?: EventMetrics
  /** Call duration in milliseconds */
  durationMs?: number
  /** LLM provider name (e.g., 'openai', 'anthropic') */
  provider?: string
  /** Client name from BAML config */
  clientName?: string
}

/** What core knows about a finished model call: {@link LLMCallData} plus one
 *  field. This is the record an injected LLM function returns inside
 *  {@link LLMResult} (#225 Lane A3) — core reads the record it is handed back
 *  instead of passing a `Collector` write-handle down.
 *
 *  Why the extra field lives here and not in `LLMCallData`: only the
 *  IMPLEMENTATION knows the cap its client ran against, so only it may say
 *  whether the response was cut off — the pattern layer reads the boolean and
 *  never sees the cap table (SA-C2 stays beside `baml_src/`). */
export type LLMCallRecord = LLMCallData & {
  /** The call was cut off at its own client's `max_tokens` cap. Absent means
   *  the record predates the stamp or the implementation could not know —
   *  never read as "no cap" (unknown ≠ uncapped). */
  hitOutputCap?: boolean
}

/** What an injected LLM function returns: the parsed value plus the record of
 *  the call that produced it. `call` is optional because some implementations
 *  legitimately produce a value without a model call (caches, overrides).
 *
 *  Rolled out per the design note's migration order: `SynthesisFn` returns it
 *  as of Lane A3 (closing the no-tracking hole where a custom synthesis
 *  override emitted no `llmCall` at all); the controller/actor/critic seams
 *  adopt it at A4 when their positional signatures become object seams. */
export interface LLMResult<T> {
  value: T
  call?: LLMCallRecord
}

/** Error thrown by an LLM implementation when a call fails AFTER reaching the
 *  model (#232 MUST: the raw response must survive a parse failure). The
 *  carried record is what lets the catching pattern attach the same
 *  Prompt/Output drill-down to its `error` event that a successful call
 *  attaches — the throw contract is the seam's, not one adapter's, so the
 *  class lives in core (Lane A3; it moved here from the BAML adapters and is
 *  re-exported from there for existing import paths).
 *
 *  Recovered fallback/retry attempts never produce this — only the final
 *  propagating failure does. */
export class LLMCallError extends Error {
  readonly llmCall: LLMCallRecord
  readonly cause?: unknown
  /**
   * The failure is in the model's ANSWER — it came back and could not be
   * parsed (malformed, empty, or cut off at the output cap) — so asking again,
   * told why, can succeed. `simpleLoop` and `actorCritic` feed such a failure
   * back as the round's observation and continue on their remaining budget
   * (#437 slice 1).
   *
   * Only the IMPLEMENTATION can know this (the BAML adapters set it for
   * `BamlValidationError`), so core never infers it from the message. False
   * covers everything else — a transport error, a timeout, an abort, and any
   * failure the implementation did not classify — and the loops keep all of
   * those fatal: the model never answered, so there is nothing to feed back,
   * and the next call would most likely fail the same way.
   */
  readonly recoverable: boolean
  constructor(
    message: string,
    llmCall: LLMCallRecord,
    cause?: unknown,
    options?: { recoverable?: boolean },
  ) {
    super(message)
    this.name = 'LLMCallError'
    this.llmCall = llmCall
    if (cause !== undefined) this.cause = cause
    this.recoverable = options?.recoverable === true
  }
}

// ============================================================================
// Helper Functions Types
// ============================================================================

/** Function to check if event type should be tracked */
export type ShouldTrackFn = (type: EventType, trackHistory: TrackHistory) => boolean

// ============================================================================
// Router / Routes Config
// ============================================================================

/** Sentinel route name for direct conversational responses (no tool) */
export const DIRECT_RESPONSE_ROUTE = 'user'

/** Configuration for router pattern */
export interface RouterConfig extends PatternConfig {
  /** Route name set when responding directly without a tool (default: 'user') */
  directResponseRoute?: string
  /** REQUIRED: the routing implementation (Lane A6 seam). Core hosts no
   *  default — the composition root supplies `routeMessageOp`
   *  (`bamlPatterns().router`; see {@link RouteFn}). */
  route: RouteFn
}

/** Configuration for routes dispatch pattern */
export interface RoutesConfig extends PatternConfig {
  /** Must match the directResponseRoute of the paired router (default: 'user') */
  directResponseRoute?: string
}

// ============================================================================
// Constants
// ============================================================================

// The loop round budgets live in `lib/settings.ts` (`DEFAULT_SETTINGS`, bounded
// by `SETTINGS_BOUNDS`, resolved per pattern by `resolveTurnBudget`). Two
// exported constants used to restate them here, read by nothing but their own
// tests; #269 raised the default and deleted the copy rather than leaving a
// second declaration free to disagree with the one the loops actually run on.

/**
 * Static USD→EUR rate the pricing folds multiply by — the library-side default
 * the host's settings extend (the app may override it at `EUR_PER_USD`, read
 * per call in its own cost-rates module). One definition, here: the event
 * metrics fold (`metrics/aggregate.ts`) needs it to convert pre-EUR `costUsd`
 * stamps, and the host re-exports this constant rather than restating it, so
 * the two cannot disagree.
 *
 * 0.86 ≈ EUR/USD 1.16, the rate around 2026-08. Update by hand; the figure it
 * feeds is labelled an estimate everywhere it renders. The multiplication
 * direction is named on purpose — see the host's `pricing-eur` pin, which
 * scans for the reversed spelling.
 */
export const DEFAULT_EUR_PER_USD = 0.86

/** Default trackHistory by pattern type */
export const DEFAULT_TRACK_HISTORY: Record<string, TrackHistory> = {
  simpleLoop: ['controller_action', 'tool_call', 'tool_result'],
  actorCritic: ['controller_action', 'tool_call', 'tool_result', 'critic_result'],
  compactExecution: 'assistant_message',
  router: true,
  routes: false,
  chain: false,
  compactIntent: 'intent_compacted',
  // The plan IS the planner's deliverable — track it so it survives in
  // ctx.events (and the observability panel) even when a later pattern errors.
  planner: 'plan_created',
  // The retriever's matches are surfaced as a tool_result (the channel the
  // compactExecution reads via view.fromLastPattern()) — same as a simpleLoop tool.
  retriever: ['tool_result'],
  // The decision IS the deliverable (#418): track it so the distribution
  // survives in ctx.events and the panel. `error` is always tracked anyway.
  typedDecision: 'decision_made',
  decisionRouter: 'decision_made',
  // The recall outcome IS the deliverable (#419): which ids were attached, or
  // why nothing was. Ids only.
  memoryRecall: 'memory_recalled',
}

/** Default commitStrategy by pattern type */
export const DEFAULT_COMMIT_STRATEGY: Record<string, CommitStrategy> = {
  simpleLoop: 'on-success',
  actorCritic: 'on-success',
  compactExecution: 'always',
  router: 'always',
  routes: 'always',
  chain: 'always',
  compactIntent: 'always',
  planner: 'always',
  retriever: 'always',
  // A decision a consumer acted on must stay explainable on a failed turn
  // (`decision_made` is in ALWAYS_COMMIT_TYPES regardless, #418).
  typedDecision: 'always',
  decisionRouter: 'always',
  memoryRecall: 'always',
}

/**
 * Default errorSeverity by pattern type — and, since #273 D-d, the map that
 * decides whether an `error` event STOPS THE CHAIN.
 *
 * `runChain` reads it (through `resolveConfig`, and only when the event itself
 * carries no `severity`): an irrecoverable error ends the turn where it
 * happened instead of letting the patterns after it answer around the hole.
 * Before that it fed presentation only — `errorBubble` paints recoverable as a
 * warning and everything else as an error — so a wrong entry here was cosmetic.
 * It is not any more. The question each entry answers is the owner's:
 *
 *   **can this turn still produce an honest answer after this failure?**
 *
 * Yes → `recoverable`, whatever else the failure cost. No → `irrecoverable`,
 * because the alternative is a downstream synthesizer composing a confident
 * answer out of nothing, which is the failure mode the app-path e2e suite calls
 * dishonest.
 *
 * Every pattern type in this package has an entry, so `resolveConfig`'s
 * fallback only ever covers a custom `configurePattern` name.
 */
export const DEFAULT_ERROR_SEVERITY: Record<string, 'recoverable' | 'irrecoverable'> = {
  // The loops may self-heal on the next iteration, and when they cannot, they
  // still return their partial results: a loop that exhausts `maxTurns`
  // records a recoverable error and the synthesizer answers from what it got
  // (#83). Note this is the PATTERN default — the loops stamp a severity on
  // each error event themselves, and one of them is deliberately harsher: a
  // collapsed tool surface is stamped irrecoverable at the event, because no
  // further iteration of THAT loop can bring the tools back (#276).
  simpleLoop: 'recoverable',
  actorCritic: 'recoverable',
  // compactExecution is the answer. If it fails there is nothing to show, so
  // there is nothing for a later pattern to add — and `settleTurn` already
  // reports the turn as failed on exactly this shape (empty response + an
  // error).
  compactExecution: 'irrecoverable',
  // A router failure clears `data.route`, and `routes()` then throws rather
  // than dispatching last turn's route — so this classification agrees with
  // what already happens one pattern later, and now says it at the pattern
  // that actually failed instead of via a message about missing wiring.
  router: 'irrecoverable',
  // routes' own error is "the router named a route I do not have". Nothing ran,
  // so every pattern after this one would be composing from an empty
  // execution.
  routes: 'irrecoverable',
  chain: 'irrecoverable',
  // compactIntent is best-effort: on failure it leaves intent unset and the
  // downstream actor falls back to the raw user message — never fatal.
  compactIntent: 'recoverable',
  // planner is best-effort: on failure it CLEARS scope.data.plan (which is
  // carried across turns, so leaving it alone would re-inject the previous
  // question's plan) and the downstream loop runs unplanned — never fatal.
  planner: 'recoverable',
  // retriever is best-effort: a backend failure yields empty matches and the
  // compactExecution answers from whatever else is in context — never fatal.
  retriever: 'recoverable',
  // typedDecision never throws and always leaves a verdict (`policy.fallback`,
  // REQUIRED), so a failed decision is the consumer's abstain, not a hole in
  // the turn — the consumer that cannot proceed on its fallback says so itself.
  typedDecision: 'recoverable',
  // memoryRecall NEVER stops what follows it (#419): every failure ends in
  // `memories = []` and a return. Memory is opportunistic; the turn is not.
  memoryRecall: 'recoverable',
  // decisionRouter has router's failure shape: a failed decision clears
  // `data.route` and `routes()` would throw on it, so it stops the turn where
  // it happened (parity with `router`; #418 D10). `errorSeverity: 'recoverable'`
  // turns that into "continue on `policy.fallback`".
  decisionRouter: 'irrecoverable',
  // ---------------------------------------------------------------------------
  // The FIVE best-effort types were unlisted until #273 D-d, and therefore
  // inherited `resolveConfig`'s `'irrecoverable'` fallback; the three that
  // survive ADR-0006 are below, the other two having gone with the patterns
  // they classified. That was harmless while nothing read severity for control
  // flow and wrong the moment something did: each of these emits `error` events
  // for things a turn plainly survives, so a chain-fatal default would have let
  // one kill the turn. They are spelled out rather than left to the fallback so
  // the next reader sees a decision instead of an omission.
  // ---------------------------------------------------------------------------
  // judge is advisory ranking. "No candidates to evaluate" is a normal outcome
  // of an execution that found nothing, not a reason to stop.
  judge: 'recoverable',
  // parallel logs one event per rejected BRANCH and keeps every fulfilled
  // one — the surviving branches are exactly what the rest of the chain is for.
  parallel: 'recoverable',
  // withReferences failing means the inner pattern ran without curated prior
  // results, i.e. the behaviour it had before the wrapper existed.
  withReferences: 'recoverable',
}
