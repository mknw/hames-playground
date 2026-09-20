/**
 * defaults — the composition-root implementations of the two injected seams
 * (#225 Lane A6)
 *
 * `defaultSynthesize` (compactExecution's REQUIRED `synthesize`) and
 * `defaultSelector` (withReferences' REQUIRED `selector`) are REQUIRED config
 * — the patterns carry NO default import, because a `baml_client` import
 * under `packages/harness-patterns/` is what the lane's exit criterion
 * forbids. Their implementations live here, in the harness-baml companion at
 * the composition root, and `bamlPatterns()` supplies them (`synthesize` /
 * `selector` fields — the caller passes `baml.synthesize` / `baml.selector`
 * in the pattern's config).
 *
 * Both own their collectors (Lane A3), account through the shared extractors,
 * and resolve their client per call. Nothing else about their contracts
 * changed: "the four pre-existing injected functions and their overrides
 * carry over unchanged in kind."
 */

import { Collector } from '@boundaryml/baml'
import { assertServerOnImport } from '@hames/harness-patterns/assert.server'
import type {
  CompactExecutionInput,
  LLMResult,
  LoopTurn,
  SelectorFn,
} from '@hames/harness-patterns/types'
import { trimToFit } from '@hames/harness-patterns/token-budget.server'
import { getContextWindow, resolveClientForRole } from './clients.server'
import {
  accountBamlCall,
  extractLLMCallData,
  warnIfCollectorEmpty,
  wrapAsLLMCallError,
} from './baml-adapters.server'
import { clientOverrideFor } from './clients.server'

assertServerOnImport()

// ============================================================================
// defaultSynthesize — the composition-root implementation of compactExecution's
// REQUIRED `synthesize` config (supplied by bamlPatterns().synthesize)
// ============================================================================

export async function defaultSynthesize(input: CompactExecutionInput): Promise<LLMResult<string>> {
  // Dynamic import to avoid circular dependencies
  const { b } = await import('../../../baml_client')
  const startTime = Date.now()
  // Lane A3: the implementation owns the collector — it used to be created by
  // the pattern and handed down, which is the handle the envelope deletes.
  const collector = new Collector('compactExecution')

  // Convert to LoopTurn format for BAML Synthesize
  const turns: LoopTurn[] = []

  if (input.loopHistory) {
    // Convert loop history to LoopTurn array. Multi-call iterations carry
    // additional_calls through (their result is already the index-keyed map
    // holding every sub-call's tool + result/__error).
    //
    // `success: true` below is unconditional, which is only honest because
    // `buildSynthesisInputFromView` has already dropped the iterations that
    // have no result to report (the terminal `Return`, and actions whose
    // `tool_result` never arrived) — see the SA-H4 note there.
    for (const iteration of input.loopHistory.iterations) {
      turns.push({
        n: iteration.turn,
        reasoning: iteration.action.reasoning,
        tool_call: {
          tool: iteration.action.tool_name,
          args: iteration.action.tool_args,
        },
        ...(iteration.action.additional_calls?.length
          ? { additional_calls: iteration.action.additional_calls }
          : {}),
        tool_result: {
          tool: iteration.action.tool_name,
          result: JSON.stringify(iteration.result),
          success: true,
        },
      })
    }
  } else if (input.response) {
    // Create a single turn with the response as a result
    turns.push({
      n: 0,
      reasoning: 'Direct response',
      tool_result: {
        tool: 'response',
        result: input.response,
        success: true,
      },
    })
  }

  // Trim oldest turns if they would overflow the compactExecution's context window
  // Trim against the window of the client this call will ACTUALLY use.
  // Hardcoding a chain name here ('SynthesizerFallback') missed the map, fell
  // through to a 16K default, and dropped real tool results before the LLM saw
  // them (see .harness-logs/neo4j-no-results.json).
  const contextWindow = getContextWindow(resolveClientForRole('compactExecution'))
  const trimmedTurns = trimToFit(turns, (t) => JSON.stringify(t), 500, contextWindow)

  const variables = {
    userMessage: input.userMessage,
    intent: input.intent,
    turns: trimmedTurns,
    hasError: input.hasError ?? false,
    errorMessage: input.errorMessage,
  }

  // Call with options always: the implementation-owned collector is in the
  // bag even when no tier override is, so the old with/without-opts dual call
  // is gone. `Synthesize` declares `SynthesizerAnthropic` (Sonnet 5 → Haiku
  // 4.5), overridden onto the self-hosted deployment when
  // `USE_VERDA_INFERENCE=1` re-points the `compactExecution` role.
  const synthOpts = { collector, ...clientOverrideFor('compactExecution') }
  let content: string
  try {
    content = await b.Synthesize(
      input.userMessage,
      input.intent,
      trimmedTurns,
      input.hasError ?? false,
      input.errorMessage,
      synthOpts,
    )
  } catch (e) {
    // Throw contract: the raw response travels with the throw so the
    // pattern's error event keeps its drill-down.
    throw wrapAsLLMCallError(e, 'Synthesize', variables, startTime, collector)
  }

  // Route through the SHARED extractor rather than rebuilding LLMCallData here.
  // This site used to hand-roll it, and the copy had drifted: no cache-write
  // token bucket, no step `metrics`, and — the one that mattered — no call to
  // the usage chokepoint. `Synthesize` is a compactExecution-role call, i.e.
  // one of the three roles the self-hosted tier moves, and it is the LAST call
  // of a turn. Successes went uncounted while its failure path (below) counted,
  // so the preview header's on-prem share read high and its warm clock started
  // ticking from the controller's last call instead of this one. One extractor,
  // one accounting stamp, one stale-client guard (#154).
  const llmCall = extractLLMCallData(collector, 'Synthesize', variables, startTime, content)

  return { value: content, call: llmCall }
}

// ============================================================================
// defaultSelector — the composition-root implementation of withReferences'
// REQUIRED `selector` config (supplied by bamlPatterns().selector)
// ============================================================================

export const defaultSelector: SelectorFn = async (input) => {
  const { b } = await import('../../../baml_client')
  const now = Date.now()
  const collector = new Collector('reference-selector')
  const candidates = input.candidates.map((c) => ({
    ref_id: c.ref_id,
    tool: c.tool,
    summary: c.summary,
    tool_args: c.tool_args ?? null,
    ts_offset_s: Math.max(0, Math.floor((now - c.ts) / 1000)),
  }))
  let result: Awaited<ReturnType<typeof b.ReferenceSelector>>
  try {
    result = await b.ReferenceSelector(
      input.intent,
      input.recentMessages.map((m) => ({ role: m.role, content: m.content })),
      candidates,
      // describe-tier, so a verda tier decision moves it: the candidates it
      // ranks are summaries of this conversation's own tool results.
      { collector, ...clientOverrideFor('describe') },
    )
  } catch (e) {
    // Non-fatal upstream (the wrapper falls back to attaching nothing), but the
    // error event it emits is the ONLY record of the failure — wrap so the raw
    // response travels with it instead of dying inside this collector.
    throw wrapAsLLMCallError(
      e,
      'ReferenceSelector',
      { intent: input.intent, candidates },
      now,
      collector,
    )
  }
  // Nothing here reads the collector, but an empty one still means the options
  // object never reached BAML — i.e. the client override was dropped too (#154).
  warnIfCollectorEmpty(collector, 'ReferenceSelector')
  // The failure path accounts via `wrapAsLLMCallError` → `extractFailureLLMCallData`;
  // without this the SUCCESSES of a describe-tier role would be the half that
  // went uncounted, which biases the header's on-prem share upward.
  accountBamlCall(collector, 'ReferenceSelector')
  return {
    selected: result.selected.map((s) => ({ ref_id: s.ref_id, reason: s.reason })),
    reasoning: result.reasoning,
  }
}
