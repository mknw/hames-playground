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

// Decisions (#418) — the policy layer: the pure scoring half (T1), the awaited
// wrapper (`evaluateDecision` / `decide` / `decideFields`) and the
// `typedDecision` / `decisionRouter` patterns (T2).
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
  scoreScoreDecision,
  scoreNoulDecision,
  type ScoreScoring,
  type NoulScoring,
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
  sumLabelMass,
  calibrateLabelMass,
  normalizeLabelMass,
  preCallAbstain,
  resolveDecisionCuts,
  scoreDecision,
  type TopLogprob,
  type ResolvedCut,
  type DecisionScoring,
  type ScoredDecision,
} from './typedDecision.server'

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
