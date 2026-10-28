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
import { trackEvent, resolveConfig, redactCall } from '../context.server'

assertServerOnImport()

/**
 * Build synthesis input from EventView based on mode.
 */
function buildSynthesisInputFromView(
  mode: CompactExecutionConfig['mode'],
  view: EventView,
  data: CompactExecutionData,
  errorTurnWindow: number,
  /** The caller's own `viewConfig.fromPatterns`, when it declared any. */
  scopedToPatterns: boolean,
  /** Turn window of the `thread` read when scoped; never applied to errors. */
  threadTurnWindow: number,
): CompactExecutionInput {
  // The user's message is the one input a pattern needs however its view was
  // configured: `fromAll()` keeps the caller's `fromPatterns` scope, and the
  // message is a `harness`-level event, so a scoped synthesizer read an empty
  // string (#507 W4). User-typed text is trusted — the user is the principal —
  // so reading it past the scope widens nothing the guard fences. Only core
  // authors it, as `harness`; a `user_message` another pattern committed is not
  // the user's and would move both the message and the turn boundaries.
  const userMessage = view
    .unfiltered()
    .fromPattern('harness')
    .ofType('user_message')
    .last(1)
    .get()[0]
  const userContent = userMessage ? (userMessage.data as { content: string }).content : ''

  // Read error state from the view rather than from the data stash, so errors
  // expire with the window instead of being carried forward by hand — but read
  // it through a TURN window, not the bare view. A ViewConfig's pattern scope
  // is not a turn scope: a loop keeps the same patternId every turn and
  // `ctx.events` persist across `continueSession`, so one failed turn had
  // `Synthesize` apologise on turn 2, 3, 4… for work that all succeeded
  // (`general-next.server.ts`'s `response-synth` shows the correct shape —
  // `fromPatterns` + `fromLastNTurns: 1`).
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

  // `memoryRecall`'s block for THIS turn (it clears the key on every exit, so a
  // previous turn's cannot be here). Present only when something was recalled:
  // the second of the two patterns that author a user-visible answer (#419 D13).
  if (typeof data.memoryContext === 'string' && data.memoryContext.trim()) {
    input.memoryContext = data.memoryContext
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
      // Which events are the thread. By default, the last pattern to enter. A
      // caller that NAMED its patterns (`viewConfig.fromPatterns`) has already
      // scoped `view` to them, and that scope is the answer: `fromLastPattern()`
      // would AND a second filter onto it, and under a wrapper whose children
      // run in nested views (`decisionLoop`) the last pattern to enter is the
      // last CHILD — outside the named set — so the read came back empty and
      // the synthesizer silently dropped to `response` mode (#507 S2). The
      // named patterns' records are the thread; the children's internal
      // traces, tagged with their own ids, stay out.
      // `fromLastPattern()` also bounded the read to one execution; a pattern
      // scope is not a turn scope (see `errorView`), so the named read gets the
      // same turn bound the error read has: the caller's window when it gave
      // one, else the current turn. `threadTurns` widens ONLY this read, so a
      // follow-up turn that runs no route still synthesizes from the records an
      // earlier turn committed; the error read above keeps its own window.
      const threadView = scopedToPatterns
        ? view.fromLastNTurns(threadTurnWindow)
        : view.fromLastPattern()
      // A record from an EARLIER turn is kept only when it succeeded. A failed
      // one reads as `{ __error }` with nothing marking it old, so the
      // synthesizer would apologise for it while `hasError` (one turn) is false
      // — SA-H1 through the record channel. This also drops a withheld
      // (marker-only) record once its turn is over.
      const currentTurnIds = scopedToPatterns
        ? new Set(
            view
              .fromLastNTurns(errorTurnWindow)
              .get()
              .map((e) => e.id),
          )
        : undefined
      const toolEvents = threadView.tools().get()
      const actionEvents = threadView.actions().get()
      // The text of a Return-only turn — set below, only when nothing else in
      // the thread reaches the synthesizer.
      let returnOnlyText: string | undefined
      // True when a loop history was built from failed calls alone.
      let failedOnlyHistory = false

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
        // Iterations with at least one successful result. A failed call is a
        // real iteration (the synthesizer's only record of the failure), but it
        // gives the turn nothing to author from (#614).
        const succeeded = new Set<LoopHistory['iterations'][number]>()
        // Iterations authored THIS turn. The thread window can span turns and
        // keeps earlier turns' successful records, but `data.returnText` is the
        // current turn's `Return`: an earlier turn's success must not make this
        // turn's all-failed calls read as supported (#614 review, finding 3).
        const thisTurnIds = new Set(
          view
            .fromLastNTurns(1)
            .get()
            .map((e) => e.id),
        )
        const mine = new Set<LoopHistory['iterations'][number]>()

        for (const event of threadView.get()) {
          if (event.type === 'controller_action') {
            const actionData = event.data as { action: import('../types').ControllerAction }
            unpaired.add(iterations.length)
            iterations.push({
              turn: turn++,
              action: actionData.action,
              result: null,
              timestamp: event.ts,
            })
            if (thisTurnIds.has(event.id)) mine.add(iterations[iterations.length - 1])
            openExpected = 1 + (actionData.action.additional_calls?.length ?? 0)
            openReceived = 0
          } else if (event.type === 'tool_result') {
            const resultData = event.data as ToolResultEventData
            if (currentTurnIds && resultData.success === false && !currentTurnIds.has(event.id)) {
              continue
            }
            const open = iterations.length > 0 ? iterations[iterations.length - 1] : undefined
            if (open && openReceived < openExpected) {
              // Pair with the controller_action that owns this result.
              unpaired.delete(iterations.length - 1)
              openReceived++
              if (resultData.success !== false) succeeded.add(open)
              if (openExpected === 1) {
                // A failed call carries its error in the batch's `__error`
                // shape. Its `result` is null, and the synthesize step reports
                // every iteration as a success, so the bare value read as "the
                // tool succeeded and returned nothing". That was masked while a
                // failed call always ended the loop and the error event carried
                // the message; since the loops continue past a failure (#437
                // slice 1) it is the synthesizer's only record of it.
                open.result =
                  resultData.success === false
                    ? { __error: resultData.error ?? 'Tool call failed' }
                    : resultData.result
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
              const orphan = iterations[iterations.length - 1]
              if (thisTurnIds.has(event.id)) mine.add(orphan)
              if (resultData.success !== false) succeeded.add(orphan)
            }
          }
        }

        // Drop the turns that would reach `Synthesize` as a FABRICATED
        // success: the conversion in the BAML-backed synthesize stamps
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
          // Every call failed: the loop's `Return` is the only content the turn
          // authored, and `loopHistory` alone would render just the error(s)
          // (#614). Carried beside it, never in `response`: a synthesizer that
          // takes `response` over the history would lose the failure instead.
          if (!real.some((it) => mine.has(it) && succeeded.has(it))) failedOnlyHistory = true
          input.loopHistory = {
            iterations: real,
            startTime: toolEvents[0]?.ts ?? Date.now(),
            endTime: Date.now(),
          }
        }
      }

      // That path used to hand the synthesizer NOTHING when the controller
      // answered without calling a tool: the dropped `Return` carried the
      // only content of the turn (its text, in `tool_args`), and no loop
      // writes `data.response`. So a thread with no real iteration keeps the
      // `Return` text the LOOP recorded on exit (`data.returnText`) as the
      // response. It comes from the producer, not from a read of the thread:
      // only `simpleLoop` knows its `Return` ended the loop — an actorCritic
      // `Return` is refused and never reviewed — and `continueSession` clears
      // the key, so a previous turn's text cannot answer this one under a
      // wider thread window. A turn that DID call a tool
      // keeps dropping it, unless every one of its calls failed (#614, below) —
      // there the `Return` is a summary and the tool
      // results are what the synthesizer authors from (#149).
      if (!input.loopHistory) {
        const text = typeof data.returnText === 'string' ? data.returnText.trim() : ''
        if (text) returnOnlyText = text
      } else if (failedOnlyHistory && data.response === undefined) {
        // #614: a turn whose every tool call failed, then a `Return` from
        // context. Unlike a turn with a success, nothing here is a summary of
        // results the synthesizer can read, so the text is the answer.
        const text = typeof data.returnText === 'string' ? data.returnText.trim() : ''
        if (text) input.returnText = text
      }
      input.response = data.response ?? returnOnlyText
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
 * @param config - compactExecution configuration. `synthesize` is REQUIRED:
 *   the composition root supplies the BAML-backed implementation
 *   (`bamlPatterns().synthesize` in the app) — core hosts no default.
 * @returns ConfiguredPattern ready for chain
 *
 * @example
 * // Message mode - just the response string
 * const s1 = compactExecution({ mode: 'message', synthesize })
 *
 * // Response mode - object with data and response
 * const s2 = compactExecution({ mode: 'response', synthesize })
 *
 * // Thread mode - full iteration history
 * const s3 = compactExecution({ mode: 'thread', synthesize })
 *
 * // Custom synthesis function
 * const s4 = compactExecution({
 *   mode: 'response',
 *   synthesize: async (input) => ({ value: `Processed: ${input.response}` })
 * })
 */
export function compactExecution<T extends CompactExecutionData>(
  config: CompactExecutionConfig,
): ConfiguredPattern<T> {
  const { mode, synthesize, skipIfHasResponse = false } = config
  const resolved = resolveConfig('compactExecution', config)
  // `threadTurns` is a public turn bound: 0, a negative, a fraction, NaN or
  // Infinity would make the view slice return the WHOLE history, and without
  // a named-pattern thread read it would do nothing while reading as if it did.
  if (config.threadTurns !== undefined) {
    if (!Number.isInteger(config.threadTurns) || config.threadTurns < 1) {
      throw new Error(
        `compactExecution: threadTurns must be an integer >= 1, got ${String(config.threadTurns)}`,
      )
    }
    if (mode !== 'thread' || !config.viewConfig?.fromPatterns?.length) {
      throw new Error(
        "compactExecution: threadTurns only widens a thread read scoped by viewConfig.fromPatterns; set mode: 'thread' and name the patterns, or remove it",
      )
    }
  }

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
        (resolved.viewConfig?.fromPatterns?.length ?? 0) > 0,
        config.threadTurns ?? resolved.viewConfig?.fromLastNTurns ?? 1,
      )

      // Validate thread mode
      if (mode === 'thread' && !input.loopHistory) {
        input.mode = 'response'
        input.data = scope.data
      }

      // Both paths return the LLMResult envelope now: a custom `synthesize`
      // implementation can carry a call record like the BAML-backed one does
      // (the override used to return a bare string and emit NO llmCall at
      // all — the no-tracking hole this closes), and the BAML-backed
      // implementation creates its own collector internally instead of being
      // handed one. The implementation is REQUIRED config, supplied at the
      // composition root — core hosts no default import.
      const { value: synthesizedResponse, call: llmCall } = await synthesize(input)

      // Track assistant message event with LLM call data. `final: true`
      // distinguishes the compactExecution's user-facing response from router
      // status messages that share the same event type — chat-history
      // replay reads this flag to skip intermediate emits.
      //
      // The record is REDACTED here, before it rides the saved event
      // (review F1): the synthesize prompt renders `memoryRecall`'s
      // `memoryContext` block, so an unredacted `rawInput` on the
      // `assistant_message` event would persist recalled memory text in the
      // conversation blob that `serializeContext` scrubs from `data`. Same
      // redaction as every decide-path record; `variables`/`rawInput`/
      // `rawOutput`/`parsedOutput` drop, cost attribution survives.
      trackEvent(
        scope,
        'assistant_message',
        { content: synthesizedResponse, final: true } as AssistantMessageEventData,
        resolved.trackHistory,
        redactCall(llmCall),
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
      // Redacted like the success path above (review F1): a failed synthesize
      // read the same rendered memory block, and its record rides the `error`
      // event into the same blob.
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
        redactCall(failedLlmCall),
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
