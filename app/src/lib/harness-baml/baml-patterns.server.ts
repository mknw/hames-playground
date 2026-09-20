/**
 * bamlPatterns — the one factory for the injected LLM functions (#225 Lane A6)
 *
 * Core (`harness-patterns`) hosts no BAML implementation any more: the six
 * functions that used to be wired inside pattern files are REQUIRED config on
 * their patterns, and this module is where the app gets them — one call, one
 * line per agent:
 *
 *   const baml = bamlPatterns()
 *   planner(baml.planner(tools.all), tools.all, { … })
 *   compactIntent(baml.compactIntent, { … })
 *   retriever({ rewrite: baml.retrieveQuery, backends, … })
 *   compactBulkData(ctx, onPersist, baml)          // reads describe/batch
 *   router(routes, { route: baml.router })          // REQUIRED seam
 *   compactExecution({ mode, synthesize: baml.synthesize })
 *   withReferences(pattern, { selector: baml.selector, … })
 *
 * The BAML-companion seam lane removed the last core→app default imports, so
 * EVERY injected implementation — including the router's `routeMessageOp`,
 * `defaultSynthesize` and `defaultSelector` — is wired from here at the
 * composition root. Core declares only the types.
 *
 * Every adapter here owns its collector (Lane A3 envelope), returns
 * `LLMResult`, throws `LLMCallError` on a failure after reaching the model,
 * and resolves its client per call through `clientOverrideFor` — a tier
 * decision is an ALS scope, so nothing is captured at construction.
 */

import { Collector } from '@boundaryml/baml'
import { assertServerOnImport } from '@hames/harness-patterns/assert.server'
import type {
  CompactIntentFn,
  DescribeBatchFn,
  HistoryQueryInput,
  LLMResult,
  PlannerFn,
  RetrieveQueryFn,
  SelectorFn,
  SynthesisFn,
} from '@hames/harness-patterns/types'
import { defaultSelector, defaultSynthesize } from './defaults.server'
import {
  createPlannerAdapter,
  describeToolResultOp,
  describeToolResultsBatchOp,
  extractLLMCallData,
  wrapAsLLMCallError,
} from './baml-adapters.server'
import { clientOverrideFor, limitsFor } from './clients.server'
import { routeMessageOp } from './routing.server'

assertServerOnImport()

// ============================================================================
// compactIntent — the adapter implementation the pattern used to inline
// ============================================================================

/** `CompactIntentFn` backed by the BAML `CompactIntent` call (describe-tier
 *  client). The history arrives ALREADY trimmed by the pattern, which sizes
 *  it against this fn's own `limits()` — so the event data the pattern emits
 *  keeps reporting the length it actually sent. */
export function createCompactIntentAdapter(): CompactIntentFn {
  const fn = async ({ history, latest }: HistoryQueryInput): Promise<LLMResult<string>> => {
    const { b } = await import('../../../baml_client')
    const startTime = Date.now()
    const collector = new Collector('compactIntent')
    const variables = { history, latest }

    // Routes to `DescribeAnthropic` (Haiku 4.5), or to the self-hosted box
    // on a verda-tier run — the intent is compacted FROM the conversation's
    // own history, so it moves with the rest of the describe role.
    const opts = { collector, ...clientOverrideFor('describe') }
    let raw: string
    try {
      raw = await b.CompactIntent(history, latest, opts)
    } catch (e) {
      // Throw contract: the raw response travels with the throw so the
      // pattern's recoverable error event keeps its drill-down.
      throw wrapAsLLMCallError(e, 'CompactIntent', variables, startTime, collector)
    }
    const intent = raw.trim() || latest
    return {
      value: intent,
      call: extractLLMCallData(collector, 'CompactIntent', variables, startTime, intent),
    }
  }
  fn.limits = () => limitsFor('describe')
  return fn
}

// ============================================================================
// RetrieveQuery — the adapter implementation the retriever used to inline
// ============================================================================

/** `RetrieveQueryFn` backed by the BAML `RetrieveQuery` call (describe-tier).
 *  Best-effort by contract upstream: the RETRIEVER catches and falls back to
 *  the raw message — here a failure after reaching the model still throws
 *  `LLMCallError` so the fallback path can carry the record. */
export function createRetrieveQueryAdapter(): RetrieveQueryFn {
  const fn = async ({ history, latest }: HistoryQueryInput): Promise<LLMResult<string>> => {
    const { b } = await import('../../../baml_client')
    const startTime = Date.now()
    const collector = new Collector('retriever')
    const variables = { history, latest }
    // describe-tier, and it moves with a verda tier decision: the rewrite is
    // built from the user's own question and the conversation history.
    const opts = { collector, ...clientOverrideFor('describe') }
    let raw: string
    try {
      raw = await b.RetrieveQuery(history, latest, opts)
    } catch (e) {
      throw wrapAsLLMCallError(e, 'RetrieveQuery', variables, startTime, collector)
    }
    const text = raw.trim() || latest
    return {
      value: text,
      call: extractLLMCallData(collector, 'RetrieveQuery', variables, startTime, text),
    }
  }
  fn.limits = () => limitsFor('describe')
  return fn
}

// ============================================================================
// The factory
// ============================================================================

/** The injected implementations, in one object. Sync: every adapter binds no
 *  turn state, and `limits()` resolves per call. */
export interface BamlPatterns {
  /** `(toolNames) => PlannerFn` — the planner's seam needs the tool catalog
   *  the executor will have; pass the SAME list you hand `planner()`. */
  planner: (toolNames: string[]) => PlannerFn
  /** The routing implementation. REQUIRED config on `router()` — pass it as
   *  `router(routes, { route: baml.router })`; core hosts no default. */
  router: typeof routeMessageOp
  compactIntent: CompactIntentFn
  retrieveQuery: RetrieveQueryFn
  describe: typeof describeToolResultOp
  describeBatch: DescribeBatchFn
  /** The BAML-backed synthesis implementation for `compactExecution`
   *  (REQUIRED `synthesize` config). */
  synthesize: SynthesisFn
  /** The BAML-backed selector for `withReferences` (REQUIRED `selector`
   *  config; tests and evals may substitute a deterministic policy). */
  selector: SelectorFn
}

export function bamlPatterns(): BamlPatterns {
  return {
    planner: createPlannerAdapter,
    router: routeMessageOp,
    compactIntent: createCompactIntentAdapter(),
    retrieveQuery: createRetrieveQueryAdapter(),
    describe: describeToolResultOp,
    describeBatch: describeToolResultsBatchOp,
    synthesize: defaultSynthesize,
    selector: defaultSelector,
  }
}
