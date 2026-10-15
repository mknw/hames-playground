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
  AGENT_MAP_HEADING,
  DEFAULT_MAX_PLAN_CHARS,
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
  DECISION_LOOP_OUTPUT_KEY,
  DECISION_LOOP_RESULT_CHARS,
  WITHHELD_SCREEN_UNAVAILABLE,
  type DecisionLoopConfig,
  type DecisionLoopData,
  type DecisionLoopRoute,
  type DecisionLoopStateInput,
} from './decisionLoop.server'
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
