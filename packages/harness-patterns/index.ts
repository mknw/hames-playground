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
  ContinuationSegment,
  ResumableCapability,
  HitlFlag,
  HitlOption,
  HitlUnattended,
  HitlRequestEventData,
  HitlDecidedBy,
  HitlResponseEventData,
  HitlRequest,
  HitlOutcome,
  HeldResult,
  HitlPayloadStore,
  HoldingOutcome,
  HitlAnswer,
  HitlAnswers,

  // Decisions (#418)
  DecisionLabel,
  DecisionSpec,
  DecisionType,
  ScoreSpec,
  NoulSpec,
  AnyDecisionSpec,
  ChoiceDecision,
  ScoreDecision,
  NoulDecision,
  AnyDecision,
  DecisionFor,
  DecisionSetSpec,
  MixedDecisionSet,
  DecisionLabelsFor,
  DecisionMethod,
  AbstainReason,
  Decision,
  DecideInput,
  DecideResult,
  DecideFn,
  DecideAllFn,
  DecisionMadeEventData,
  ByTier,

  // Memory recall (#419)
  MemoryKind,
  MemoryCandidate,
  MemoryStore,
  MemoryExtractedCandidate,
  MemoryExtractInput,
  MemoryExtractFn,
  MemoryEmbedder,
  MemoryRetention,
  MemoryCompactionRow,
  MemoryCompactInput,
  MemoryCompactFn,
  MemoryCompactionStore,
  MemoryCompactionTx,
  MemoryNeighbor,
  MemoryInsertRow,
  MemorySourceRow,
  MemoryWriteTx,
  MemoryWriteStore,
  MemoryWriteAction,
  MemoryWrittenEventData,
  ModelCallEventData,
  ModelCallRole,
  EgressAuditEventData,
  EgressRefusedEventData,
  EgressProbabilities,
  CallRecordSink,
  MemoryConfirmSeam,
  MemoryProposalItem,
  MemoryProposalPayload,
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
export { MAX_SCORE_LEVELS } from './types'

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
  resolveByTier,
  type RunFrame,
  type ActiveRunFrame,
  type EgressCheck,
  type InferenceSlot,
  type LiveEventSlot,
  type LiveEventListener,
  type RunClientOverride,
  type StashWrite,
  type StashWriteObserver,
  type AfterToolCallHook,
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
  harnessUsesMemory,
  harnessPseudonymisesInputs,
  ownResumable,
  followContinuation,
  refuseUnresumableGates,
} from './pattern-capabilities'

// Resume inside a route (slice 6): how a host's own wrapper joins the path.
export {
  resumableFingerprint,
  wrapperResumable,
  resumableStep,
  takeResume,
  childResume,
  onPath,
  type TakenResume,
} from './resume.server'

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
  askHumanHolding,
  canPauseHere,
  recordedHolding,
  canonicalJson,
  HOLDING_EXPIRES_IN_MS,
  held,
  hitlPending,
  resolveUnattended,
  HitlRequestError,
  HitlAnswerError,
  HELD_NOTE,
  readHitl,
  readProposals,
  proposeToHuman,
  answerProposal,
  answerOf,
  expireHitl,
  // The gate patterns (S4): `confirm` is the one-call common case, `humanGate`
  // the custom one. They live beside `askHuman` because they are thin shapes
  // over it, and their `onAnswer` needs the stored-key composition.
  humanGate,
  confirm,
  type HitlState,
  type AnsweredProposal,
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
  withPseudonymisedInputs,
  RosterUnavailable,
  type PseudonymiseForWeb,
  type RosterUnavailableReason,
  type WebPrivacyUnavailableReason,
  type WebPseudonymisation,
  withEgressGate,
  egressClosures,
  EGRESS_RELEASE_KIND,
  EGRESS_RELEASE_OPTIONS,
  EGRESS_HELD_NOTE,
  type EgressClosures,
  type EgressDirectoryStatus,
  type EgressGateConfig,
  type EgressMode,
  type EgressRoster,
  type EgressRosterSource,
  chain,
  runChain,
  compactExecution,
  compactIntent,
  planner,
  formatPlanContext,
  HANDOFF_HEADING,
  CONVERSATION_HEADING,
  AGENT_MAP_HEADING,
  DEFAULT_MAX_PLAN_CHARS,
  DEFAULT_MAX_REASONING_CHARS,
  decisionLoop,
  DECISION_LOOP_MAX_ITERATIONS,
  DECISION_LOOP_KEY,
  DECISION_LOOP_ANSWER,
  DECISION_LOOP_RESULT_CHARS,
  DECISION_DOCUMENTS_TIMEOUT_MS,
  ROUTE_SCOPE_HEADING,
  renderDocumentsBlock,
  renderMemoriesBlock,
  collectToolNames,
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
  type DecisionLoopConfig,
  type DecisionLoopData,
  type DecisionLoopRoute,
  type DecisionLoopStateInput,
  type DecisionDocument,
  type DecisionDocuments,
  type DecisionDocumentsSource,
  type ResolvedDecisionDocuments,
  type DecisionMemories,
  type RouteOutput,
  type RouteStats,
  type RouteKind,
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
  type RouterMemory,
} from './patterns'

// Memory store (#419 M2): the post-reply step and its pure acceptance rules. A
// host calls `settleMemory` from inside its post-turn continuation, before it
// saves; the acceptance rules are exported so a host can reuse them (a
// compaction pass applies the same ones).
export {
  settleMemory,
  applyMemoryProposal,
  memoryConfirmRequest,
  parseMemoryProposalPayload,
  MEMORY_CONFIRM_KIND,
  MEMORY_CONFIRM_SAVE,
  MEMORY_CONFIRM_DISCARD,
  DEFAULT_PROPOSAL_TTL_MS,
  resolveStoreRoute,
  readStoreWindow,
  MEMORY_STORE_SET,
  MEMORY_STORE_KEY,
  MEMORY_STORE_FALLBACKS,
  MEMORY_MERGE_SPEC,
  MEMORY_MERGE_KEY,
  type MemoryApplyConfig,
  type MemoryApplyOutcome,
  type MemoryApplyReport,
  type MemoryStoreConfig,
  type MemoryStoreSettings,
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
export {
  DEFAULT_MEMORY_RETENTION,
  memoryRetention,
  expiredMemories,
  clusterMemories,
  acceptCompaction,
} from './memory-compaction-pure.server'
export {
  compactMemory,
  MEMORY_COMPACT_SPEC,
  sweepMemories,
  startMemorySweep,
  type MemoryCompactionConfig,
  type MemoryCompactionSettings,
  type MemoryCompactionReport,
  type MemorySweepJob,
} from './memory-compaction.server'
export { memoryCompactionConfig } from './patterns/withMemory.server'

// Decisions (#418): the user-facing typed systemone decision seam.
export {
  defineChoice,
  defineScore,
  defineNoul,
  defineDecisionSet,
  readDecision,
  typedDecision,
  decisionRouter,
  decide,
  decideFields,
  evaluateDecision,
  assertDecisionSetSpec,
  DECISION_ROUTER_KEY,
  WITHHELD_ERROR_DETAIL,
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
  createModelCallEvent,
  redactCall,
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

export { callTool, listTools, closeMcpClient, EGRESS_CHECK_FAILED } from './mcp-client.server'

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
  FENCE,
  LEGACY_FENCE,
  fenceItemId,
  applyScreenVerdict,
  redactReport,
  resolveRules,
  neutralizeFenceMarkers,
  INJECTION_RULES,
  SCREEN_WITHHELD,
  INGRESS_FLAG_KIND,
  INGRESS_FLAG_OPTIONS,
  INGRESS_TEXTS,
  ingressFlagResolution,
  type IngressFlagPayload,
  type InjectionRule,
  type InjectionGuardOptions,
  type InjectionScreen,
  type InjectionScreenConfig,
  type ScreenMode,
  type GuardGate,
  type GuardGateVerdict,
  type IngressClass,
  type IngressClassifier,
  type SanitizeFinding,
  type SanitizeLayer,
  type SanitizeReport,
  type SanitizeResult,
  type SanitizeSummary,
  type ScreenVerdict,
  type SpotlightMode,
  type ActiveInjectionGuard,
} from './injection-guard'
// The guard gate (boundary guards slice 3): the cheap Decide question in front of
// the screen, passed as `screen.gate`.
export {
  createGuardGate,
  GUARD_SCREEN,
  GUARD_GATE_THRESHOLD,
  GUARD_GATE_TIMEOUT_MS,
  GUARD_GATE_MAX_CHARS,
  GUARD_GATE_MAX_STATE_BYTES,
  guardGateSkipRate,
  type GuardGateSettings,
} from './guard-gate.server'
// The egress gate's question, its fixed texts and its deterministic reads
// (boundary guards slice 4); the wrapper is `withEgressGate` above.
export {
  GUARD_EGRESS,
  EGRESS_TEXTS,
  EGRESS_WARNINGS,
  EGRESS_WARNING_TASK,
  GUARD_EGRESS_THRESHOLD,
  GUARD_EGRESS_MAX_RETRIES_POST_TRIPWIRE,
  GUARD_EGRESS_TIMEOUT_MS,
  EGRESS_MAX_BLOCK_CHARS,
  EGRESS_SMALL_BLOCK_CHARS,
  EGRESS_USER_CAP,
  EGRESS_SPAN_CAP,
  readOutgoing,
  destinationHosts,
  renderEgressState,
  type OutgoingRequest,
  type ReadOutgoing,
  type EgressStateInput,
} from './egress-gate.server'
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
