/**
 * Judge Pattern
 *
 * Score/rank results from multiple sources, select the best.
 * Uses a BAML evaluator function to assess quality.
 */

import { assertServerOnImport } from '../assert.server'
import type {
  ConfiguredPattern,
  PatternConfig
} from '../types'
import { trackEvent, resolveConfig } from '../context.server'

assertServerOnImport()

export interface JudgeConfig extends PatternConfig {
  /** Maximum candidates to evaluate */
  maxCandidates?: number
}

export interface JudgeData {
  response?: string
  judgeReasoning?: string
  rankings?: unknown[]
  [key: string]: unknown
}

/**
 * Evaluator function type.
 * Takes a query and array of candidates, returns ranked evaluation.
 */
export type EvaluatorFn = (
  query: string,
  candidates: Array<{ source: string; content: string }>
) => Promise<{
  reasoning: string
  rankings: Array<{ source: string; score: number; reason: string }>
  best: { source: string; content: string } | null
}>

/**
 * Create a judge pattern that evaluates and ranks results from previous patterns.
 *
 * Collects all tool_result events from previous patterns,
 * passes them to an evaluator function, and selects the best result.
 *
 * @param evaluator - Function that scores and ranks candidates
 * @param config - Optional pattern configuration
 * @returns ConfiguredPattern ready for chain
 *
 * @example
 * const evaluator = judge(myJudgeFunction, { patternId: 'quality-judge' })
 */
export function judge<T extends JudgeData>(
  evaluator: EvaluatorFn,
  config?: JudgeConfig
): ConfiguredPattern<T> {
  const resolved = resolveConfig('judge', config)

  return {
    name: config?.patternId ?? 'judge',
    fn: async (scope, view) => {
      try {
        // Collect all tool_result events from previous patterns
        const candidates = view.fromAll().ofType('tool_result').get()

        if (candidates.length === 0) {
          trackEvent(scope, 'error', {
            error: 'No candidates to evaluate'
          }, true)
          return scope
        }

        // Limit candidates if configured
        const maxCandidates = config?.maxCandidates ?? candidates.length
        const limitedCandidates = candidates.slice(0, maxCandidates)

        // Format candidates for evaluator
        const formattedCandidates = limitedCandidates.map((c) => ({
          source: c.patternId,
          content: JSON.stringify(c.data)
        }))

        // Call evaluator
        const input = (scope.data as Record<string, unknown>).input as string ?? ''
        const evaluation = await evaluator(input, formattedCandidates)

        trackEvent(scope, 'controller_action', {
          reasoning: evaluation.reasoning,
          rankings: evaluation.rankings,
          selected: evaluation.best
        }, resolved.trackHistory)

        // Forward best result as the response for synthesizer
        scope.data = {
          ...scope.data,
          response: evaluation.best?.content,
          judgeReasoning: evaluation.reasoning,
          rankings: evaluation.rankings
        }

        return scope
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        trackEvent(scope, 'error', { error: msg }, true)
        return scope
      }
    },
    config: resolved,
    estimateTurns: () => 1
  }
}
