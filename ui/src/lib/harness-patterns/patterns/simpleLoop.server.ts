/**
 * Simple Loop Pattern
 *
 * ReAct-style decide-execute loop.
 * Calls BAML controller function directly, extracting params from context.
 */

import { Collector } from '@boundaryml/baml'
import { assertServerOnImport } from '../assert.server'
import { callTool } from '../mcp-client.server'
import { repairJson } from '../json-repair'
import type { LoopTurn, PriorResult, ExpandedRef } from '../../../../baml_client/types'
import type {
  ControllerAction,
  SimpleLoopConfig,
  PatternScope,
  EventView,
  ConfiguredPattern,
  ToolCallEventData,
  ToolResultEventData,
  ControllerActionEventData
} from '../types'
import { MAX_TOOL_TURNS, EXPAND_TOOL_NAME } from '../types'
import type { ErrorEventData } from '../types'
import { getErrorHint } from '../error-hints'
import { trackEvent, resolveConfig, generateId } from '../context.server'
import { getRequestSettings } from '../../settings-context.server'
import { getActiveSandbox } from '../../sandbox/scope.server'
import { trimToFit, getContextWindow } from '../token-budget.server'
import { resolveClientForRole } from '../clients.server'
import type { ControllerFnWithLLMData } from '../baml-adapters.server'
import { dedupByRefId, annotateExpansions, LLMCallError, llmCallHitOutputCap } from '../baml-adapters.server'
import type { LLMCallData } from '../types'

assertServerOnImport()

// ============================================================================
// Reference Resolution
// ============================================================================

/**
 * Resolve `ref:<eventId>` values in tool args by expanding them to the full
 * tool result data from the UnifiedContext, **and** capture each successful
 * substitution so the controller can see (in the next turn's prompt) what
 * was inlined this turn.
 */
/**
 * Parse the `tool_args` of an `expandPreviousResult` call into a list of
 * ref_ids. Accepts the canonical compact form and a JSON-object form
 * for resilience against LLMs that ignore the prompt's args contract.
 *
 *   "ref:abc"                    → ["abc"]
 *   "ref:abc,def,ghi"            → ["abc", "def", "ghi"]
 *   '{"ref_id": "abc"}'          → ["abc"]
 *   '{"ref_ids": ["abc","def"]}' → ["abc", "def"]
 *
 * Whitespace around individual ids is trimmed; empty entries are dropped.
 * Returns [] when no parseable id is present (caller treats as failure).
 */
function parseExpandRefs(argsStr: string): string[] {
  const trimmed = argsStr.trim()
  if (trimmed.startsWith('ref:')) {
    return trimmed
      .slice(4)
      .split(',')
      .map(s => s.trim())
      .filter(Boolean)
  }
  try {
    const parsed = repairJson(trimmed)
    if (Array.isArray(parsed.ref_ids)) {
      return parsed.ref_ids
        .filter((x: unknown): x is string => typeof x === 'string')
        .map((s: string) => (s.startsWith('ref:') ? s.slice(4) : s).trim())
        .filter(Boolean)
    }
    const single = parsed.ref_id ?? parsed.ref ?? parsed.id
    if (typeof single === 'string') {
      const s = single.trim()
      const id = s.startsWith('ref:') ? s.slice(4) : s
      return id ? [id] : []
    }
  } catch { /* fall through to [] */ }
  return []
}

function resolveRefsAndCapture(
  args: Record<string, unknown>,
  view: EventView,
  maxResultChars: number
): { resolved: Record<string, unknown>; expansions: ExpandedRef[] } {
  const resolved = { ...args }
  const expansions: ExpandedRef[] = []
  const allEvents = view.fromAll().get()
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value === 'string' && value.startsWith('ref:')) {
      const eventId = value.slice(4)
      const event = allEvents.find(e => e.id === eventId)
      if (event && event.type === 'tool_result') {
        const d = event.data as ToolResultEventData
        // Skip hidden/archived results — refs to excluded data stay unresolved
        if (!d.hidden && !d.archived) {
          resolved[key] = d.result
          const raw = typeof d.result === 'string' ? d.result : JSON.stringify(d.result)
          expansions.push({
            ref_id: eventId,
            content: raw.length > maxResultChars
              ? raw.slice(0, maxResultChars) + '…[truncated]'
              : raw
          })
        }
      }
    }
  }
  return { resolved, expansions }
}

export interface SimpleLoopData {
  turn?: number
  intent?: string
  lastAction?: ControllerAction
  response?: string
}

/**
 * Create a simple loop pattern.
 *
 * Calls the BAML controller function directly, extracting params from context.
 *
 * @param controller - BAML controller function (e.g., b.Neo4jController)
 * @param tools - Allowed tool names
 * @param config - Optional configuration (schema, maxTurns, patternId, etc.)
 * @returns ConfiguredPattern ready for chain
 *
 * @example
 * const loop = simpleLoop(b.Neo4jController, tools.neo4j, {
 *   patternId: 'neo4j-query',
 *   schema,
 *   trackHistory: 'tool_result',
 *   commitStrategy: 'on-success'
 * })
 */
export function simpleLoop<T extends SimpleLoopData>(
  controller: ControllerFnWithLLMData,
  tools: string[],
  config?: SimpleLoopConfig
): ConfiguredPattern<T> {
  const resolved = resolveConfig('simpleLoop', config)

  const fn = async (
    scope: PatternScope<T>,
    view: EventView
  ): Promise<PatternScope<T>> => {
    const settings = getRequestSettings()
    const maxTurns = config?.maxTurns ?? settings.maxToolTurns
    const data = scope.data
    const turns: LoopTurn[] = []
    let hasError = false
    let errorMessage: string | undefined
    let errorTurn: number | undefined
    let errorLlmCall: LLMCallData | undefined
    let exitedViaReturn = false

    // Build structured references to tool results from previous tasks.
    // These are passed as turns_previous_runs (separate from the current task's turns)
    // so the LLM can clearly distinguish prior context from current work.
    // Summaries (populated async after prior responses) are used when available.
    let turnWindowRefs: PriorResult[] = []
    if (config?.rememberPriorTurns !== false) {
      const turnCount = config?.priorTurnCount ?? settings.priorTurnCount
      const priorEvents = view.fromLastNTurns(turnCount).ofType('tool_result').get()
        .filter(e => {
          const d = e.data as ToolResultEventData
          return !!e.id && !d.hidden && !d.archived
            && (d.success || config?.includeFailedResults)
        })
      turnWindowRefs = priorEvents.map(e => {
        const d = e.data as ToolResultEventData
        const rawResult = typeof d.result === 'string' ? d.result : JSON.stringify(d.result)
        const preview = d.summary ?? rawResult.slice(0, 200).replace(/\n/g, ' ')
        return {
          ref_id: e.id!,
          tool: d.tool,
          summary: preview + (!d.summary && rawResult.length > 200 ? '...' : '')
        }
      })
    }

    // Merge `withReferences` attachments (LLM-selected, scope-filtered) with the
    // turn-window refs. Attached takes precedence on dedup so the selector's
    // explicit choice wins over the implicit window.
    const attachedRefs = (scope.data as { attachedRefs?: PriorResult[] }).attachedRefs ?? []
    const mergedRefs = dedupByRefId([...attachedRefs, ...turnWindowRefs])
    const basePriorResults: PriorResult[] | undefined = mergedRefs.length > 0 ? mergedRefs : undefined

    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        // Trim oldest turns if they would overflow the controller's context window
        // (the client this call will actually use, not the hardcoded Fallback).
        const contextWindow = getContextWindow(resolveClientForRole('controller'))
        // ~500 chars base prompt overhead (template, schema, intent, etc.)
        const trimmedTurns = trimToFit(turns, t => JSON.stringify(t), 500, contextWindow)
        const previousResults = JSON.stringify(trimmedTurns)

        // Extract intent from data or use input from view
        // Use ofType('user_message') to get the actual user query, not the router's assistant_message
        const userMessage = view.ofType('user_message').last(1).get()[0]
        const userContent = userMessage
          ? (userMessage.data as { content: string }).content
          : ''
        const intent = data.intent ?? userContent

        // Annotate refs with `expanded_in_turn` from accumulated turns so the
        // controller can see which prior data has already been inlined.
        const priorResults = basePriorResults
          ? annotateExpansions(basePriorResults, turns)
          : undefined

        // Call BAML controller — catch validation errors gracefully
        // so partial results from earlier turns are preserved
        let action: ControllerAction
        // Hoisted so the tool_args-parse branch below can check for output-cap
        // truncation on the call that produced this turn's action.
        let controllerLlmCall: LLMCallData | undefined
        const collector = new Collector('simpleLoop')
        try {
          const controllerResult = await controller(
            userContent,
            intent,
            previousResults,
            turn,
            config?.schema,
            collector,
            priorResults,
            config?.fewShots
          )
          action = controllerResult.action
          controllerLlmCall = controllerResult.llmCall

          // Track controller action event with LLM call data.
          // `turn` and `maxTurns` are surfaced so live consumers can size
          // their progress indicators without reading the pattern config
          // (which doesn't capture settings.maxToolTurns).
          trackEvent(
            scope,
            'controller_action',
            { action, turn, maxTurns } as ControllerActionEventData,
            resolved.trackHistory,
            controllerResult.llmCall
          )
        } catch (controllerError) {
          const msg = controllerError instanceof Error ? controllerError.message : String(controllerError)
          // Exit loop gracefully with partial results instead of losing everything
          hasError = true
          errorMessage = msg
          errorTurn = turn
          // Carry LLM call data from the failed BAML call through to the
          // error event so the panel can render the same Prompt/Output
          // drill-down as a successful call. Adapters wrap final propagating
          // failures in LLMCallError specifically for this purpose.
          if (controllerError instanceof LLMCallError) {
            errorLlmCall = controllerError.llmCall
          }
          break
        }

        // Check if done (is_final flag OR tool_name === 'Return')
        if (action.is_final || action.tool_name === 'Return') {
          scope.data = {
            ...scope.data,
            lastAction: action,
            turn
          }
          exitedViaReturn = true
          break
        }

        // Synthetic tool: `expandPreviousResult` — resolves one or more
        // ref_ids to their prior tool_results and records them as a single
        // turn. Intercepted here (before tools.includes guard) so the LLM
        // has an explicit affordance for "I want to reuse this prior data"
        // without needing a real tool. Supports four arg shapes:
        //   "ref:<id>"                   — single (canonical)
        //   "ref:<id_1>,<id_2>,..."      — comma-separated batch
        //   {"ref_id": "<id>"}           — JSON, single (resilience)
        //   {"ref_ids": ["<id>", ...]}   — JSON, batch
        if (action.tool_name === EXPAND_TOOL_NAME) {
          const callId = generateId('tc')
          const refIds = parseExpandRefs(action.tool_args)

          const allEvents = view.fromAll().get()
          type Resolution = { ref_id: string; success: boolean; result: unknown; error?: string }
          const resolutions: Resolution[] = refIds.map(refId => {
            const refEvent = allEvents.find(e => e.id === refId)
            const refData = refEvent?.type === 'tool_result'
              ? (refEvent.data as ToolResultEventData)
              : null
            const usable = refData && !refData.hidden && !refData.archived
            return usable
              ? { ref_id: refId, success: true, result: refData.result }
              : {
                  ref_id: refId,
                  success: false,
                  result: null,
                  error: `ref_id "${refId}" not found in tool_result events (or excluded as hidden/archived)`
                }
          })

          const noRefs = refIds.length === 0
          const overallSuccess = !noRefs && resolutions.some(r => r.success)
          const failureErrors = resolutions.filter(r => !r.success).map(r => r.error)
          const errorMsg = noRefs
            ? `expandPreviousResult: no ref_id parsed from tool_args (${action.tool_args})`
            : failureErrors.length > 0
              ? failureErrors.join('; ')
              : undefined

          // For backward compatibility, a single-ref call returns the bare
          // result; multi-ref calls return a map keyed by ref_id (failures
          // surface as { __error: "..." }).
          const combinedResult: unknown = refIds.length === 1
            ? resolutions[0].result
            : resolutions.reduce<Record<string, unknown>>((acc, r) => {
                acc[r.ref_id] = r.success ? r.result : { __error: r.error }
                return acc
              }, {})

          // tool_call args mirror the input shape: scalar for one ref, list
          // for many. Keeps observability faithful to what the LLM produced.
          const trackedArgs = refIds.length === 1
            ? { ref_id: refIds[0] }
            : { ref_ids: refIds }

          trackEvent(scope, 'tool_call',
            { callId, tool: EXPAND_TOOL_NAME, args: trackedArgs } as ToolCallEventData,
            resolved.trackHistory)
          trackEvent(scope, 'tool_result', {
            callId,
            tool: EXPAND_TOOL_NAME,
            result: combinedResult,
            success: overallSuccess,
            error: errorMsg
          } as ToolResultEventData, resolved.trackHistory)

          // Record as a turn — same shape as a real tool, plus expansions[]
          // (one entry per *successfully* resolved ref) so the per-turn
          // rendering and `expanded_in_turn` annotation work.
          const MAX_RESULT_CHARS = settings.maxResultChars
          const truncate = (s: string) =>
            s.length > MAX_RESULT_CHARS
              ? s.slice(0, MAX_RESULT_CHARS) + '…[truncated]'
              : s
          const resultStr = JSON.stringify(combinedResult)
          const truncated = truncate(resultStr)
          const expansions = resolutions
            .filter(r => r.success)
            .map(r => ({
              ref_id: r.ref_id,
              content: truncate(typeof r.result === 'string' ? r.result : JSON.stringify(r.result))
            }))

          turns.push({
            n: turn,
            reasoning: action.reasoning,
            tool_call: { tool: EXPAND_TOOL_NAME, args: action.tool_args },
            tool_result: {
              tool: EXPAND_TOOL_NAME,
              result: truncated,
              success: overallSuccess,
              error: errorMsg ?? null
            },
            ...(expansions.length > 0 ? { expansions } : {})
          })

          scope.data = { ...scope.data, turn, lastAction: action }
          // Continue to next turn — let the controller use the resolved data.
          continue
        }

        // Validate tool. The static allowlist is augmented by an active
        // `withSandbox` scope's tool surface — `sandbox_*` names pass without
        // being listed in `tools` (see docs/plan/sandbox.md → "How tools reach
        // the controller"). Outside any sandbox scope, `getActiveSandbox()`
        // returns undefined and this collapses to the original check.
        const sandbox = getActiveSandbox()
        const allowed =
          tools.includes(action.tool_name) ||
          (sandbox?.ownsTool(action.tool_name) ?? false)
        if (!allowed) {
          hasError = true
          errorMessage = `Tool not allowed: ${action.tool_name}. Allowed: ${tools.join(', ')}`
          errorTurn = turn
          break
        }

        // Parse tool args (lenient — LLMs may output unquoted keys/values)
        let args: Record<string, unknown>
        try {
          args = repairJson(action.tool_args)
        } catch {
          hasError = true
          // Truncation-aware message: a response cut off at the client's
          // max_tokens cap is not malformed JSON — name the real cause so the
          // synthesizer/user sees it (actorCritic carries the retrying variant).
          errorMessage = llmCallHitOutputCap(controllerLlmCall)
            ? `tool_args for ${action.tool_name} were CUT OFF at the output-token ` +
              `limit (response truncated mid-generation)`
            : `Invalid tool_args JSON: ${action.tool_args}`
          errorTurn = turn
          break
        }

        // Generate correlation ID for this tool call/result pair
        const callId = generateId('tc')

        // Resolve ref: pointers in args (expands to full tool result data from prior events)
        // and capture the substitutions so they render in the next prompt iteration.
        const MAX_RESULT_CHARS = settings.maxResultChars
        const { resolved: resolvedArgs, expansions } = resolveRefsAndCapture(args, view, MAX_RESULT_CHARS)

        // Track tool call event (with original args for readability)
        trackEvent(
          scope,
          'tool_call',
          { callId, tool: action.tool_name, args } as ToolCallEventData,
          resolved.trackHistory
        )

        // Execute tool with resolved args
        const result = await callTool(action.tool_name, resolvedArgs)

        // onToolResult hook: enrich/transform result before the event is committed.
        // Failures here are non-fatal — log an error event, keep the original result.
        if (config?.onToolResult) {
          try {
            const hookResult = await config.onToolResult(
              action.tool_name,
              result,
              { callId, args: resolvedArgs }
            )
            if (hookResult && 'data' in hookResult && hookResult.data !== undefined) {
              result.data = hookResult.data
            }
          } catch (hookErr) {
            const message = hookErr instanceof Error ? hookErr.message : String(hookErr)
            trackEvent(
              scope,
              'error',
              {
                error: `onToolResult hook failed for ${action.tool_name}: ${message}`,
                severity: 'recoverable',
                turn,
              } as ErrorEventData,
              true
            )
          }
        }

        // Track tool result event
        trackEvent(
          scope,
          'tool_result',
          {
            callId,
            tool: action.tool_name,
            result: result.data,
            success: result.success,
            error: result.error
          } as ToolResultEventData,
          resolved.trackHistory
        )

        // Record completed turn for LoopController history.
        // Truncate result to avoid overflowing reasoning models on subsequent turns.
        const resultStr = JSON.stringify(result.data)
        turns.push({
          n: turn,
          reasoning: action.reasoning,
          tool_call: { tool: action.tool_name, args: action.tool_args },
          tool_result: {
            tool: action.tool_name,
            result: resultStr.length > MAX_RESULT_CHARS
              ? resultStr.slice(0, MAX_RESULT_CHARS) + '…[truncated]'
              : resultStr,
            success: result.success,
            error: result.error ?? null
          },
          ...(expansions.length > 0 ? { expansions } : {})
        })

        if (!result.success) {
          hasError = true
          errorMessage = result.error ?? 'Tool call failed'
          errorTurn = turn
          break
        }

        // Update scope data
        scope.data = {
          ...scope.data,
          turn,
          lastAction: action
        }
      }

      if (hasError) {
        // Track error event — downstream patterns read errors via view.errors().
        // When the error originated from a failed BAML call, attach the captured
        // LLM call data so the Observability panel can render the same
        // Prompt/Output drill-down as a successful call.
        trackEvent(scope, 'error', {
          error: errorMessage,
          severity: resolved.errorSeverity,
          hint: getErrorHint(errorMessage ?? ''),
          turn: errorTurn,
          ...(errorLlmCall ? { kind: 'llm_call' as const } : {}),
        } as ErrorEventData, true, errorLlmCall)
      } else if (!exitedViaReturn && turns.length > 0) {
        // Loop exhausted maxTurns without controller signaling completion.
        // Surface as a recoverable error so the synthesizer can warn the user;
        // partial results from completed turns are still preserved on scope.
        trackEvent(scope, 'error', {
          error: `Loop exhausted: reached maxTurns (${maxTurns}) without 'Return' or is_final from the controller. Partial results from ${turns.length} completed turn(s) are preserved.`,
          severity: 'recoverable',
          hint: 'The controller may have needed more turns to finish. Consider increasing maxToolTurns in settings, or simplifying the task.',
          turn: turns.length - 1,
        } as ErrorEventData, true)
      }

      return scope
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      trackEvent(scope, 'error', {
        error: msg,
        severity: resolved.errorSeverity,
        hint: getErrorHint(msg),
      } as ErrorEventData, true)
      return scope
    }
  }

  return {
    name: 'simpleLoop',
    fn,
    config: resolved,
    estimateTurns: (s) => config?.maxTurns ?? s.maxToolTurns
  }
}
