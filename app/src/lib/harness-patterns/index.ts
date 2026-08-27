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

  // Controller/Critic Types (BAML function signatures)
  ControllerFn,
  CriticFn,

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

  // Approval Types
  ApprovalRequest,
  WithApproval,

  // Infrastructure types
  MCPToolDescription,
  ToolCallResult,
  ToolSet,
} from './types'

export { DEFAULT_TRACK_HISTORY, DEFAULT_COMMIT_STRATEGY, DEFAULT_ERROR_SEVERITY } from './types'

// ============================================================================
// Tools
// ============================================================================

export { Tools, ToolsFrom } from './tools.server'

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
export { assertServer, ServerOnlyError } from './assert.server'
export { routeMessageOp } from './routing.server'
export { compactBulkData } from './compactBulkData.server'
export { getErrorHint } from './error-hints'
export { stripThinkBlocks, truncateToolResults, omitResultFields } from './content-transforms'

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

// BAML Adapters
export {
  createLoopControllerAdapter,
  createActorControllerAdapter,
  createPlannerAdapter,
  createCriticAdapter,
  createNeo4jController,
  createWebSearchController,
  createMemoryController,
  createContext7Controller,
  createFilesystemController,
  createRedisController,
  createDatabaseController,
  createInjectionScreen,
  invalidateToolDescriptions,
  accountBamlCall,
  withUsageAccounting,
  type ActorAdapterOptions,
} from './baml-adapters.server'
