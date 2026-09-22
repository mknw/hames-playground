/**
 * harness-baml — the BAML companion module (#225 Lane A6)
 *
 * Everything that touches `baml_client` / `@boundaryml/baml` lives HERE, not
 * in `harness-patterns/` — the lane's exit criterion is zero such references
 * under core, pinned by `core-types-source-scan.test.ts`. Direction:
 * companion → core (this module imports core types and helpers); core
 * patterns reference only their defaults here, and app code (agents, turn
 * plumbing) imports the implementations from this barrel.
 */

export {
  bamlPatterns,
  createCompactIntentAdapter,
  createRetrieveQueryAdapter,
  type BamlPatterns,
} from './baml-patterns.server'
export { defaultSynthesize, defaultSelector } from './defaults.server'
export {
  createLoopControllerAdapter,
  createActorControllerAdapter,
  createCriticAdapter,
  createInjectionScreen,
  accountBamlCall,
  withUsageAccounting,
  llmCallHitOutputCap,
  invalidateToolDescriptions,
  extractLLMCallData,
  extractFailureLLMCallData,
  wrapAsLLMCallError,
  computeEventMetrics,
  type ActorAdapterOptions,
  type CriticCallResult,
  type CriticFnWithLLMData,
  type LegacyControllerFn,
  type LegacyActorFn,
  type PlannerFnWithLLMData,
  type DescribeBatchItem,
} from './baml-adapters.server'
export { routeMessageOp } from './routing.server'
export {
  VERDA_CLIENT_BY_ROLE,
  SWITCHED_FUNCTIONS_BY_ROLE,
  TIER_SWITCHED_FUNCTIONS,
  assertInferenceTier,
  activeInferenceTier,
  clientOverrideFor,
  configureConsumerClients,
  activeConsumerClients,
  resolveClientForRole,
  limitsFor,
  getContextWindow,
  type BamlRole,
} from './clients.server'
export {
  defineInferenceClients,
  activateConsumerClients,
  type InferenceRole,
  type ClientOverride,
  type BamlClientOverride,
  type ConsumerClient,
  type InferenceClientsConfig,
} from './consumer-clients.server'
