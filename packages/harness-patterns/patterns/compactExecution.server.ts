/**
 * compactExecution Pattern
 *
 * Synthesizes a final response from previous pattern's output.
 * Three modes: 'message', 'response', 'thread'
 */

import { assertServerOnImport } from '../assert.server'
import type {
  CompactExecutionConfig,
  CompactExecutionData,
  CompactExecutionInput,
  LoopHistory,
  PatternScope,
  EventView,
  ConfiguredPattern,
  AssistantMessageEventData,
  ToolResultEventData,
} from '../types'
import { LLMCallError } from '../types'
import { DIRECT_RESPONSE_ROUTE } from '../types'
import type { ErrorEventData } from '../types'
import { getErrorHint } from '../error-hints'
import { trackEvent, resolveConfig } from '../context.server'
import { defaultSynthesize } from '../../../app/src/lib/harness-baml/defaults.server'

assertServerOnImport()

/**
 * Build synthesis input from EventView based on mode.
 */
function buildSynthesisInputFromView(
  mode: CompactExecutionConfig['mode'],
  view: EventView,
  data: CompactExecutionData,
  errorTurnWindow: number,
): CompactExecutionInput {
  // Get user message
  const userMessage = view.fromAll().ofType('user_message').last(1).get()[0]
  const userContent = userMessage ? (userMessage.data as { content: string }).content : ''

  // Read error state from the view rather than from the data stash, so errors
  // expire with the window instead of being carried forward by hand — but read
  // it through a TURN window, not the bare view. A ViewConfig's pattern scope
  // is not a turn scope: a loop keeps the same patternId every turn and
  // `ctx.events` persist across `continueSession`, so one failed turn had
  // `Synthesize` apologise on turn 2, 3, 4… for work that all succeeded
  // (`general.server.ts` documents the correct shape — `fromPatterns` +
  // `fromLastNTurns: 1` — and was the only agent of the seven that had it).
  // The default is one turn; a caller that asked for a wider window in its own
  // `viewConfig` keeps it.
  const errorView = view.fromLastNTurns(errorTurnWindow)

  const input: CompactExecutionInput = {
    mode,
    userMessage: userContent,
    intent: data.intent ?? userContent,
    hasError: errorView.hasErrors(),
    errorMessage: errorView.lastError(),
  }

  switch (mode) {
    case 'message':
      // Just the response string from previous pattern
      input.response = data.response ?? ''
      break

    case 'response':
      // Include data and response
      input.response = data.response
      input.data = data
      break

    case 'thread': {
      // Get tool events from view for thread reconstruction
      const toolEvents = view.fromLastPattern().tools().get()
      const actionEvents = view.fromLastPattern().actions().get()

      // Build loop history from events if available
      if (toolEvents.length > 0 || actionEvents.length > 0) {
        const iterations: LoopHistory['iterations'] = []
        // Indices in `iterations` whose controller_action never received a
        // paired tool_result — dropped below, see the SA-H4 note.
        const unpaired = new Set<number>()
        let turn = 0
        // How many tool_results the open iteration still owns. A singular
        // action owns 1; a multi-call action owns 1 + additional_calls.length
        // (its sub-results arrive in batch order, so the accumulation below
        // keys them by position — the same index-keyed map the controller
        // itself saw). Counting also fixes the old `result === null` pairing
        // hazard where a tool legitimately returning null let the NEXT result
        // overwrite it.
        let openExpected = 0
        let openReceived = 0

        for (const event of view.fromLastPattern().get()) {
          if (event.type === 'controller_action') {
            const actionData = event.data as { action: import('../types').ControllerAction }
            unpaired.add(iterations.length)
            iterations.push({
              turn: turn++,
              action: actionData.action,
              result: null,
              timestamp: event.ts,
            })
            openExpected = 1 + (actionData.action.additional_calls?.length ?? 0)
            openReceived = 0
          } else if (event.type === 'tool_result') {
            const resultData = event.data as ToolResultEventData
            const open = iterations.length > 0 ? iterations[iterations.length - 1] : undefined
            if (open && openReceived < openExpected) {
              // Pair with the controller_action that owns this result.
              unpaired.delete(iterations.length - 1)
              openReceived++
              if (openExpected === 1) {
                open.result = resultData.result
              } else {
                const acc = (open.result ?? {}) as Record<string, unknown>
                acc[String(openReceived)] = resultData.success
                  ? { tool: resultData.tool, result: resultData.result }
                  : { tool: resultData.tool, __error: resultData.error }
                open.result = acc
              }
            } else {
              // A tool_result with no preceding action — e.g. the `retriever`
              // pattern, which does one search and emits a result without an LLM
              // tool-call loop. Synthesize a minimal iteration so the result
              // still reaches Synthesize (otherwise thread mode drops it and the
              // compactExecution answers from nothing).
              iterations.push({
                turn: turn++,
                action: {
                  reasoning: '',
                  tool_name: resultData.tool ?? 'tool',
                  tool_args: '',
                  status: resultData.success ? 'success' : 'error',
                  is_final: true,
                },
                result: resultData.result,
                timestamp: event.ts,
              })
            }
          }
        }

        // Drop the turns that would reach `Synthesize` as a FABRICATED
        // success: the conversion in `defaultSynthesize` stamps
        // `success: true` on every turn it emits, so
        //   - the terminal `Return` turn — simpleLoop deliberately emits no
        //     `tool_result` for it (baml_src/simpleLoop.baml, #149) — and
        //   - any action whose `tool_result` never arrived (the loop broke, the
        //     pattern aborted mid-turn)
        // both rendered as `Result: null` under a `success` flag — the
        // Return case being the common one, and the answer-writer's LAST and
        // most salient input: "a successful tool that returned nothing".
        // Under the template's FIDELITY rule that buys a hedged answer over
        // tool results that were in fact complete.
        // A tool that legitimately returns null keeps its turn — it HAS a
        // paired `tool_result`, which is what `unpaired` tracks.
        const real = iterations.filter(
          (it, i) => !unpaired.has(i) && it.action.tool_name !== 'Return',
        )

        // Nothing left to reconstruct: fall through to the existing
        // no-loopHistory path below, which downgrades thread → response mode.
        if (real.length > 0) {
          input.loopHistory = {
            iterations: real,
            startTime: toolEvents[0]?.ts ?? Date.now(),
            endTime: Date.now(),
          }
        }
      }

      input.response = data.response
      break
    }
  }

  return input
}

/**
 * Create a compactExecution pattern.
 *
 * Takes output from previous pattern and synthesizes a final response.
 *
 * @param config - compactExecution configuration
 * @returns ConfiguredPattern ready for chain
 *
 * @example
 * // Message mode - just the response string
 * const s1 = compactExecution({ mode: 'message' })
 *
 * // Response mode - object with data and response
 * const s2 = compactExecution({ mode: 'response' })
 *
 * // Thread mode - full iteration history
 * const s3 = compactExecution({ mode: 'thread' })
 *
 * // Custom synthesis function
 * const s4 = compactExecution({
 *   mode: 'response',
 *   synthesize: async (input) => `Processed: ${input.response}`
 * })
 */
export function compactExecution<T extends CompactExecutionData>(
  config: CompactExecutionConfig,
): ConfiguredPattern<T> {
  const { mode, synthesize, skipIfHasResponse = false } = config
  const resolved = resolveConfig('compactExecution', config)

  const fn = async (scope: PatternScope<T>, view: EventView): Promise<PatternScope<T>> => {
    try {
      // Skip if already has synthesized response
      if (skipIfHasResponse && scope.data.synthesizedResponse) {
        return scope
      }

      // Skip BAML synthesis for direct user responses (router already produced the response)
      if ((scope.data as Record<string, unknown>).route === DIRECT_RESPONSE_ROUTE) {
        return scope
      }

      // Build input from view. The error read is bounded to the caller's own
      // turn window when it declared one, else to the current turn (SA-H1).
      const input = buildSynthesisInputFromView(
        mode,
        view,
        scope.data,
        resolved.viewConfig?.fromLastNTurns ?? 1,
      )

      // Validate thread mode
      if (mode === 'thread' && !input.loopHistory) {
        input.mode = 'response'
        input.data = scope.data
      }

      // Both paths return the LLMResult envelope now: a custom `synthesize`
      // override can carry a call record like the default does (the override
      // used to return a bare string and emit NO llmCall at all — the
      // no-tracking hole this closes), and the default creates its own
      // collector internally instead of being handed one.
      const { value: synthesizedResponse, call: llmCall } = await (synthesize ?? defaultSynthesize)(
        input,
      )

      // Track assistant message event with LLM call data. `final: true`
      // distinguishes the compactExecution's user-facing response from router
      // status messages that share the same event type — chat-history
      // replay reads this flag to skip intermediate emits.
      trackEvent(
        scope,
        'assistant_message',
        { content: synthesizedResponse, final: true } as AssistantMessageEventData,
        resolved.trackHistory,
        llmCall,
      )

      scope.data = {
        ...scope.data,
        response: synthesizedResponse,
        synthesizedResponse,
      }

      return scope
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      // Throw contract (Lane A3): the implementation wraps a failure after
      // reaching the model in `LLMCallError` carrying the record, so the error
      // event keeps the same prompt/variables/HTTP drill-down a successful
      // call attaches. A custom `synthesize` that throws its own error still
      // degrades to a bare message — honestly: there is no record to show.
      const failedLlmCall = error instanceof LLMCallError ? error.llmCall : undefined
      trackEvent(
        scope,
        'error',
        {
          error: msg,
          severity: resolved.errorSeverity,
          hint: getErrorHint(msg),
          ...(failedLlmCall ? { kind: 'llm_call' as const } : {}),
        } as ErrorEventData,
        true,
        failedLlmCall,
      )
      return scope
    }
  }

  return {
    name: 'compactExecution',
    fn,
    config: resolved,
    estimateTurns: () => 1,
  }
}
