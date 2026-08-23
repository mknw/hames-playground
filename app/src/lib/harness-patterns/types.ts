/**
 * Harness Patterns - Types
 *
 * Pure TypeScript interfaces. Safe to import from client and server.
 */

// Re-export BAML types for convenience
export type {
  ControllerAction,
  CriticResult,
  Attempt,
  FewShot,
  ToolCallRequest,
  PlanResult,
} from '../../../baml_client/types'

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
  additionalCalls?: import('../../../baml_client/types').ToolCallRequest[]
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
  | 'approval_request'
  | 'approval_response'
  | 'error'
  | 'reference_attached'
  | 'intent_compacted'
  | 'plan_created'
  | 'content_sanitized'

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
  /** Estimated cost in USD at the rates below; absent when any attempt's
   *  client has no pricing entry (unknown beats silently wrong) */
  costUsd?: number
  /** Same tokens priced with zero caching — the savings baseline */
  noCacheUsd?: number
  /** $/MTok rates used for the final attempt's client (audit trail) */
  rates?: { inPerMTok: number; outPerMTok: number }
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
// Controller & Critic Function Types
// ============================================================================

/**
 * Controller function type for simpleLoop pattern.
 * Matches BAML-generated function signatures.
 * Uses rest params to accommodate different controller signatures (with/without schema).
 */
export type ControllerFn = (
  user_message: string,
  intent: string,
  previous_results: string,
  n_turn: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ...extra: any[]
) => Promise<import('../../../baml_client/types').ControllerAction>

/**
 * Critic function type for actorCritic pattern.
 * Matches BAML-generated function signatures.
 */
export type CriticFn = (
  intent: string,
  previous_attempts: ScriptExecutionEvent[],
) => Promise<import('../../../baml_client/types').CriticResult>

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
   *  every shot and is sent on every turn. */
  fewShots?: import('../../../baml_client/types').FewShot[]
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
   *  fails. Lets agents accept dynamically-created tools (e.g. the kg-agent
   *  a backend that registers tools at runtime) without enumerating every
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
}

/** Configuration for actorCritic pattern */
export interface ActorCriticConfig extends PatternConfig {
  /** Available tools for the actor */
  availableTools?: string[]
  /** Max retries before giving up (default: 3) */
  maxRetries?: number
  /** Hook to enrich/transform a tool result before the `tool_result` event is
   *  committed. See `OnToolResult`. */
  onToolResult?: OnToolResult
  /** Regex matched against `action.tool_name` after the strict allowlist
   *  fails. Lets agents accept dynamically-created tools (e.g. the kg-agent
   *  a backend that registers tools at runtime) without enumerating every
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
  /** Override the default LLM-driven selector */
  selector?: SelectorFn
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
   *  (`chain`, `routes`, `parallel`, `guardrail`, `hook`,
   *  `withReferences`). Leaf patterns omit it. Purely for static
   *  introspection of the pattern graph — execution runs through `fn`, never
   *  this — so it's safe and additive. See `pattern-capabilities.ts`
   *  (`harnessHasRetriever`) for the canonical walk. */
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
// Approval
// ============================================================================

export interface ApprovalRequest {
  action: string
  payload: unknown
  reason: string
}

export interface WithApproval {
  pendingAction?: ApprovalRequest
  approved?: boolean
}

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
  action: import('../../../baml_client/types').ControllerAction
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
}

/** Custom synthesis function type */
export type SynthesisFn = (input: CompactExecutionInput) => Promise<string>

/** Configuration for compactExecution pattern */
export interface CompactExecutionConfig extends PatternConfig {
  mode: CompactExecutionMode
  /** Custom synthesis function (defaults to BAML CreateToolResponse) */
  synthesize?: SynthesisFn
  /** Skip synthesis if response already exists */
  skipIfHasResponse?: boolean
}

/** Data interface for compactExecution */
export interface CompactExecutionData {
  response?: string
  synthesizedResponse?: string
  intent?: string
  loopHistory?: LoopHistory
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
}

/** Data payload for controller_action event */
export interface ControllerActionEventData {
  action: import('../../../baml_client/types').ControllerAction
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
  result: import('../../../baml_client/types').CriticResult
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

/** Data payload for approval_request event */
export interface ApprovalRequestEventData {
  request: ApprovalRequest
}

/** Data payload for approval_response event */
export interface ApprovalResponseEventData {
  approved: boolean
  reason?: string
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
  /** Origin of the error. `llm_call` means the failure is attributable to an
   *  LLM call and the event carries that call's observability data on
   *  `ContextEvent.llmCall` — including `rawOutput`, the only record of what
   *  the model actually said. Two families qualify:
   *   - the CALL failed (parse error, fallback exhausted, network) — the
   *     adapters wrap these as `LLMCallError` so the pattern can re-attach;
   *   - the call SUCCEEDED and its content is the defect (a tool name off the
   *     allowlist, unparseable or output-cap-truncated `tool_args`).
   *  Absent for non-LLM errors (MCP failures, tool errors, etc.). */
  kind?: 'llm_call'
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
  plan?: import('../../../baml_client/types').PlanResult
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
}

/** Configuration for routes dispatch pattern */
export interface RoutesConfig extends PatternConfig {
  /** Must match the directResponseRoute of the paired router (default: 'user') */
  directResponseRoute?: string
}

// ============================================================================
// Constants
// ============================================================================

export const MAX_TOOL_TURNS = 5
export const MAX_RETRIES = 3

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
}

/** Default errorSeverity by pattern type.
 *  Loops are recoverable (may self-heal on next iteration);
 *  non-loop patterns are irrecoverable (no retry mechanism). */
export const DEFAULT_ERROR_SEVERITY: Record<string, 'recoverable' | 'irrecoverable'> = {
  simpleLoop: 'recoverable',
  actorCritic: 'recoverable',
  compactExecution: 'irrecoverable',
  router: 'irrecoverable',
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
}
