/**
 * Harness Patterns - Public API
 *
 * Functional, composable framework for agentic tool execution.
 */

// ============================================================================
// Core Types
// ============================================================================

export type {
  // Context Types
  UnifiedContext,
  PatternScope,
  ContextEvent,
  EventType,
  EventView,
  ScopedPattern,
  ConfiguredPattern,
  CtxStatus,
  HarnessResult,

  // Configuration Types
  PatternConfig,
  PatternCapabilities,
  ViewConfig,
  ContentTransform,
  CommitStrategy,
  TrackHistory,

  // Controller/Critic Types
  // `ControllerFn` (the object seam, Lane A4) lives beside its implementation;
  // the dead positional `ControllerFn`/`CriticFn` types are deleted (A4).

  // BAML Types (re-exported)
  ControllerAction,
  CriticResult,
  ScriptExecutionEvent,
  FewShot,
  PlanResult,

  // Router Config Types
  RouterConfig,
  RoutesConfig,

  // Pattern Config Types
  SimpleLoopConfig,
  ActorCriticConfig,
  CompactExecutionConfig,
  CompactExecutionMode,
  CompactExecutionInput,
  SynthesisFn,
  CompactExecutionData,

  // Loop History Types
  LoopHistory,
  LoopIteration,
  WithLoopHistory,

  // Event Data Payloads
  UserMessageEventData,
  AssistantMessageEventData,
  ToolCallEventData,
  ToolResultEventData,
  ControllerActionEventData,
  CriticResultEventData,
  PatternEnterEventData,
  PatternExitEventData,
  ErrorEventData,
  IntentCompactedEventData,
  PlanCreatedEventData,
  ContentSanitizedEventData,
  WarningEventData,
  WarningTask,
  LoopRecoveryEventData,
  LoopRecoveryFailure,

  // Human in the loop (#433)
  HitlFlag,
  HitlOption,
  HitlUnattended,
  HitlRequestEventData,
  HitlDecidedBy,
  HitlResponseEventData,
  HitlRequest,
  HitlOutcome,
  HeldResult,
  HitlAnswer,
  HitlAnswers,

  // Decisions (#418)
  DecisionLabel,
  DecisionSpec,
  DecisionSetSpec,
  DecisionMethod,
  AbstainReason,
  Decision,
  DecisionPolicy,
  DecisionCalibrationEntry,
  DecideInput,
  DecideResult,
  DecideFn,
  DecideAllFn,
  DecideServing,
  DecisionMadeEventData,

  // Memory recall (#419)
  MemoryKind,
  MemoryCandidate,
  MemoryStore,
  MemoryExtractedCandidate,
  MemoryExtractInput,
  MemoryExtractFn,
  MemoryEmbedder,
  MemoryNeighbor,
  MemoryInsertRow,
  MemorySourceRow,
  MemoryWriteTx,
  MemoryWriteStore,
  MemoryWriteAction,
  MemoryWrittenEventData,
  MemoryQueryEmbedder,
  MemoryWakeWait,
  MemorySkipReason,
  MemoryGateRecord,
  MemoryRecalledEventData,

  // LLM Observability
  LLMCallData,
  LLMCallRecord,
  LLMResult,
  ModelLimits,
  CostBasis,

  // Infrastructure types
  MCPToolDescription,
  ToolCallResult,
  ToolSet,
} from './types'

export { DEFAULT_TRACK_HISTORY, DEFAULT_COMMIT_STRATEGY, DEFAULT_ERROR_SEVERITY } from './types'
export { MAX_DECISION_LABELS } from './types'

// The LLM call envelope's error class is a runtime value (instanceof checks in
// the patterns) — exported from the barrel for the first time in Lane A3.
export { LLMCallError } from './types'

// ============================================================================
// Tools
// ============================================================================

export {
  Tools,
  ToolsFrom,
  inferServer,
  registerToolNamespaces,
  type ToolsOptions,
  type NamespaceResolver,
} from './tools.server'

// ============================================================================
// Tool transports (the containment seam)
// ============================================================================
//
// Two structurally different ways to supply a transport, and the difference
// between them is the containment invariant: SCOPED transports ride the run
// frame's `transports` slot (supplied at `withRunFrame`, amended below it by
// `withSandbox`), PROCESS transports the registry below. `processTransports()`
// is deliberately NOT here: dispatch and the tool catalog are its only readers.
// See `tool-transport.server.ts`.

export { registerTransport, activeTransports, type ToolTransport } from './tool-transport.server'

// ============================================================================
// The run frame — one ambient scope per run, holding every slot a run needs
// ============================================================================
//
// A consumer using the harness entry points never calls any of this: they open
// the frame themselves. `withRunFrame({}, fn)` is what a script or a background
// job that drives patterns directly needs, because `runChain` refuses without
// one. See `run-frame.server.ts`.

export {
  withRunFrame,
  amendRunFrame,
  activeRunFrame,
  currentRunFrame,
  type RunFrame,
  type ActiveRunFrame,
  type InferenceSlot,
  type LiveEventSlot,
  type LiveEventListener,
  type RunClientOverride,
} from './run-frame.server'

// ============================================================================
// Router
// ============================================================================

export { router, routes, type Routes, type RoutePatterns, type RouterData } from './patterns'
export { DIRECT_RESPONSE_ROUTE } from './types'

// ============================================================================
// Pattern capabilities (static introspection)
// ============================================================================

export {
  isRetrieverConfig,
  harnessHasRetriever,
  harnessHasRedisRetriever,
  declaresWorkspaceSync,
  harnessUsesSyncWorkspace,
  harnessDecisionKeys,
  harnessCalibratedDecisionKeys,
  harnessUsesMemory,
} from './pattern-capabilities'

// ============================================================================
// Harness
// ============================================================================

export {
  harness,
  resumeHarness,
  continueSession,
  type Harness,
  type HarnessData,
  type HarnessResultScoped,
  type ResumeOptions,
} from './harness.server'

// ============================================================================
// Human in the loop (#433)
// ============================================================================
//
// The two `hitl_*` events are written by core only. `askHuman` is how a run
// asks (from a pattern body or a tool executor); `held` is what a gated
// executor returns while it waits; `hitlPending` is the stop check a custom
// loop makes between steps; `resolveUnattended` is the rule applied when
// nobody is there. `readHitl` and `answerOf` read the events.
// `answerOf(view, kind, key)` takes the key the consumer gave the request and
// composes the stored `${kind}:${key}` form itself, so a request looked up
// later needs an explicit key. `resumeHarness` (above) continues a pause and
// throws `HitlAnswerError` for an answer that does not bind to it;
// `expireHitl` closes what nobody answered in time. The minting helper, the
// resume's check/record steps and the owning chain's slot helpers are
// deliberately NOT exported here.

export {
  askHuman,
  held,
  hitlPending,
  resolveUnattended,
  HitlRequestError,
  HitlAnswerError,
  HELD_NOTE,
  readHitl,
  answerOf,
  expireHitl,
  // The gate patterns (S4): `confirm` is the one-call common case, `humanGate`
  // the custom one. They live beside `askHuman` because they are thin shapes
  // over it, and their `onAnswer` needs the stored-key composition.
  humanGate,
  confirm,
  type HitlState,
  type HitlAnswerErrorCode,
  type HumanGateConfig,
  type ConfirmConfig,
} from './hitl.server'

// ============================================================================
// Patterns
// ============================================================================

export {
  simpleLoop,
  actorCritic,
  withReferences,
  chain,
  runChain,
  compactExecution,
  compactIntent,
  planner,
  formatPlanContext,
  DEFAULT_MAX_PLAN_CHARS,
  retriever,
  configurePattern,
  parallel,
  judge,
  withInjectionGuard,
  createInjectionGuard,
  type InjectionGuardConfig,
  type SimpleLoopData,
  type ActorCriticData,
  type CompactIntentConfig,
  type CompactIntentData,
  type PlannerConfig,
  type PlannerData,
  type RetrieverBackend,
  type RetrieverConfig,
  type RetrieverData,
  type RetrievalHit,
  type RetrievalReference,
  type RetrieverResult,
  type JudgeConfig,
  type JudgeData,
  type EvaluatorFn,
} from './patterns'

// EventView
export { EventViewImpl, createEventView } from './patterns'

// Memory recall (#419): the chain step, its settings and the block formatter.
export {
  memoryRecall,
  formatMemoryContext,
  MEMORY_RECALL_KEY,
  MEMORY_RECALL_SPEC,
  type MemoryRecallConfig,
  type MemoryRecallData,
  type MemoryRecallSettings,
  type MemoryGateSettings,
  type MemoryRecallLabel,
  type RecalledMemory,
  withMemory,
  memoryStoreConfig,
  type MemoryConfig,
} from './patterns'

// Memory store (#419 M2): the post-reply step and its pure acceptance rules. A
// host calls `settleMemory` from inside its post-turn continuation, before it
// saves; the acceptance rules are exported so a host can reuse them (a
// compaction pass applies the same ones).
export {
  settleMemory,
  resolveStoreRoute,
  readStoreWindow,
  MEMORY_STORE_SET,
  MEMORY_STORE_KEY,
  MEMORY_STORE_FALLBACKS,
  MEMORY_MERGE_SPEC,
  MEMORY_MERGE_KEY,
  type MemoryStoreConfig,
  type MemoryStoreSettings,
  type MemoryStoreGateSettings,
  type MemoryStoreSkip,
  type MemorySettleReport,
  type MemoryStoreFields,
  type MemoryTarget,
  type MemoryConfirm,
  type MemorySensitivity,
  type MemoryMergeLabel,
  type RejectRule,
  type StoreRoute,
} from './memory-store.server'
export {
  acceptCandidate,
  identifiersIn,
  MEMORY_KINDS,
  MAX_MEMORY_CHARS,
  MIN_EVIDENCE_CHARS,
  type Acceptance,
  type AcceptanceRule,
} from './memory-acceptance.server'

// Decisions (#418): the user-facing half of the typedDecision seam. The pure
// scoring helpers (`scoreDecision`, `sumLabelMass`, …) stay on './patterns'.
export {
  typedDecision,
  decisionRouter,
  decide,
  decideFields,
  evaluateDecision,
  assertDecisionSetSpec,
  DECISION_ROUTER_KEY,
  type TypedDecisionConfig,
  type TypedDecisionData,
  type DecisionRouterConfig,
  type DecisionCall,
  type DecideFieldsCall,
  type DecideOptions,
  type EvaluatedDecision,
} from './patterns'

// ============================================================================
// Context Helpers
// ============================================================================

export {
  createContext,
  serializeContext,
  deserializeContext,
  createScope,
  createEvent,
  shouldTrack,
  trackEvent,
  commitEvents,
  enterPattern,
  exitPattern,
  setError,
  setDone,
  generateId,
  resolveConfig,
  getDefaultTrackHistory,
  getDefaultCommitStrategy,
  enrichToolResult,
} from './context.server'

// ============================================================================
// Infrastructure (Server-only)
// ============================================================================

export { callTool, listTools, closeMcpClient } from './mcp-client.server'

// Lane A6: `limitsFor` moved to `harness-baml` with the role→client map it
// reads — core pattern files no longer read the model tables, directly or via
// this barrel. Import it from `harness-baml`.
export { assertServer, ServerOnlyError } from './assert.server'
// Lane A6: `routeMessageOp` moved to `harness-baml` whole.
export { compactBulkData } from './compactBulkData.server'
export { getErrorHint } from './error-hints'
export {
  stripThinkBlocks,
  truncateToolResults,
  omitResultFields,
  findLastUserMessageIndex,
} from './content-transforms'

// Injection guard — the deterministic sanitizer + its ALS scope. The pattern
// primitive (`withInjectionGuard`) is exported with the other patterns above.
export {
  sanitizeUntrusted,
  sanitizeText,
  spotlight,
  applyScreenVerdict,
  redactReport,
  resolveRules,
  strictestSpotlight,
  INJECTION_RULES,
  type InjectionRule,
  type InjectionGuardOptions,
  type InjectionScreen,
  type SanitizeFinding,
  type SanitizeLayer,
  type SanitizeReport,
  type SanitizeResult,
  type SanitizeSummary,
  type ScreenVerdict,
  type SpotlightMode,
  type ActiveInjectionGuard,
} from './injection-guard'
export { normalizeControllerAction } from './controller-action'

// Lane A6: the BAML adapter factories and their helpers moved to
// `harness-baml` — core's barrel carries none of them. Import them from the
// app's harness-baml module (createLoopControllerAdapter,
// createInjectionScreen, withUsageAccounting, routeMessageOp, bamlPatterns, …).

// The object seams (Lane A4) and the Lane A6 seam callables — declared in
// core, implemented by the adapter factories in `harness-baml` (which attach
// legacy positional forms for the untouched acceptance tests).
export type {
  ControllerFn,
  ActorFn,
  ControllerInput,
  ActorInput,
  PlannerFn,
  PlanCallResult,
  CompactIntentFn,
  RetrieveQueryFn,
  HistoryQueryInput,
  DescribeFn,
  DescribeBatchFn,
  DescribeBatchItem,
  BulkDescribeFns,
  RouteFn,
  RouteExtra,
  RouteMessageResult,
} from './types'

// Runtime config: the library-owned settings defaults and their reader. The
// VALUE rides the run frame's `config` slot; import the client-safe pieces
// (type, bounds, defaults, resolveTurnBudget) from
// '@hames-ai/harness-patterns/runtime-config'.
export {
  DEFAULT_RUNTIME_CONFIG,
  RUNTIME_CONFIG_BOUNDS,
  resolveTurnBudget,
  runtimeConfig,
  type HarnessRuntimeConfig,
} from './runtime-config.server'
