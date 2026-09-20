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
  ApprovalRequestEventData,
  ApprovalResponseEventData,
  ErrorEventData,
  IntentCompactedEventData,
  PlanCreatedEventData,
  ContentSanitizedEventData,

  // LLM Observability
  LLMCallData,
  LLMCallRecord,
  LLMResult,
  ModelLimits,
  CostBasis,

  // Approval Types
  ApprovalRequest,
  WithApproval,

  // Infrastructure types
  MCPToolDescription,
  ToolCallResult,
  ToolSet,
} from './types'

export { DEFAULT_TRACK_HISTORY, DEFAULT_COMMIT_STRATEGY, DEFAULT_ERROR_SEVERITY } from './types'

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
// between them is the containment invariant. `processTransports()` is
// deliberately NOT here: dispatch and the tool catalog are its only readers.
// See `tool-transport.server.ts`.

export {
  withTransport,
  registerTransport,
  activeTransports,
  type ToolTransport,
} from './tool-transport.server'

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
  isSyncWorkspaceConfig,
  harnessUsesSyncWorkspace,
} from './pattern-capabilities'

// ============================================================================
// Harness
// ============================================================================

export {
  harness,
  resumeHarness,
  continueSession,
  type HarnessData,
  type HarnessResultScoped,
} from './harness.server'

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
  guardrail,
  piiScanRail,
  pathAllowlistRail,
  driftDetectorRail,
  hook,
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
  type Rail,
  type RailResult,
  type RailContext,
  type GuardrailConfig,
  type CircuitBreakerConfig,
  type HookConfig,
  type HookTrigger,
} from './patterns'

// EventView
export { EventViewImpl, createEventView } from './patterns'

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
  setPaused,
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
} from './injection-guard'
export {
  getActiveInjectionGuard,
  runWithInjectionGuard,
  type ActiveInjectionGuard,
} from './injection-guard-scope.server'
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
  RouteMessageResult,
} from './types'

// Runtime config: the library-owned settings scope (defaults + ALS frame).
// Import the client-safe pieces (type, bounds, defaults, resolveTurnBudget)
// from '@hames/harness-patterns/runtime-config'; the scope lives in
// '@hames/harness-patterns/runtime-config.server'.
export {
  DEFAULT_RUNTIME_CONFIG,
  RUNTIME_CONFIG_BOUNDS,
  resolveTurnBudget,
  runtimeConfig,
  tryRuntimeConfig,
  withRuntimeConfig,
  type HarnessRuntimeConfig,
} from './runtime-config.server'
