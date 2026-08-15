/**
 * Actor-Critic Pattern
 *
 * Generate-evaluate loop with retry on failure.
 * Designed for code mode: generates scripts, executes them, evaluates results.
 */

import { Collector } from '@boundaryml/baml'
import { assertServerOnImport } from '../assert.server'
import { callTool, listTools as mcpListTools } from '../mcp-client.server'
import { invalidateToolDescriptions } from '../baml-adapters.server'
import { repairJson } from '../json-repair'
import type {
  ControllerAction,
  ActorCriticConfig,
  ScriptExecutionEvent,
  PatternScope,
  EventView,
  ConfiguredPattern,
  ToolCallEventData,
  ToolResultEventData,
  ControllerActionEventData,
  CriticResultEventData,
} from '../types'
import type { ErrorEventData, MultiCallMode } from '../types'
import { runBatch, combineOutcomes } from '../parallel-tools.server'
import type { SubCall } from '../parallel-tools.server'
import { getErrorHint } from '../error-hints'
import { trackEvent, resolveConfig, generateId } from '../context.server'
import { getRequestSettings } from '../../settings-context.server'
import { getActiveSandbox } from '../../sandbox/scope.server'
import type { CodeModeControllerFnWithLLMData, CriticFnWithLLMData } from '../baml-adapters.server'
import { LLMCallError, llmCallHitOutputCap } from '../baml-adapters.server'

assertServerOnImport()

export interface ActorCriticData {
  attempt?: number
  intent?: string
  lastAction?: ControllerAction
  lastResult?: unknown
  feedback?: string
  result?: unknown
  results?: unknown[]
  response?: string
}

/**
 * Create an actor-critic pattern.
 *
 * Calls BAML controller and critic functions directly for code mode workflows.
 *
 * @param actor - BAML controller function (e.g., b.CodeModeController)
 * @param critic - BAML critic function (e.g., b.CodeModeCritic)
 * @param tools - Allowed tool names
 * @param config - Configuration (availableTools, maxRetries, patternId, etc.)
 * @returns ConfiguredPattern ready for chain
 *
 * @example
 * const loop = actorCritic(b.CodeModeController, b.CodeModeCritic, tools.all, {
 *   patternId: 'code-mode',
 *   availableTools,
 *   maxRetries: 3
 * })
 */
export function actorCritic<T extends ActorCriticData>(
  actor: CodeModeControllerFnWithLLMData,
  critic: CriticFnWithLLMData,
  tools: string[],
  config?: ActorCriticConfig,
): ConfiguredPattern<T> {
  const availableTools = config?.availableTools ?? tools
  const resolved = resolveConfig('actorCritic', config)

  const fn = async (scope: PatternScope<T>, view: EventView): Promise<PatternScope<T>> => {
    const maxRetries = config?.maxRetries ?? getRequestSettings().maxRetries
    // Critic cadence: run the critic every Nth *successful* actor turn (default
    // 1 = every turn, the original behavior). Clamped to >= 1 so a stray 0 /
    // negative value can't disable the critic — the loop's only exit authority.
    // See `ActorCriticConfig.criticCadence` and the cadence gate below.
    const criticCadence = Number.isFinite(config?.criticCadence)
      ? Math.max(1, Math.floor(config!.criticCadence!))
      : 1
    // Multi-call attempts (ControllerAction.additional_calls) — see
    // simpleLoop.server.ts for the mode semantics ('off' executes serially,
    // it only suppresses the prompt affordance).
    const multiMode: MultiCallMode = config?.multiToolCalls ?? 'parallel'
    let successfulTurns = 0
    const previousAttempts: ScriptExecutionEvent[] = []
    let errorMessage: string | undefined

    // Shared post-execution tail for singular AND multi-call attempts.
    //
    // Cadence gate: the actor free-runs successful tool calls; the critic
    // (the loop's SOLE exit authority) only weighs in periodically, so a
    // multi-step deliverable isn't interrupted mid-plan and wrongly judged
    // "done" on an intermediate state. Run the critic when ANY of:
    //   - the actor set `is_final: true` — it believes the task is done and
    //     is asking to be judged (it still can't exit by itself);
    //   - this is the final attempt — so work that completes on the last
    //     turn is still evaluated (and can be accepted) instead of falling
    //     through to "Max retries exceeded";
    //   - it's the Nth successful turn — a backstop for an actor that never
    //     sets `is_final`.
    // At criticCadence === 1 the modulo is always true → critic every turn.
    //
    // Returns 'accepted' when the critic ends the loop; the caller returns
    // scope. Mutates successfulTurns and scope.data.
    const runCadenceAndCritic = async (
      scope: PatternScope<T>,
      action: ControllerAction,
      resultData: unknown,
      attempt: number,
      intent: string,
    ): Promise<'accepted' | 'continue'> => {
      successfulTurns++
      const isLastAttempt = attempt === maxRetries - 1
      const shouldCritique =
        action.is_final === true || isLastAttempt || successfulTurns % criticCadence === 0

      if (!shouldCritique) {
        // Skip the critic this turn and let the actor take the next step. The
        // tool result is already in `previousAttempts` (the actor's
        // self-correction channel), so the next actor call sees what happened.
        scope.data = {
          ...scope.data,
          attempt,
          lastAction: action,
          lastResult: resultData,
        }
        return 'continue'
      }

      const criticCollector = new Collector('critic')
      const { result: evalResult, llmCall: criticLlmCall } = await critic(
        intent,
        previousAttempts,
        criticCollector,
      )

      trackEvent(
        scope,
        'critic_result',
        { result: evalResult } as CriticResultEventData,
        resolved.trackHistory,
        criticLlmCall,
      )

      const evaluation = {
        ok: evalResult.is_sufficient,
        feedback: evalResult.is_sufficient
          ? undefined
          : (evalResult.suggested_approach ?? evalResult.explanation),
      }

      if (evaluation.ok) {
        scope.data = {
          ...scope.data,
          attempt,
          lastAction: action,
          result: resultData,
        }
        return 'accepted'
      }

      // Update for next attempt
      scope.data = {
        ...scope.data,
        attempt,
        lastAction: action,
        lastResult: resultData,
        feedback: evaluation.feedback,
      }
      return 'continue'
    }

    try {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        // Get the original user input. Use `ofType('user_message')` (not
        // `messages()`, which also includes assistant_message) so a router or
        // other upstream pattern emitting an intermediate `assistant_message`
        // (e.g. a transient "Looking into that..." status) can't bump itself
        // into the "last message" slot and end up rendered as the user's input
        // in the actor prompt. `fromAll()` bypasses the per-pattern view scope —
        // the user_message lives at the harness level, outside this loop's id.
        const userMessage = view.fromAll().ofType('user_message').last(1).get()[0]
        const userContent = userMessage ? (userMessage.data as { content: string }).content : ''
        const intent = scope.data.intent ?? userContent

        // Call actor. We pass `attempt + 1` (1-indexed for the prompt) and
        // maxRetries so the actor's prompt can surface "Attempt N of M" and
        // nudge the model toward `Return` when the budget is nearly exhausted.
        const actorCollector = new Collector('actor')
        const { action, llmCall: actorLlmCall } = await actor(
          userContent,
          intent,
          availableTools,
          previousAttempts,
          actorCollector,
          attempt + 1,
          maxRetries,
          multiMode === 'off' ? undefined : multiMode,
        )

        // Track controller action with LLM call data. `turn` and `maxTurns`
        // (mapped from attempt / maxRetries) are exposed so live progress
        // consumers can size their indicators against the runtime values.
        trackEvent(
          scope,
          'controller_action',
          { action, turn: attempt, maxTurns: maxRetries } as ControllerActionEventData,
          resolved.trackHistory,
          actorLlmCall,
        )

        // P0 (Return-from-critic redesign): the actor cannot EXIT the loop on
        // its own — sufficiency-to-exit is the critic's job by definition, and
        // the dual responsibility once let the actor self-terminate with
        // fabricated data (see `.harness-logs/one-turn-codemode.json`). That
        // invariant still holds: the critic is the SOLE exit authority below.
        //
        // `is_final` is now an advisory *critic trigger*, not an exit: when the
        // actor sets it, the cadence gate (after the tool call) runs the critic
        // this turn even under `criticCadence` > 1 — but the critic still
        // decides whether the loop exits. If the actor proposes a `Return` tool
        // (or anything not on the allowlist) it falls through to the allowlist
        // check below, is rejected as "Tool not allowed", and the loop continues.

        // Multi-call attempt: tool_name/tool_args is call 1, additional_calls
        // are calls 2..N. Mirrors simpleLoop's batch path with the actor's
        // differences: the allowlist adds the dynamic sources, there are no
        // control-flow tools to exclude (no Return/expand here — a batched
        // 'Return' just fails the allowlist per-call), and the whole batch
        // records as ONE attempt whose output is the index-keyed combined map
        // (what the critic evaluates). `is_final` may accompany a batch — the
        // cadence gate below treats it exactly like a singular attempt.
        if (action.additional_calls && action.additional_calls.length > 0) {
          const batchId = generateId('batch')
          const allCalls = [
            { tool_name: action.tool_name, tool_args: action.tool_args },
            ...action.additional_calls,
          ]
          const dynamicAllowlist = config?.dynamicToolAllowlist
            ? await config.dynamicToolAllowlist()
            : []
          const sandboxScope = getActiveSandbox()
          const callIds: string[] = []
          const trackedArgs: unknown[] = []
          const subCalls: SubCall[] = []

          for (const c of allCalls) {
            const callId = generateId('tc')
            callIds.push(callId)
            const callAllowed =
              tools.includes(c.tool_name) ||
              dynamicAllowlist.includes(c.tool_name) ||
              (sandboxScope?.ownsTool(c.tool_name) ?? false) ||
              (config?.dynamicToolPattern?.test(c.tool_name) ?? false)
            if (!callAllowed) {
              trackedArgs.push(c.tool_args)
              subCalls.push({
                tool: c.tool_name,
                precheckError: `Tool not allowed: ${c.tool_name}`,
              })
              continue
            }
            let callArgs: Record<string, unknown>
            try {
              callArgs = repairJson(c.tool_args)
            } catch {
              trackedArgs.push(c.tool_args)
              subCalls.push({
                tool: c.tool_name,
                precheckError: llmCallHitOutputCap(actorLlmCall)
                  ? `tool_args for ${c.tool_name} were CUT OFF at the output-token limit — ` +
                    `the batch was too large; use fewer calls per attempt or split large payloads`
                  : `Invalid tool_args JSON for ${c.tool_name}`,
              })
              continue
            }
            trackedArgs.push(callArgs)
            subCalls.push({
              tool: c.tool_name,
              run: async () => {
                const result = await callTool(c.tool_name, callArgs)
                // Factory tools register new tools on success — same cache
                // invalidation as the singular path, per sub-call.
                if (result.success && c.tool_name === 'code-mode') {
                  invalidateToolDescriptions()
                  try {
                    await mcpListTools()
                  } catch {
                    // Non-fatal — the actor can still invoke the new tool by name.
                  }
                }
                if (config?.onToolResult) {
                  try {
                    const hookResult = await config.onToolResult(c.tool_name, result, {
                      callId,
                      args: callArgs,
                    })
                    if (hookResult && 'data' in hookResult && hookResult.data !== undefined) {
                      result.data = hookResult.data
                    }
                  } catch (hookErr) {
                    const message = hookErr instanceof Error ? hookErr.message : String(hookErr)
                    trackEvent(
                      scope,
                      'error',
                      {
                        error: `onToolResult hook failed for ${c.tool_name}: ${message}`,
                        severity: 'recoverable',
                      },
                      true,
                    )
                  }
                }
                return { success: result.success, result: result.data, error: result.error }
              },
            })
          }

          subCalls.forEach((sc, i) =>
            trackEvent(
              scope,
              'tool_call',
              {
                callId: callIds[i],
                batchId,
                tool: sc.tool,
                args: trackedArgs[i],
              } as ToolCallEventData,
              resolved.trackHistory,
            ),
          )

          const outcomes = await runBatch(subCalls, multiMode)

          outcomes.forEach((o, i) =>
            trackEvent(
              scope,
              'tool_result',
              {
                callId: callIds[i],
                batchId,
                tool: o.tool,
                result: o.result ?? null,
                success: o.success,
                error: o.error,
              } as ToolResultEventData,
              resolved.trackHistory,
            ),
          )

          const { combined, anySucceeded, errors } = combineOutcomes(outcomes)

          // ONE attempt records the whole batch. `additionalCalls` carries the
          // actor's exact emission so the adapter's Attempt construction
          // replays the real batch action (exact-replay invariant); partial
          // failures stay visible to the actor as __error entries in `output`.
          previousAttempts.push({
            toolName: action.tool_name,
            script: action.tool_args,
            additionalCalls: action.additional_calls,
            output: anySucceeded ? JSON.stringify(combined) : '',
            error: anySucceeded ? null : errors.join('; '),
          })

          if (!anySucceeded) {
            continue
          }

          if (
            (await runCadenceAndCritic(scope, action, combined, attempt, intent)) === 'accepted'
          ) {
            return scope
          }
          continue
        }

        // Validate tool. The strict allowlist is augmented by an optional
        // `dynamicToolPattern` regex so agents whose backends create tools at
        // runtime (e.g. the kg-agent gateway's `code-mode-<name>` factory)
        // can accept those names without enumerating them upfront. A second
        // augmentation, `dynamicToolAllowlist`, is a per-turn callback for
        // user-curated selections (e.g. the code-mode agent's per-conversation
        // tool picker) — kept in sync with the adapter's `toolNamesProvider`.
        const dynamicAllowlist = config?.dynamicToolAllowlist
          ? await config.dynamicToolAllowlist()
          : []
        // A third augmentation: an active `withSandbox` scope's tool surface.
        // Sandbox-owned (`sandbox_*`) names pass without being listed in
        // `tools` or `dynamicToolAllowlist` (see docs/plan/sandbox.md → "How
        // tools reach the controller"). Outside any sandbox scope this is
        // a no-op.
        const sandbox = getActiveSandbox()
        const allowed =
          tools.includes(action.tool_name) ||
          dynamicAllowlist.includes(action.tool_name) ||
          (sandbox?.ownsTool(action.tool_name) ?? false) ||
          (config?.dynamicToolPattern?.test(action.tool_name) ?? false)
        if (!allowed) {
          const errMsg = `Tool not allowed: ${action.tool_name}`
          // Only surface as a visible error event when the allowlist has
          // SOME entries — that's a real actor mistake (proposed wrong tool
          // name). When the combined allowlist is empty, that's almost
          // always a transient MCP gateway issue, and a per-turn flood of
          // identical "Tool not allowed" events would spam the synth's view
          // and observability UI without helping. The actor still sees the
          // rejection via `previousAttempts` either way (its standard
          // feedback channel), and the gateway-down case resolves on the
          // next turn once `withReconnect` rebuilds the transport and
          // `toolNamesProvider` re-resolves to a non-empty list.
          const allowlistHasContent = tools.length > 0 || dynamicAllowlist.length > 0
          if (allowlistHasContent) {
            trackEvent(
              scope,
              'error',
              {
                error: errMsg,
                severity: 'recoverable',
                hint:
                  'Actor proposed a tool not on the allowlist (and not matched by ' +
                  'dynamicToolPattern / dynamicToolAllowlist).',
                iteration: attempt,
              } as ErrorEventData,
              resolved.trackHistory,
            )
          }
          previousAttempts.push({
            toolName: action.tool_name,
            script: action.tool_args,
            output: '',
            error: errMsg,
          })
          continue
        }

        // Parse args (lenient — LLMs may output unquoted keys/values)
        let args: Record<string, unknown>
        try {
          args = repairJson(action.tool_args)
        } catch {
          // Surface unparseable tool_args as a recoverable error too — same
          // observability reasoning as the allowlist branch above.
          //
          // Truncation-aware feedback: when the actor call hit its client's
          // output-token cap, the args aren't malformed — they were CUT OFF.
          // Generic "fix your JSON quoting" feedback makes the model regenerate
          // the same oversized payload until retries exhaust; say the real
          // cause so the retry converges (write smaller, append to continue).
          const truncated = llmCallHitOutputCap(actorLlmCall)
          const errMsg = truncated
            ? `tool_args for ${action.tool_name} were CUT OFF at the output-token limit ` +
              `(response truncated mid-generation, not a formatting mistake). Produce a ` +
              `materially smaller tool_args: write the first part of any large file now ` +
              `and CONTINUE BY APPENDING in later calls (e.g. bash \`cat >> file <<'EOF'\`).`
            : `Invalid tool_args JSON for ${action.tool_name}: ${action.tool_args}`
          trackEvent(
            scope,
            'error',
            {
              error: errMsg,
              severity: 'recoverable',
              hint: truncated
                ? 'Actor response hit the max_tokens cap mid-tool_args. The actor sees ' +
                  'truncation-specific feedback in previousAttempts and should split the work.'
                : 'Actor produced unparseable tool_args. Common causes: unquoted ' +
                  'keys/values, unescaped newlines inside scripts. The actor will ' +
                  'see this in previousAttempts and (hopefully) retry with valid JSON.',
              iteration: attempt,
            } as ErrorEventData,
            resolved.trackHistory,
          )
          previousAttempts.push({
            toolName: action.tool_name,
            script: action.tool_args,
            output: '',
            error: errMsg,
          })
          continue
        }

        // Generate correlation ID for this tool call/result pair
        const callId = generateId('tc')

        // Track tool call
        trackEvent(
          scope,
          'tool_call',
          { callId, tool: action.tool_name, args } as ToolCallEventData,
          resolved.trackHistory,
        )

        // Execute tool
        const result = await callTool(action.tool_name, args)

        // The kg-agent `code-mode` tool is a factory: a successful call
        // registers a new tool (`code-mode-<args.name>`). Invalidate the
        // adapter's tool-description cache so the next actor invocation
        // re-fetches a fresh listing and includes the newly-created tool in
        // the LLM's prompt. The gateway persists these tools across turns, so
        // this also makes them visible to future user turns in the same session.
        if (result.success && action.tool_name === 'code-mode') {
          invalidateToolDescriptions()
          try {
            await mcpListTools() // warm the gateway's own cache; non-fatal
          } catch {
            // Non-fatal — the actor can still try to invoke the new tool by name.
          }
        }

        // onToolResult hook: enrich/transform result before commit. See SimpleLoop for full doc.
        if (config?.onToolResult) {
          try {
            const hookResult = await config.onToolResult(action.tool_name, result, { callId, args })
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
              },
              true,
            )
          }
        }

        // Track result
        const script = typeof args.script === 'string' ? args.script : JSON.stringify(args)
        previousAttempts.push({
          toolName: action.tool_name,
          script,
          output: result.success ? JSON.stringify(result.data) : '',
          error: result.success ? null : (result.error ?? 'Execution failed'),
        })

        trackEvent(
          scope,
          'tool_result',
          {
            callId,
            tool: action.tool_name,
            result: result.data,
            success: result.success,
            error: result.error,
          } as ToolResultEventData,
          resolved.trackHistory,
        )

        if (!result.success) {
          continue
        }

        if (
          (await runCadenceAndCritic(scope, action, result.data, attempt, intent)) === 'accepted'
        ) {
          return scope
        }
      }

      // Exhausted retries
      errorMessage = `Max retries (${maxRetries}) exceeded`
      trackEvent(
        scope,
        'error',
        {
          error: errorMessage,
          severity: resolved.errorSeverity,
          hint: getErrorHint(errorMessage),
          iteration: maxRetries - 1,
        } as ErrorEventData,
        true,
      )

      return scope
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      // Preserve LLM call data through to the error event so the panel can
      // show the prompt drill-down for failed BAML calls (actor or critic).
      const llmCall = error instanceof LLMCallError ? error.llmCall : undefined
      trackEvent(
        scope,
        'error',
        {
          error: msg,
          severity: resolved.errorSeverity,
          hint: getErrorHint(msg),
          ...(llmCall ? { kind: 'llm_call' as const } : {}),
        } as ErrorEventData,
        true,
        llmCall,
      )
      return scope
    }
  }

  return {
    name: 'actorCritic',
    fn,
    config: resolved,
    estimateTurns: (s) => config?.maxRetries ?? s.maxRetries,
  }
}
