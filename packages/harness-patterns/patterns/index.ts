/**
 * Pattern Exports
 */

// Patterns
export { router, routes, type Routes, type RoutePatterns, type RouterData } from './router.server'
export { simpleLoop, type SimpleLoopData } from './simpleLoop.server'
export { actorCritic, type ActorCriticData } from './actorCritic.server'
export { chain, runChain, configurePattern } from './chain.server'
export { compactExecution } from './compactExecution.server'
export {
  compactIntent,
  type CompactIntentConfig,
  type CompactIntentData,
} from './compactIntent.server'
export {
  planner,
  formatPlanContext,
  HANDOFF_HEADING,
  CONVERSATION_HEADING,
  AGENT_MAP_HEADING,
  DEFAULT_MAX_PLAN_CHARS,
  DEFAULT_MAX_REASONING_CHARS,
  type PlannerConfig,
  type PlannerData,
} from './planner.server'
export {
  retriever,
  type RetrieverBackend,
  type RetrieverConfig,
  type RetrieverData,
  type RetrievalHit,
  type RetrievalReference,
  type RetrieverResult,
} from './retriever.server'
export { parallel } from './parallel.server'
export { judge, type JudgeConfig, type JudgeData, type EvaluatorFn } from './judge.server'
export {
  withInjectionGuard,
  createInjectionGuard,
  type InjectionGuardConfig,
} from './withInjectionGuard.server'
export { withReferences, __clearReferenceCache } from './with-references.server'

// Memory recall (#419 M1) — the recall chain step; ranking helpers live in
// '../memory-ranking.server'.
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
} from './memoryRecall.server'
// withMemory (#419 M5a) — the opt-in combinator and the store half of its config.
export {
  withMemory,
  memoryStoreConfig,
  type MemoryConfig,
  type RouterMemory,
} from './withMemory.server'

// EventView
export { EventViewImpl, createEventView } from './event-view.server'

export {
  withPseudonymisedInputs,
  RosterUnavailable,
  type PseudonymiseForWeb,
  type RosterUnavailableReason,
  type WebPrivacyUnavailableReason,
  type WebPseudonymisation,
} from './withPseudonymisedInputs.server'

export {
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
} from './withEgressGate.server'

// Typed systemone decisions and recording.
export {
  evaluateDecision,
  decide,
  decideFields,
  assertDecisionSetSpec,
  defineChoice,
  defineScore,
  defineNoul,
  defineDecisionSet,
  readDecision,
  typedDecision,
  decisionRouter,
  DECISION_ROUTER_KEY,
  type DecisionCall,
  type EvaluatedDecision,
  type DecideOptions,
  type DecideFieldsCall,
  type TypedDecisionConfig,
  type TypedDecisionData,
  type DecisionRouterConfig,
} from './typedDecision.server'

// decisionLoop (#507) — a loop over routes, the next one chosen by a decision.
export {
  decisionLoop,
  DECISION_LOOP_MAX_ITERATIONS,
  DECISION_LOOP_KEY,
  DECISION_LOOP_ANSWER,
  DECISION_LOOP_RESULT_CHARS,
  DECISION_DOCUMENTS_TIMEOUT_MS,
  type DecisionLoopConfig,
  type DecisionLoopData,
  type DecisionLoopRoute,
  type DecisionLoopStateInput,
} from './decisionLoop.server'
export {
  renderDocumentsBlock,
  safeDocumentName,
  documentTypeLabel,
  DECISION_DOCUMENTS_HEADING,
  DECISION_DOCUMENTS_MAX_NAMES,
  DECISION_DOCUMENT_NAME_CODE_POINTS,
  DECISION_DOCUMENTS_MAX_CHARS,
  WITHHELD_DOCUMENT_NAME,
  type DecisionDocument,
  type DecisionDocuments,
  type DecisionDocumentsSource,
  type ResolvedDecisionDocuments,
} from './decisionLoop-documents.server'
export {
  collectToolNames,
  type RouteOutput,
  type RouteStats,
  type RouteKind,
} from './decisionLoop-records.server'

// Re-export config types from main types
export type {
  RouterConfig,
  RoutesConfig,
  SimpleLoopConfig,
  ActorCriticConfig,
  CompactExecutionConfig,
  CompactExecutionMode,
  CompactExecutionInput,
  SynthesisFn,
  CompactExecutionData,
  LoopHistory,
  LoopIteration,
  PatternConfig,
  ViewConfig,
  CommitStrategy,
  TrackHistory,
  ConfiguredPattern,
  ScopedPattern,
  PatternScope,
  EventView,
  UnifiedContext,
  ContextEvent,
  EventType,
  WithReferencesConfig,
  SelectorFn,
  ReferenceCandidate,
  ReferenceAttachedEventData,
  IntentCompactedEventData,
  PlanCreatedEventData,
} from '../types'
