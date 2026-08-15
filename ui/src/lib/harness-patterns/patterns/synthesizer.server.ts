/**
 * Synthesizer Pattern
 *
 * Synthesizes a final response from previous pattern's output.
 * Three modes: 'message', 'response', 'thread'
 */

import { assertServerOnImport } from '../assert.server'
import type {
  SynthesizerConfig,
  SynthesizerData,
  SynthesizerInput,
  LoopHistory,
  PatternScope,
  EventView,
  ConfiguredPattern,
  AssistantMessageEventData,
  ToolResultEventData,
  LLMCallData,
} from '../types'
import { DIRECT_RESPONSE_ROUTE } from '../types'
import type { ErrorEventData } from '../types'
import { getErrorHint } from '../error-hints'
import { trackEvent, resolveConfig } from '../context.server'
import { Collector } from '@boundaryml/baml'
import { trimToFit, getContextWindow } from '../token-budget.server'
import { extractFailureLLMCallData, warnIfCollectorEmpty } from '../baml-adapters.server'
import { clientOverrideFor, resolveClientForRole } from '../clients.server'

assertServerOnImport()

/** Result from synthesis with optional LLM call data */
interface SynthesisResult {
  content: string
  llmCall?: LLMCallData
}

/**
 * Default synthesis function using BAML Synthesize.
 * Tracks LLM call data when collector is provided.
 */
async function defaultSynthesize(
  input: SynthesizerInput,
  collector?: Collector,
): Promise<SynthesisResult> {
  // Dynamic import to avoid circular dependencies
  const { b } = await import('../../../../baml_client')
  const startTime = Date.now()

  // Convert to LoopTurn format for BAML Synthesize
  const turns: import('../../../../baml_client/types').LoopTurn[] = []

  if (input.loopHistory) {
    // Convert loop history to LoopTurn array. Multi-call iterations carry
    // additional_calls through (their result is already the index-keyed map
    // holding every sub-call's tool + result/__error).
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

  // Trim oldest turns if they would overflow the synthesizer's context window
  // Trim against the window of the client this call will ACTUALLY use
  // (Anthropic 200K by default, the mixed-chain floor under USE_MIXED_CHAINS).
  // Hardcoding 'SynthesizerFallback' here trimmed against a 16K default and
  // dropped real tool results (see .harness-logs/neo4j-no-results.json).
  const contextWindow = getContextWindow(resolveClientForRole('synth'))
  const trimmedTurns = trimToFit(turns, (t) => JSON.stringify(t), 500, contextWindow)

  const variables = {
    userMessage: input.userMessage,
    intent: input.intent,
    turns: trimmedTurns,
    hasError: input.hasError ?? false,
    errorMessage: input.errorMessage,
  }

  // Call with or without collector, including error context.
  // Anthropic override applied when `USE_ANTHROPIC_ONLY=1` — routes through
  // `SynthesizerAnthropic` (Sonnet 4.6 → Haiku 4.5).
  const synthOpts = { ...(collector ? { collector } : {}), ...clientOverrideFor('synth') }
  const hasSynthOpts = Object.keys(synthOpts).length > 0
  const content = hasSynthOpts
    ? await b.Synthesize(
        input.userMessage,
        input.intent,
        trimmedTurns,
        input.hasError ?? false,
        input.errorMessage,
        synthOpts,
      )
    : await b.Synthesize(
        input.userMessage,
        input.intent,
        trimmedTurns,
        input.hasError ?? false,
        input.errorMessage,
      )

  // Extract LLM call data if collector present. This site builds its own
  // LLMCallData rather than going through extractLLMCallData, so it calls the
  // stale-client guard itself (#154).
  warnIfCollectorEmpty(collector, 'Synthesize')
  let llmCall: LLMCallData | undefined
  if (collector?.last) {
    const last = collector.last
    const calls = (last.calls ?? []) as Array<{
      selected?: boolean
      httpRequest?: { body?: unknown }
    }>
    const selectedCall = calls.find((c) => c.selected) ?? calls[calls.length - 1]
    let rawInput: string | undefined
    const body = selectedCall?.httpRequest?.body as
      { text?: () => string } | string | Record<string, unknown> | undefined
    if (typeof body === 'string') {
      rawInput = body
    } else if (body && typeof (body as { text?: () => string }).text === 'function') {
      try {
        rawInput = (body as { text: () => string }).text()
      } catch {
        /* body.text() may throw — leave undefined */
      }
    } else if (body && typeof body === 'object') {
      rawInput = JSON.stringify(body, null, 2)
    }

    // Extract prompt template from inlined BAML source
    let promptTemplate: string | undefined
    try {
      const { getBamlFiles } = await import('../../../../baml_client/inlinedbaml')
      const files = getBamlFiles() as Record<string, string>
      for (const source of Object.values(files)) {
        const match =
          /function\s+Synthesize\s*\([^)]*\)\s*->\s*\S+\s*\{[^}]*?prompt\s+#"([\s\S]*?)"#/.exec(
            source,
          )
        if (match) {
          promptTemplate = match[1]
          break
        }
      }
    } catch {
      /* inlined BAML not available */
    }

    // Extract provider and client info from the selected call
    const provider =
      selectedCall && 'provider' in selectedCall
        ? (selectedCall as { provider: string }).provider
        : undefined
    const clientName =
      selectedCall && 'clientName' in selectedCall
        ? (selectedCall as { clientName: string }).clientName
        : undefined

    llmCall = {
      functionName: 'Synthesize',
      variables,
      promptTemplate,
      rawInput,
      rawOutput: last.rawLlmResponse ?? undefined,
      parsedOutput: content,
      usage: last.usage
        ? {
            inputTokens: last.usage.inputTokens ?? 0,
            outputTokens: last.usage.outputTokens ?? 0,
            cachedInputTokens: last.usage.cachedInputTokens ?? 0,
            totalTokens: (last.usage.inputTokens ?? 0) + (last.usage.outputTokens ?? 0),
          }
        : undefined,
      durationMs: Date.now() - startTime,
      provider,
      clientName,
    }
  }

  return { content, llmCall }
}

/**
 * Build synthesis input from EventView based on mode.
 */
function buildSynthesisInputFromView(
  mode: SynthesizerConfig['mode'],
  view: EventView,
  data: SynthesizerData,
): SynthesizerInput {
  // Get user message
  const userMessage = view.fromAll().ofType('user_message').last(1).get()[0]
  const userContent = userMessage ? (userMessage.data as { content: string }).content : ''

  const input: SynthesizerInput = {
    mode,
    userMessage: userContent,
    intent: data.intent ?? userContent,
    // Read error state from view (scoped by synthesizer's ViewConfig)
    // rather than from data stash, so errors naturally expire with the view window
    hasError: view.hasErrors(),
    errorMessage: view.lastError(),
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
              // synthesizer answers from nothing).
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

        input.loopHistory = {
          iterations,
          startTime: toolEvents[0]?.ts ?? Date.now(),
          endTime: Date.now(),
        }
      }

      input.response = data.response
      break
    }
  }

  return input
}

/**
 * Create a synthesizer pattern.
 *
 * Takes output from previous pattern and synthesizes a final response.
 *
 * @param config - Synthesizer configuration
 * @returns ConfiguredPattern ready for chain
 *
 * @example
 * // Message mode - just the response string
 * const s1 = synthesizer({ mode: 'message' })
 *
 * // Response mode - object with data and response
 * const s2 = synthesizer({ mode: 'response' })
 *
 * // Thread mode - full iteration history
 * const s3 = synthesizer({ mode: 'thread' })
 *
 * // Custom synthesis function
 * const s4 = synthesizer({
 *   mode: 'response',
 *   synthesize: async (input) => `Processed: ${input.response}`
 * })
 */
export function synthesizer<T extends SynthesizerData>(
  config: SynthesizerConfig,
): ConfiguredPattern<T> {
  const { mode, synthesize, skipIfHasResponse = false } = config
  const resolved = resolveConfig('synthesizer', config)

  const fn = async (scope: PatternScope<T>, view: EventView): Promise<PatternScope<T>> => {
    // Collector + start time hoisted so the outer catch can recover LLM call
    // data (prompt template, variables, HTTP body) on a failed BAML call.
    let collector: Collector | undefined
    let startTime: number | undefined
    let synthesizeVariables: Record<string, unknown> | undefined
    try {
      // Skip if already has synthesized response
      if (skipIfHasResponse && scope.data.synthesizedResponse) {
        return scope
      }

      // Skip BAML synthesis for direct user responses (router already produced the response)
      if ((scope.data as Record<string, unknown>).route === DIRECT_RESPONSE_ROUTE) {
        return scope
      }

      // Build input from view
      const input = buildSynthesisInputFromView(mode, view, scope.data)

      // Validate thread mode
      if (mode === 'thread' && !input.loopHistory) {
        input.mode = 'response'
        input.data = scope.data
      }

      let synthesizedResponse: string
      let llmCall: LLMCallData | undefined

      if (synthesize) {
        // Custom synthesis function - no LLM tracking
        synthesizedResponse = await synthesize(input)
      } else {
        // Use default with collector for LLM observability
        collector = new Collector('synthesizer')
        startTime = Date.now()
        synthesizeVariables = {
          userMessage: input.userMessage,
          intent: input.intent,
          hasError: input.hasError ?? false,
          errorMessage: input.errorMessage,
        }
        const result = await defaultSynthesize(input, collector)
        synthesizedResponse = result.content
        llmCall = result.llmCall
      }

      // Track assistant message event with LLM call data. `final: true`
      // distinguishes the synthesizer's user-facing response from router
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
      // Best-effort: if the BAML Synthesize call threw, surface the prompt
      // template / variables / HTTP body alongside the error so the panel
      // can render the same drill-down as a successful call.
      const failedLlmCall =
        collector !== undefined && synthesizeVariables !== undefined && startTime !== undefined
          ? extractFailureLLMCallData(collector, 'Synthesize', synthesizeVariables, startTime)
          : undefined
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
    name: 'synthesizer',
    fn,
    config: resolved,
    estimateTurns: () => 1,
  }
}
