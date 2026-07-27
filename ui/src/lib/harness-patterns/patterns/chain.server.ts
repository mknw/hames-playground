/**
 * Chain Pattern
 *
 * Composes multiple patterns into a single sequence.
 */

import { assertServerOnImport } from '../assert.server'
import type {
  UnifiedContext,
  ContextEvent,
  ConfiguredPattern,
  PatternConfig
} from '../types'
import {
  createScope,
  commitEvents,
  enterPattern,
  exitPattern,
  resolveConfig,
  setError,
  createEvent
} from '../context.server'
import { setLivePatternEnabled, wasEmittedLive } from '../live-event-context.server'
import { createEventView } from './event-view.server'

assertServerOnImport()

/**
 * Execute configured patterns in sequence with proper scope lifecycle.
 *
 * For each pattern:
 * 1. Creates isolated PatternScope
 * 2. Creates EventView based on pattern's viewConfig
 * 3. Adds pattern_enter event
 * 4. Executes pattern function
 * 5. Commits events based on commitStrategy
 * 6. Adds pattern_exit event
 * 7. Passes data forward
 *
 * @param ctx - UnifiedContext to execute in
 * @param patterns - ConfiguredPatterns to execute in sequence
 * @returns Updated UnifiedContext
 *
 * @example
 * const agent = harness(neo4jLoop, webLoop, synth)
 * // harness uses runChain internally
 */
export async function runChain<T extends Record<string, unknown>>(
  ctx: UnifiedContext<T>,
  patterns: ConfiguredPattern<T>[],
  onEvent?: (event: ContextEvent) => void
): Promise<UnifiedContext<T>> {
  if (patterns.length === 0) {
    return ctx
  }

  try {
    let currentData = ctx.data

    for (let i = 0; i < patterns.length; i++) {
      const pattern = patterns[i]

      // Stop if status changed from running
      if (ctx.status !== 'running') {
        break
      }

      const patternId = pattern.config.patternId!
      const liveEnabled = pattern.config.liveEvents === true

      // Toggle live emission for this pattern's lifecycle (incl. enter/exit).
      // Inner patterns invoked by wrappers inherit this flag automatically.
      setLivePatternEnabled(liveEnabled)

      // 1. Create isolated scope for this pattern
      const scope = createScope<T>(patternId, currentData)

      // 2. Create view based on pattern's viewConfig (exclude self from fromLastPattern)
      const view = createEventView(ctx, pattern.config.viewConfig, patternId)

      // 3. Add pattern_enter event (fires live if enabled).
      //    Surface known config fields (maxTurns) for UI progress tracking.
      const cfg = pattern.config as PatternConfig & { maxTurns?: number }
      enterPattern(
        ctx,
        patternId,
        pattern.name,
        cfg.maxTurns !== undefined ? { maxTurns: cfg.maxTurns } : undefined
      )

      try {
        // 4. Execute pattern
        const result = await pattern.fn(scope, view)

        // 5. Commit events based on strategy
        const beforeLen = ctx.events.length
        commitEvents(ctx, result, pattern.config.commitStrategy!)

        // 5b. Emit newly committed events via callback, skipping any that
        //     were already delivered live (dedup by event id).
        if (onEvent) {
          for (let j = beforeLen; j < ctx.events.length; j++) {
            const ev = ctx.events[j]
            if (!wasEmittedLive(ev)) onEvent(ev)
          }
        }

        // 6. Pass data forward
        currentData = result.data
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        setError(ctx, msg, patternId)
      }

      // 7. Add pattern_exit event (fires live if enabled)
      exitPattern(ctx, patternId)

      // Reset the toggle so subsequent patterns without `liveEvents` aren't
      // accidentally streamed.
      setLivePatternEnabled(false)
    }

    // Update final data
    ctx.data = currentData

    return ctx
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    setError(ctx, msg, 'chain')
    return ctx
  }
}

/**
 * Compose patterns into a single ConfiguredPattern that runs them in sequence.
 *
 * Unlike `runChain` (which takes a UnifiedContext), `chain` is a pattern factory
 * that returns a ConfiguredPattern. This enables composition inside harness() or
 * within other pattern factories like parallel() and guardrail().
 *
 * @param patterns - ConfiguredPatterns to execute in sequence
 * @returns A single ConfiguredPattern wrapping all sub-patterns
 *
 * @example
 * // Compose router + routes + synth as a single unit inside parallel/guardrail
 * const routedAgent = chain(
 *   router({ neo4j: 'DB queries', web: 'Web lookups' }),
 *   routes({ neo4j: neo4jPattern, web: webPattern }),
 *   synthesizer({ mode: 'thread' })
 * )
 *
 * // Use in harness alongside other patterns
 * const agent = harness(guardrail(routedAgent, piiScanRail))
 */
export function chain<T extends Record<string, unknown>>(
  ...patterns: ConfiguredPattern<T>[]
): ConfiguredPattern<T> {
  const resolved = resolveConfig('chain', {})
  return {
    name: `chain(${patterns.map(p => p.name).join(', ')})`,
    fn: async (scope, view) => {
      // Run each sub-pattern in a fresh child scope so its events get tagged
      // with its OWN patternId (e.g. 'code-mode-loop'), not the outer
      // composition's auto-generated id. Without this, `view.fromLastPattern()`
      // and `ViewConfig.fromLast: true` silently exclude the sub-pattern's
      // events because they filter on `e.patternId === lastPatternId`.
      //
      // We also build a fresh EventView per sub-pattern with the correct
      // `selfPatternId` and a synthetic context that includes events
      // accumulated by previous sub-patterns in this same chain. Without
      // this, a later sub-pattern's `fromLastPattern()` either sees stale
      // ancestry (no view of its sibling's emit) or — worse — selects its
      // OWN patternId as "last" (because the outer view was constructed
      // for the wrapping pattern, not for the synth). Mirrors `runChain`
      // above (chain.server.ts:60-122) and the single-child wrappers
      // (`guardrail`/`hook`/`with-references`).
      const outerCtx = (view as unknown as { ctx: UnifiedContext }).ctx
      let currentData = scope.data
      for (const pattern of patterns) {
        const subId = pattern.config.patternId ?? pattern.name
        scope.events.push(
          createEvent('pattern_enter', subId, { pattern: pattern.name })
        )
        // Synthetic ctx: original events + everything this chain has
        // accumulated so far (including the pattern_enter just pushed).
        // Read-only view — events array is freshly composed each iteration.
        const syntheticCtx: UnifiedContext = {
          ...outerCtx,
          events: [...outerCtx.events, ...scope.events] as ContextEvent[],
        }
        const subView = createEventView(syntheticCtx, pattern.config.viewConfig, subId)
        const childScope = createScope<T>(subId, currentData)
        const result = await pattern.fn(childScope, subView)
        scope.events.push(...result.events)
        scope.events.push(
          createEvent('pattern_exit', subId, { status: 'completed' })
        )
        currentData = result.data
      }
      scope.data = currentData
      return scope
    },
    config: resolved,
    estimateTurns: (s) =>
      patterns.reduce((sum, p) => sum + (p.estimateTurns?.(s) ?? 1), 0),
    children: patterns
  }
}

/**
 * Create a ConfiguredPattern from a ScopedPattern function.
 *
 * @param name - Pattern name for tracing
 * @param fn - Scoped pattern function
 * @param config - Pattern configuration
 * @returns ConfiguredPattern ready for chain
 */
export function configurePattern<T extends Record<string, unknown>>(
  name: string,
  fn: ConfiguredPattern<T>['fn'],
  config?: PatternConfig
): ConfiguredPattern<T> {
  const resolved = resolveConfig(name, config)
  return {
    name,
    fn,
    config: resolved
  }
}
