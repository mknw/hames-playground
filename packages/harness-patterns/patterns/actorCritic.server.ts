/**
 * Actor-Critic Pattern
 *
 * Generate-evaluate loop with retry on failure: the actor proposes a tool
 * call, the loop executes it, and the critic decides whether to stop or
 * feed the result back for another attempt.
 */

import { assertServerOnImport } from '../assert.server'
import { callTool } from '../mcp-client.server'
import { isAgentWithheldTool } from '../agent-withheld-tools'
import { repairJsonTracked, type JsonRepairNote } from '../json-repair'
import { normalizeControllerAction } from '../controller-action'
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
import { getErrorHint, budgetHint } from '../error-hints'
import { trackEvent, resolveConfig, generateId } from '../context.server'
import { resolveTurnBudget, runtimeConfig } from '../runtime-config.server'
import { activeTransports } from '../tool-transport.server'
import { toolSurfaceOutage } from '../gateway-health.server'
import {
  isRecoverableLLMFailure,
  unparseableOutputFeedback,
  invalidToolArgsFeedback,
  trackLoopRecovery,
  resolveMaxConsecutiveRecoveries,
  recoveryStreak,
  recoveryExhaustedMarker,
} from '../loop-recovery.server'
import type { ActorFn, ControllerCallResult, CriticFnWithLLMData, LLMCallRecord } from '../types'
import { LLMCallError } from '../types'
import { formatPlanContext, type PlannerData } from './planner.server'

assertServerOnImport()

/** The allowlist refusal, naming a tool withheld from every agent (#403) as
 *  such, so neither the actor nor a reader takes it for a misspelling. */
function refusal(name: string): string {
  return (
    `Tool not allowed: ${name}` + (isAgentWithheldTool(name) ? ' (withheld from every agent)' : '')
  )
}

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
 * Calls BAML actor and critic functions directly.
 *
 * @param actor - Actor function from `createActorControllerAdapter(toolNames)`
 *   — NOT a raw bound `b.ActorController`, whose positional signature differs
 *   from the `ActorFn` contract (same rule as
 *   simpleLoop's controller)
 * @param critic - Critic function from `createCriticAdapter()`
 * @param tools - Allowed tool names
 * @param config - Configuration (maxRetries, patternId, etc.)
 * @returns ConfiguredPattern ready for chain
 *
 * @example
 * const loop = actorCritic(
 *   createActorControllerAdapter(tools.all),
 *   createCriticAdapter(),
 *   tools.all,
 *   {
 *     patternId: 'sandbox-loop',
 *     maxRetries: 3
 *   }
 * )
 */
export function actorCritic<T extends ActorCriticData>(
  actor: ActorFn,
  critic: CriticFnWithLLMData,
  tools: string[],
  config?: ActorCriticConfig,
): ConfiguredPattern<T> {
  const resolved = resolveConfig('actorCritic', config)

  const fn = async (scope: PatternScope<T>, view: EventView): Promise<PatternScope<T>> => {
    // Same collapsed-tool-surface refusal as simpleLoop (#276) — see the
    // comment there for why the event, not the pattern default, carries the
    // `irrecoverable`. This pattern's production users are the two sandbox
    // agents, which pass `[]` on purpose and run inside a scoped transport, so
    // that guard is what keeps them out of this branch rather than an
    // exemption; a future gateway-backed actorCritic gets the check for free.
    const outage = activeTransports().length > 0 ? null : toolSurfaceOutage(tools)
    if (outage) {
      trackEvent(scope, 'error', { ...outage, severity: 'irrecoverable' } as ErrorEventData, true)
      return scope
    }

    // Same resolution rule as simpleLoop's round budget: the pattern's own
    // declaration wins over the request's setting, clamped to the bound the
    // host's stuck-run reaper derives from (`runtime-config.ts`,
    // `resolveTurnBudget`).
    const maxRetries = resolveTurnBudget(
      'maxRetries',
      config?.maxRetries,
      runtimeConfig().maxRetries,
    )
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
    // Plan from an upstream `planner` pattern (#27), forwarded by the chain as
    // this pattern's `currentData`. Formatted once — it cannot change between
    // attempts — and passed to the actor as its trailing `planContext`
    // argument. Absent when no planner ran.
    const planContext = formatPlanContext((scope.data as PlannerData).plan)
    let successfulTurns = 0
    const previousAttempts: ScriptExecutionEvent[] = []
    let errorMessage: string | undefined

    // The consecutive-recovery cap (#450 review §3), counted in attempts — see
    // `recoveryStreak`. The cap-th unusable answer in a row ends the loop with
    // the error the outer catch records for an LLM failure, plus the marker.
    // (A refused tool or bad `tool_args` never ended this loop before #437, so
    // for those two the cap is the first fatal path there is.)
    const maxConsecutiveRecoveries = resolveMaxConsecutiveRecoveries(
      config?.maxConsecutiveRecoveries,
    )
    const streak = recoveryStreak(maxConsecutiveRecoveries)
    const endOnRecoveryCap = (
      scope: PatternScope<T>,
      error: string,
      attempt: number,
      llmCall: LLMCallRecord | undefined,
    ): PatternScope<T> => {
      trackEvent(
        scope,
        'error',
        {
          error,
          severity: resolved.errorSeverity,
          iteration: attempt,
          ...recoveryExhaustedMarker(maxConsecutiveRecoveries, resolved.patternId),
        } as ErrorEventData,
        true,
        llmCall,
      )
      return scope
    }

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

      const { result: evalResult, llmCall: criticLlmCall } = await critic(intent, previousAttempts)

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

      // Stamp the rejection reason onto the attempt the critic just judged.
      // This is the ONLY path by which feedback reaches the next actor call:
      // both adapters map `ScriptExecutionEvent.feedback` onto
      // `Attempt.feedback`, and `ActorAttemptLog` renders it as
      // "CRITIC FEEDBACK" beside that attempt's result. Without the stamp the
      // actor retried blind while the closing section told it to address
      // feedback it could not see — an invitation to invent one.
      // `scope.data.feedback` below is for consumers of the pattern's data;
      // it is not on the actor's input path.
      const judged = previousAttempts[previousAttempts.length - 1]
      if (judged && evaluation.feedback) {
        judged.feedback = evaluation.feedback
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
        // in the actor prompt. `fromAll()` drops the per-pattern scope — the
        // user_message lives at the harness level, outside this loop's id.
        // It does NOT drop a caller-supplied `viewConfig`'s own filters
        // (`fromAll()` is `clone()`, and `clone()` copies them); `unfiltered()`
        // is the method that does, as `planner` uses.
        const userMessage = view.fromAll().ofType('user_message').last(1).get()[0]
        const userContent = userMessage ? (userMessage.data as { content: string }).content : ''
        const intent = scope.data.intent ?? userContent

        // Call actor. We pass `attempt + 1` (1-indexed for the prompt) and
        // maxRetries so the actor's prompt can surface "Attempt N of M" and
        // nudge the model toward `Return` when the budget is nearly exhausted.
        // No collector is passed (Lane A3): the implementation owns it and
        // returns the call record on the result.
        // Object seam (Lane A4): the actor's attempts arrive as typed events;
        // no collector is passed (Lane A3) — the implementation owns it.
        let actorResult: ControllerCallResult
        try {
          actorResult = await actor({
            userMessage: userContent,
            intent,
            availableTools: tools,
            previousAttempts,
            attemptNumber: attempt + 1,
            maxAttempts: maxRetries,
            multiCallMode: multiMode === 'off' ? undefined : multiMode,
            planContext,
          })
        } catch (actorError) {
          // An answer that would not parse is fed back as this attempt's
          // result, through the same `previousAttempts` channel every other
          // recoverable failure here uses, and costs the attempt (#437 slice
          // 1, #425 C2 — it used to reach the outer catch and end the loop
          // with attempts left). An empty tool name: no call was made, and the
          // attempt log replays an empty action followed by the ERROR.
          // Anything else — the model never answered, or an unclassified
          // failure — rethrows to the outer catch, fatal as before.
          if (!isRecoverableLLMFailure(actorError)) throw actorError
          if (streak.unusableAnswer()) {
            return endOnRecoveryCap(scope, actorError.message, attempt, actorError.llmCall)
          }
          previousAttempts.push({
            toolName: '',
            script: '',
            output: '',
            error: unparseableOutputFeedback(actorError),
          })
          trackLoopRecovery(
            scope,
            {
              failure: 'unparseable_output',
              error: actorError.message,
              turn: attempt,
              maxTurns: maxRetries,
            },
            actorError.llmCall,
          )
          continue
        }
        const { action: rawAction, llmCall: actorLlmCall } = actorResult

        // Apply the contract's documented defaults ONCE, here, before the
        // action is recorded or read: `is_final` is optional (#159) and absent
        // means false. The actor is affected exactly as the loop controller is
        // — same `ControllerAction` class, same undemonstrated field — so the
        // normalisation is symmetric. Here it keeps an omission from being read
        // as "not asking for the critic" in one place and rendered as `null`
        // back into the actor's own attempt history in another.
        const action = normalizeControllerAction(rawAction)

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
        // fabricated data. That
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
          const scopedTransports = activeTransports()
          const callIds: string[] = []
          const trackedArgs: unknown[] = []
          const trackedRepairs: (JsonRepairNote | undefined)[] = []
          // One writer for both, read positionally at the emit below — see the
          // simpleLoop twin for the F1 desync this shape prevents (#217b).
          const track = (args: unknown, repair?: JsonRepairNote) => {
            trackedArgs.push(args)
            trackedRepairs.push(repair)
          }
          const subCalls: SubCall[] = []

          for (const c of allCalls) {
            const callId = generateId('tc')
            callIds.push(callId)
            // Withheld from every agent (#403) before any augmentation: no
            // list, callback or pattern can hand one back.
            const callAllowed =
              !isAgentWithheldTool(c.tool_name) &&
              (tools.includes(c.tool_name) ||
                dynamicAllowlist.includes(c.tool_name) ||
                scopedTransports.some((t) => t.ownsTool(c.tool_name)) ||
                (config?.dynamicToolPattern?.test(c.tool_name) ?? false))
            if (!callAllowed) {
              track(c.tool_args)
              subCalls.push({
                tool: c.tool_name,
                precheckError: refusal(c.tool_name),
              })
              continue
            }
            let callArgs: Record<string, unknown>
            let callRepair: JsonRepairNote | undefined
            try {
              const parsed = repairJsonTracked(c.tool_args)
              callArgs = parsed.args
              callRepair = parsed.repair
            } catch {
              track(c.tool_args)
              subCalls.push({
                tool: c.tool_name,
                precheckError: actorLlmCall?.hitOutputCap
                  ? `tool_args for ${c.tool_name} were CUT OFF at the output-token limit — ` +
                    `the batch was too large; use fewer calls per attempt or split large payloads`
                  : `Invalid tool_args JSON for ${c.tool_name}`,
              })
              continue
            }
            track(callArgs, callRepair)
            subCalls.push({
              tool: c.tool_name,
              run: async () => {
                const result = await callTool(c.tool_name, callArgs)
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
                return {
                  success: result.success,
                  result: result.data,
                  error: result.error,
                  ...(result.sanitized ? { sanitized: result.sanitized } : {}),
                }
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
                ...(trackedRepairs[i] ? { repaired: trackedRepairs[i] } : {}),
              } as ToolCallEventData,
              resolved.trackHistory,
            ),
          )

          const outcomes = await runBatch(subCalls, multiMode)
          // simpleLoop's twin: only a sub-call that was actually dispatched
          // breaks a run of unusable answers.
          if (subCalls.some((sc, i) => sc.run && !outcomes[i].skipped)) streak.dispatched()

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
                ...(o.sanitized ? { sanitized: o.sanitized } : {}),
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
            trackLoopRecovery(
              scope,
              {
                failure: 'batch_failed',
                error: `All ${allCalls.length} calls of the multi-call attempt failed: ${errors.join('; ')}`,
                turn: attempt,
                maxTurns: maxRetries,
              },
              // Cut off at the cap → the response is the defect; a tool-level
              // failure keeps no llmCall (simpleLoop's batch twin, same rule).
              actorLlmCall?.hitOutputCap ? actorLlmCall : undefined,
            )
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
        // runtime can accept those names without enumerating them upfront. A
        // second augmentation, `dynamicToolAllowlist`, is a per-turn callback
        // for user-curated selections — kept in sync with the adapter's
        // `toolNamesProvider`.
        const dynamicAllowlist = config?.dynamicToolAllowlist
          ? await config.dynamicToolAllowlist()
          : []
        // A third augmentation: the tool surface of every transport scoped to
        // this run. Sandbox-owned (`sandbox_*`) names pass without being listed
        // in `tools` or `dynamicToolAllowlist` (see docs/plan/sandbox.md → "How
        // tools reach the controller"). Outside any scope this is a no-op.
        // A tool withheld from every agent (#403) is refused before any of
        // the three augmentations is consulted.
        const scopedTransports = activeTransports()
        const allowed =
          !isAgentWithheldTool(action.tool_name) &&
          (tools.includes(action.tool_name) ||
            dynamicAllowlist.includes(action.tool_name) ||
            scopedTransports.some((t) => t.ownsTool(action.tool_name)) ||
            (config?.dynamicToolPattern?.test(action.tool_name) ?? false))
        if (!allowed) {
          const errMsg = refusal(action.tool_name)
          if (streak.unusableAnswer()) {
            return endOnRecoveryCap(scope, errMsg, attempt, actorLlmCall)
          }
          // The actor sees the rejection via `previousAttempts` (its standard
          // feedback channel) and the loop continues. Recorded as a
          // `loop_recovery`, not an `error` (#437 slice 1): an `error` here
          // reached the chat as a red bubble and `compactExecution` as "the
          // run failed" for a mistake the loop then routed around (#235).
          // Recorded on every refusal, including against an empty allowlist —
          // the old reason to suppress that case was the flood of `error`
          // events into the synthesizer's view, which no reader of this event
          // type has.
          trackLoopRecovery(
            scope,
            {
              failure: 'tool_not_allowed',
              error: errMsg,
              tool: action.tool_name,
              turn: attempt,
              maxTurns: maxRetries,
            },
            // The tool name the actor chose is the defect, so the response
            // that named it is the evidence — carry it onto the event.
            actorLlmCall,
          )
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
        let argsRepair: JsonRepairNote | undefined
        try {
          const parsed = repairJsonTracked(action.tool_args)
          args = parsed.args
          argsRepair = parsed.repair
        } catch {
          // Truncation-aware feedback: when the actor call hit its client's
          // output-token cap, the args aren't malformed — they were CUT OFF.
          // Generic "fix your JSON quoting" feedback makes the model regenerate
          // the same oversized payload until retries exhaust; say the real
          // cause so the retry converges (write smaller, append to continue).
          // Recorded as a `loop_recovery` for the allowlist branch's reason.
          const errMsg = invalidToolArgsFeedback(
            action.tool_name,
            action.tool_args,
            actorLlmCall?.hitOutputCap ?? false,
          )
          if (streak.unusableAnswer()) {
            return endOnRecoveryCap(scope, errMsg, attempt, actorLlmCall)
          }
          trackLoopRecovery(
            scope,
            {
              failure: 'invalid_tool_args',
              error: errMsg,
              tool: action.tool_name,
              turn: attempt,
              maxTurns: maxRetries,
            },
            // `errMsg` quotes the args; only the raw response shows WHERE it
            // went wrong (a cut-off heredoc, an unescaped newline in a script).
            actorLlmCall,
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
          {
            callId,
            tool: action.tool_name,
            args,
            ...(argsRepair ? { repaired: argsRepair } : {}),
          } as ToolCallEventData,
          resolved.trackHistory,
        )

        // Execute tool. A dispatch ends any run of unusable answers, whatever
        // the tool then returns.
        streak.dispatched()
        const result = await callTool(action.tool_name, args)

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
            ...(result.sanitized ? { sanitized: result.sanitized } : {}),
          } as ToolResultEventData,
          resolved.trackHistory,
        )

        // The actor sees the failure in `previousAttempts` and tries again — this
        // loop always worked that way. What #437 slice 1 adds is the record, so
        // the panel shows the recovery the same way it does for simpleLoop.
        if (!result.success) {
          trackLoopRecovery(scope, {
            failure: 'tool_error',
            error: result.error ?? 'Execution failed',
            tool: action.tool_name,
            turn: attempt,
            maxTurns: maxRetries,
          })
          continue
        }

        if (
          (await runCadenceAndCritic(scope, action, result.data, attempt, intent)) === 'accepted'
        ) {
          return scope
        }
      }

      // Exhausted retries — a TRUNCATION, not a failure, and marked as one so
      // the panel and the tests can tell the two apart without matching this
      // sentence (#269). `maxTurns` carries the budget here too: it is the field
      // the controller_action events above already use for `maxRetries`, so one
      // reader serves both loops.
      errorMessage = `Max retries (${maxRetries}) exceeded`
      trackEvent(
        scope,
        'error',
        {
          error: errorMessage,
          severity: resolved.errorSeverity,
          hint: budgetHint('maxRetries', config?.maxRetries, maxRetries, resolved.patternId),
          iteration: maxRetries - 1,
          maxTurns: maxRetries,
          kind: 'budget_exhausted' as const,
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
    estimateTurns: (s) => resolveTurnBudget('maxRetries', config?.maxRetries, s.maxRetries),
  }
}
