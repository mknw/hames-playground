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
  CodeModeControllerFn,

  // BAML Types (re-exported)
  ControllerAction,
  CriticResult,
  ScriptExecutionEvent,
  FewShot,

  // Router Config Types
  RouterConfig,
  RoutesConfig,

  // Pattern Config Types
  SimpleLoopConfig,
  ActorCriticConfig,
  SynthesizerConfig,
  SynthesizerMode,
  SynthesizerInput,
  SynthesisFn,
  SynthesizerData,

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

  // LLM Observability
  LLMCallData,

  // Approval Types
  ApprovalRequest,
  WithApproval,

  // Infrastructure types
  MCPToolDescription,
  ToolCallResult,
  ToolSet
} from './types'

export {
  MAX_TOOL_TURNS,
  MAX_RETRIES,
  DEFAULT_TRACK_HISTORY,
  DEFAULT_COMMIT_STRATEGY,
  DEFAULT_ERROR_SEVERITY
} from './types'

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
  usesCodeMode,
  isCodeModeLoopConfig,
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
  type HarnessResultScoped
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
  synthesizer,
  compactIntent,
  retriever,
  configurePattern,
  parallel,
  judge,
  guardrail,
  piiScanRail,
  pathAllowlistRail,
  driftDetectorRail,
  hook,
  type SimpleLoopData,
  type ActorCriticData,
  type CompactIntentConfig,
  type CompactIntentData,
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
  type HookTrigger
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
  enrichToolResult
} from './context.server'

// ============================================================================
// Infrastructure (Server-only)
// ============================================================================

export { callTool, listTools, getMcpClient, closeMcpClient } from './mcp-client.server'
export { assertServer, ServerOnlyError } from './assert.server'
export { routeMessageOp } from './routing.server'
export { scheduleSummarization } from './summarize.server'
export { getErrorHint } from './error-hints'
export { stripThinkBlocks, truncateToolResults } from './content-transforms'

// BAML Adapters
export {
  createLoopControllerAdapter,
  createActorControllerAdapter,
  createCriticAdapter,
  createNeo4jController,
  createWebSearchController,
  createMemoryController,
  createContext7Controller,
  createGitHubController,
  createFilesystemController,
  createRedisController,
  createDatabaseController,
  createCodeModeController,
  invalidateToolDescriptions,
  type ActorAdapterOptions
} from './baml-adapters.server'
