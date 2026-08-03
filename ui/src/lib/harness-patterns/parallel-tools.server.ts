/**
 * Multi-call turn executor — shared by simpleLoop and actorCritic.
 *
 * A controller may emit `additional_calls` (ControllerAction) so one turn
 * carries N tool calls. This module owns HOW those calls run:
 *
 *   'parallel'          — all sub-calls dispatched concurrently, at most
 *                         MAX_PARALLEL_TOOL_CALLS in flight; a failed call
 *                         reports per-call, the others still run.
 *   'sequential' / 'off' — strict in-order execution; the first failure stops
 *                         the batch and the remaining calls are marked skipped
 *                         (effect-chains: running call N+1 after call N failed
 *                         cascades errors). 'off' differs from 'sequential'
 *                         only in the prompt (no affordance advertised) — an
 *                         un-advertised batch is tolerated, not punished.
 *
 * Validation (allowlists, arg parsing) stays with the calling pattern: each
 * sub-call arrives here as a thunk, or as a pre-resolved failure that never
 * runs. The combined turn result is an index-keyed map (1-based, matching the
 * order the model wrote the calls) — the same shape expandPreviousResult uses
 * for multi-ref expansion, with `__error` / `__skipped` markers for non-success.
 */

import { assertServerOnImport } from './assert.server'
import { MAX_PARALLEL_TOOL_CALLS } from './types'
import type { MultiCallMode } from './types'

assertServerOnImport()

/** One sub-call as the pattern hands it to the executor. `run` is absent when
 *  validation already failed (`precheckError` carries why) — the executor then
 *  records the failure without dispatching anything. */
export interface SubCall {
  tool: string
  run?: () => Promise<{ success: boolean; result?: unknown; error?: string }>
  precheckError?: string
}

/** Outcome of one sub-call, in batch order (index is 1-based). */
export interface SubCallOutcome {
  index: number
  tool: string
  success: boolean
  result?: unknown
  error?: string
  /** true when a serial batch stopped before reaching this call */
  skipped?: boolean
}

/** Execute a batch of sub-calls under the given mode. Outcomes come back in
 *  batch order regardless of completion order. */
export async function runBatch(
  calls: SubCall[],
  mode: MultiCallMode
): Promise<SubCallOutcome[]> {
  const outcomes: SubCallOutcome[] = new Array(calls.length)

  const runOne = async (call: SubCall, i: number): Promise<SubCallOutcome> => {
    if (!call.run || call.precheckError) {
      return { index: i + 1, tool: call.tool, success: false, error: call.precheckError ?? 'not executable' }
    }
    try {
      const r = await call.run()
      return { index: i + 1, tool: call.tool, success: r.success, result: r.result, error: r.error }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return { index: i + 1, tool: call.tool, success: false, error: msg }
    }
  }

  if (mode === 'parallel') {
    // Concurrency-limited dispatch: a shared cursor over the call list, one
    // worker per slot. Order of `outcomes` is positional, not completion.
    let cursor = 0
    const workers = Array.from(
      { length: Math.min(MAX_PARALLEL_TOOL_CALLS, calls.length) },
      async () => {
        while (cursor < calls.length) {
          const i = cursor++
          outcomes[i] = await runOne(calls[i], i)
        }
      }
    )
    await Promise.all(workers)
    return outcomes
  }

  // Serial modes: in-order, stop on first failure, mark the rest skipped.
  let failedAt: number | null = null
  for (let i = 0; i < calls.length; i++) {
    if (failedAt !== null) {
      outcomes[i] = {
        index: i + 1,
        tool: calls[i].tool,
        success: false,
        skipped: true,
        error: `skipped: call ${failedAt} (${calls[failedAt - 1].tool}) failed earlier in this batch`,
      }
      continue
    }
    outcomes[i] = await runOne(calls[i], i)
    if (!outcomes[i].success) failedAt = i + 1
  }
  return outcomes
}

/** Fold outcomes into the index-keyed combined result the controller sees in
 *  its turn log (and actorCritic records as the attempt output). Success
 *  entries carry `{tool, result}`; failures `{tool, __error}`; skipped calls
 *  `{tool, __skipped}` — mirroring expandPreviousResult's multi-ref map. */
export function combineOutcomes(
  outcomes: SubCallOutcome[],
  projectResult: (o: SubCallOutcome) => unknown = (o) => o.result
): { combined: Record<string, unknown>; anySucceeded: boolean; errors: string[] } {
  const combined: Record<string, unknown> = {}
  const errors: string[] = []
  let anySucceeded = false
  for (const o of outcomes) {
    if (o.success) {
      anySucceeded = true
      combined[String(o.index)] = { tool: o.tool, result: projectResult(o) }
    } else if (o.skipped) {
      combined[String(o.index)] = { tool: o.tool, __skipped: o.error }
    } else {
      combined[String(o.index)] = { tool: o.tool, __error: o.error }
      errors.push(`[${o.index}] ${o.tool}: ${o.error}`)
    }
  }
  return { combined, anySucceeded, errors }
}
