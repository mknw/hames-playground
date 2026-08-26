/**
 * Parallel Pattern
 *
 * Execute multiple patterns concurrently via Promise.allSettled, merge events.
 */

import { assertServerOnImport } from '../assert.server'
import type { ConfiguredPattern, PatternConfig } from '../types'
import { trackEvent, resolveConfig, createEvent } from '../context.server'
import { emitLive } from '../live-event-context.server'

assertServerOnImport()

/**
 * Execute multiple patterns concurrently and merge their results.
 *
 * Each branch gets an isolated scope. Fulfilled results are merged;
 * rejected branches are logged as errors.
 *
 * @param patterns - Patterns to execute concurrently
 * @param config - Optional pattern configuration
 * @returns ConfiguredPattern ready for chain
 *
 * @example
 * const research = parallel(
 *   simpleLoop(b.LoopController, tools.web, { patternId: 'web-search' }),
 *   simpleLoop(b.LoopController, tools.neo4j, { patternId: 'graph-lookup' }),
 *   simpleLoop(b.LoopController, tools.context7, { patternId: 'doc-lookup' }),
 * )
 */
export function parallel<T extends Record<string, unknown>>(
  patterns: ConfiguredPattern<T>[],
  config?: PatternConfig,
): ConfiguredPattern<T> {
  const resolved = resolveConfig('parallel', config ?? { patternId: 'parallel' })

  return {
    name: 'parallel',
    fn: async (scope, view) => {
      try {
        // Each branch gets an isolated scope with empty events
        const results = await Promise.allSettled(
          patterns.map((p) =>
            p.fn(
              { ...scope, id: p.config.patternId ?? p.name, events: [], startTime: Date.now() },
              view,
            ),
          ),
        )

        // Did anything survive? `parallel: 'recoverable'` is right while at
        // least one branch did — "the surviving branches are exactly what the
        // rest of the chain is for" — and says nothing about zero survivors,
        // which leaves the chain with an empty execution and a synthesizer
        // willing to compose an answer out of it (F5 on #278). Stamped on the
        // EVENTS rather than moved to the pattern default, because only this
        // run knows which case it is.
        const noBranchSurvived = results.length > 0 && results.every((r) => r.status === 'rejected')

        // Merge fulfilled events; log rejected branches.
        // Branch boundary events also fire live so progress UIs see them.
        for (const [i, r] of results.entries()) {
          if (r.status === 'fulfilled') {
            const branchId = patterns[i].config.patternId ?? patterns[i].name
            const branchMaxTurns = (patterns[i].config as { maxTurns?: number }).maxTurns
            const enterEvt = createEvent('pattern_enter', branchId, {
              pattern: patterns[i].name,
              ...(branchMaxTurns !== undefined ? { maxTurns: branchMaxTurns } : {}),
            })
            scope.events.push(enterEvt)
            emitLive(enterEvt)
            scope.events.push(...r.value.events)
            const exitEvt = createEvent('pattern_exit', branchId, { status: 'completed' })
            scope.events.push(exitEvt)
            emitLive(exitEvt)
            scope.data = { ...scope.data, ...r.value.data }
          } else {
            trackEvent(
              scope,
              'error',
              {
                error: `Branch ${patterns[i].name} failed: ${r.reason}`,
                ...(noBranchSurvived ? { severity: 'irrecoverable' as const } : {}),
              },
              true,
            )
          }
        }

        return scope
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        // The outer catch is not a branch failing — it is the fan-out itself
        // failing, so no branch ran and nothing was merged. Nothing survived by
        // construction (F5 on #278).
        trackEvent(scope, 'error', { error: msg, severity: 'irrecoverable' }, true)
        return scope
      }
    },
    config: resolved,
    // Branches run concurrently; user-perceived duration tracks the longest one.
    estimateTurns: (s) => Math.max(...patterns.map((p) => p.estimateTurns?.(s) ?? 1)),
    children: patterns,
  }
}
