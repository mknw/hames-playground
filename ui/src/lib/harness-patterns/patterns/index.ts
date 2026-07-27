/**
 * Pattern Exports
 */

// Patterns
export { router, routes, type Routes, type RoutePatterns, type RouterData } from './router.server'
export { simpleLoop, type SimpleLoopData } from './simpleLoop.server'
export { actorCritic, type ActorCriticData } from './actorCritic.server'
export { chain, runChain, configurePattern } from './chain.server'
export { synthesizer } from './synthesizer.server'
export { compactIntent, type CompactIntentConfig, type CompactIntentData } from './compactIntent.server'
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
export { guardrail, piiScanRail, pathAllowlistRail, driftDetectorRail, type Rail, type RailResult, type RailContext, type GuardrailConfig, type CircuitBreakerConfig } from './guardrail.server'
export { hook, type HookConfig, type HookTrigger } from './hook.server'
export { withReferences, __clearReferenceCache } from './with-references.server'

// EventView
export { EventViewImpl, createEventView } from './event-view.server'

// Re-export config types from main types
export type {
  RouterConfig,
  RoutesConfig,
  SimpleLoopConfig,
  ActorCriticConfig,
  SynthesizerConfig,
  SynthesizerMode,
  SynthesizerInput,
  SynthesisFn,
  SynthesizerData,
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
  IntentCompactedEventData
} from '../types'
