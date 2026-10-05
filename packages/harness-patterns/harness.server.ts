/**
 * Harness
 *
 * Composes patterns into a callable agent.
 * Uses UnifiedContext for session persistence and event tracking.
 */

import { assertServerOnImport } from './assert.server'
import { runChain } from './patterns/chain.server'
import type {
  CtxStatus,
  ContextEvent,
  HarnessResult,
  UnifiedContext,
  ConfiguredPattern,
  AssistantMessageEventData,
  UserMessageEventData,
  ErrorEventData,
  TurnEstimateSettings,
  HitlAnswers,
  HitlRequestEventData,
} from './types'
import {
  createContext,
  serializeContext,
  deserializeContext,
  setError as setCtxError,
  generateId,
} from './context.server'
import { checkResume, recordAnswers, supersedeHitl } from './hitl.server'
import { withRunFrame, currentRunFrame, activeRunFrame, type RunFrame } from './run-frame.server'
import { runtimeConfig } from './runtime-config.server'

assertServerOnImport()

/**
 * Sum each top-level pattern's `estimateTurns` projection. Patterns that
 * don't implement `estimateTurns` contribute 1. Used to seed UI progress
 * indicators with an upfront chain-wide projection.
 */
function estimateChainTurns<T>(
  patterns: ConfiguredPattern<T>[],
  settings: TurnEstimateSettings,
): number {
  return patterns.reduce((sum, p) => sum + (p.estimateTurns?.(settings) ?? 1), 0)
}

function turnEstimateSettings(): TurnEstimateSettings {
  const s = runtimeConfig()
  return { maxToolTurns: s.maxToolTurns, maxRetries: s.maxRetries }
}

/** Stamp `chainTurnEstimate` on the most recent user_message event in-place. */
function stampChainEstimate<T>(ctx: UnifiedContext<T>, patterns: ConfiguredPattern<T>[]): void {
  let userMsg: ContextEvent | undefined
  for (let i = ctx.events.length - 1; i >= 0; i--) {
    if (ctx.events[i].type === 'user_message') {
      userMsg = ctx.events[i]
      break
    }
  }
  if (!userMsg) return
  const data = userMsg.data as UserMessageEventData
  data.chainTurnEstimate = estimateChainTurns(patterns, turnEstimateSettings())
}

/**
 * Decide how a turn ENDED, from what the chain actually produced.
 *
 * Shared by all three entry points below, because the answer must not depend
 * on which one ran — and it used to: each carried its own copy of this
 * epilogue and all three read "the chain returned without throwing" as
 * success. `runChain` almost never throws (every pattern catches internally
 * and records an `error` event instead), so a turn whose LLM calls ALL failed
 * came back `status: 'running'` with `response: ''`, which every consumer
 * reads as a completed turn: the SSE route sends `event: done`, the client
 * paints no assistant bubble and marks the run `done` (a green completion
 * mark in the sidebar), and `extractStatusFromContext` maps 'running' → 'done'
 * so the persisted row's badge agrees. Measured live on 2026-08-26 against the
 * self-hosted deployment: a `BamlTimeoutError` on `LoopController` followed by
 * a `504 inference request was canceled` on `Synthesize` was recorded as a
 * successful, empty conversation.
 *
 * The predicate is deliberately the CONJUNCTION "nothing to show AND something
 * went wrong", not either half:
 *
 * - An error with a response is not a failed turn. A loop that exhausts
 *   `maxTurns` records a recoverable error and the synthesizer still answers
 *   from the partial results — that is the designed behaviour (#83), and
 *   flipping it to `error` would report every partial answer as a failure.
 * - No response and no error is not a failure either: a chain with no
 *   synthesizer, or a router that resolved to a direct response, legitimately
 *   leaves `data.response` unset without anything having gone wrong.
 * - `paused` is excluded because an approval gate ends a turn with no response
 *   ON PURPOSE, and that is the one status a caller must be able to resume.
 *
 * Severity is not consulted. `errorSeverity` classifies whether a PATTERN can
 * self-heal, and the controller timeout above is classified `recoverable` even
 * though nothing downstream recovered from it; what makes a turn failed is that
 * it reached the user with nothing, whatever the pattern thought.
 *
 * `eventsBefore` is the turn boundary: `continueSession` and `resumeHarness`
 * run against a context that already holds every previous turn's events, so a
 * failure two turns ago must not condemn this one.
 */
function settleTurn<T extends HarnessData & Record<string, unknown>>(
  ctx: UnifiedContext<T>,
  eventsBefore: number,
): { response: string; status: CtxStatus } {
  const response = ctx.data.response ?? ''
  const status = ctx.status as CtxStatus // chain may mutate ctx.status

  if (status === 'done' && response) {
    ctx.events.push({
      id: generateId('ev'),
      type: 'assistant_message',
      ts: Date.now(),
      patternId: 'harness',
      data: { content: response } as AssistantMessageEventData,
    })
  }

  if (response || status === 'error' || status === 'paused') return { response, status }

  const failure = lastTurnError(ctx, eventsBefore)
  if (!failure) return { response, status }

  // Deliberately NOT `setError()`: that pushes a second `error` event, and the
  // pattern that failed already emitted one carrying the LLM call detail the
  // observability drill-down needs. A duplicate would double the error bubble
  // in the transcript and in every replay of it.
  ctx.status = 'error'
  ctx.error = failure
  return { response: `Error: ${failure}`, status: 'error' }
}

/** The message of the last `error` event recorded during this turn, or
 *  undefined when the turn recorded none. */
function lastTurnError<T>(ctx: UnifiedContext<T>, eventsBefore: number): string | undefined {
  for (let i = ctx.events.length - 1; i >= eventsBefore; i--) {
    const event = ctx.events[i]
    if (event.type !== 'error') continue
    const message = (event.data as ErrorEventData | undefined)?.error
    if (message) return message
  }
  return undefined
}

export interface HarnessData {
  response?: string
}

/**
 * THE THREE ENTRY POINTS OPEN THE RUN FRAME (rulings Q17 and D5, issue #374).
 *
 * Everything a run needs to be ambient — the injection guard, the scoped tool
 * transports, the host's budgets, the live listener and the inference tier —
 * lives in one frame opened here, once, rather than in five stores opened by
 * five different callers at three different granularities. A package consumer
 * calling `harness(...patterns)(input)` gets all five without learning that any
 * of them exists; `runChain` refuses if one of them ever doesn't.
 *
 * `frame` is how a host supplies the slots. The live listener is the exception
 * that is NOT in it: `onEvent` is the ergonomic parameter every caller already
 * passes, so it is folded into the frame's `live` slot here. A host that opens
 * its OWN frame (to keep the tier across work it starts but does not await, as
 * this repo's app does) puts the listener in that frame and passes neither
 * `frame` nor `onEvent` — because a nested entry joins the open frame and is
 * refused if it brings slots of its own, which is what stops an inner call
 * replacing the enclosing run's guard.
 */
function enterRun<T>(
  frame: RunFrame | undefined,
  onEvent: ((event: ContextEvent) => void) | undefined,
  fn: (listener: ((event: ContextEvent) => void) | undefined) => Promise<T>,
): Promise<T> {
  // Joining an already-open frame: bring nothing, and take the listener the
  // host put there. Supplying one here would be refused, correctly.
  if (currentRunFrame() && !frame && !onEvent) {
    return withRunFrame({}, () => fn(currentRunFrame()?.live?.listener))
  }
  const supplied: RunFrame = { ...(frame ?? {}), ...(onEvent ? { live: onEvent } : {}) }
  // The hitl slot's default, applied HERE and only when this call OPENS the
  // frame (#433, F7): a package consumer calling `harness(...)(input)` gets a
  // gate that asks, with nothing to implement. A JOINED frame keeps whatever
  // its host put there — a host that opens its own frame supplies the slot
  // around its main run, so its sidecars never get one by inheritance.
  if (!currentRunFrame() && !supplied.hitl) supplied.hitl = { attended: true }
  return withRunFrame(supplied, () => fn(onEvent ?? currentRunFrame()?.live?.listener))
}

/** Result from harness including serialized context */
export interface HarnessResultScoped<T> extends HarnessResult<T> {
  /** Full UnifiedContext (can be serialized for session persistence) */
  context: UnifiedContext<T>
  /** Serialized context as JSON string */
  serialized: string
}

/**
 * Compose ConfiguredPatterns into a callable agent.
 *
 * @param patterns - ConfiguredPatterns to execute in sequence
 * @returns A function that processes input and returns full context
 *
 * @example
 * const agent = harness(
 *   simpleLoop<SimpleLoopData & Record<string, unknown>>(
 *     createLoopControllerAdapter(),
 *     tools.neo4j,
 *     { patternId: 'neo4j' }
 *   ),
 *   compactExecution({
 *     mode: 'response',
 *     patternId: 'compact-execution',
 *     synthesize: baml.synthesize,
 *   })
 * )
 *
 * const result = await agent('Show me all nodes')
 * // result.context contains full session state
 * // result.serialized can be stored for session persistence
 */
export function harness<T extends HarnessData & Record<string, unknown>>(
  ...patterns: ConfiguredPattern<T>[]
): (
  input: string,
  sessionId?: string,
  initialData?: Partial<T>,
  onEvent?: (event: ContextEvent) => void,
  frame?: RunFrame,
) => Promise<HarnessResultScoped<T>> {
  return async (input, sessionId, initialData, onEvent, frame) =>
    enterRun(frame, onEvent, async (listener) => {
      const startTime = Date.now()

      // Create UnifiedContext
      const ctx = createContext<T>(input, initialData as T, sessionId)

      // Project total chain turns upfront so progress UIs can seed themselves
      // before the first pattern_enter arrives. Inside the frame, because the
      // projection reads the host's budgets through `runtimeConfig()`.
      stampChainEstimate(ctx, patterns)

      // Emit the initial user_message live so consumers (e.g. SSE listeners)
      // see `chainTurnEstimate` before any pattern runs.
      const initial = ctx.events[ctx.events.length - 1]
      if (initial?.type === 'user_message' && listener) listener(initial)

      // Where this turn's events start. A fresh context holds only the
      // user_message, but `settleTurn` takes the boundary from all three entry
      // points for the same reason — see its docstring.
      const eventsBefore = ctx.events.length

      try {
        // Execute patterns using chain inside the run frame, so that any pattern
        // with `liveEvents: true` streams events to the listener as they happen,
        // not at commit time.
        await runChain(ctx, patterns, listener)

        // How this turn ended — one shared decision, see `settleTurn`.
        const settled = settleTurn(ctx, eventsBefore)

        return {
          response: settled.response,
          data: ctx.data,
          status: settled.status,
          duration_ms: Date.now() - startTime,
          context: ctx,
          serialized: serializeContext(ctx),
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        setCtxError(ctx, msg, 'harness')

        return {
          response: `Error: ${msg}`,
          data: ctx.data,
          status: 'error' as CtxStatus,
          duration_ms: Date.now() - startTime,
          context: ctx,
          serialized: serializeContext(ctx),
        }
      }
    })
}

/**
 * How a host resumes a paused run (#433, F4). Nothing here comes from the
 * person's client: `principal` is stamped by the host from its own session,
 * and `resolve` is the host's own side effect.
 */
export interface ResumeOptions {
  /** Who answered — the host's session identity, recorded on each
   *  `hitl_response`. Never taken from a client body. */
  readonly principal?: string
  /**
   * The host's side effect for one answer (store the sanitized copy, drop the
   * quarantine, …). Called once per answer, in the order the run raised the
   * requests, AFTER every check has passed — so a refused resume runs none —
   * and inside the run frame, so a model call in it takes the run's tier. What
   * it returns is recorded as the response's `resolution` and, sanitized, is
   * what the held result becomes.
   *
   * It MUST be idempotent per `requestId` [Δ4]. When a later `resolve` throws,
   * NOTHING is recorded and the resume fails; the blob is still paused, and a
   * retry calls every `resolve` again — including the ones that already ran.
   * Key its effect on `request.requestId` (provenance derives its stash id
   * from it) and a retry never repeats it.
   */
  readonly resolve?: (
    request: HitlRequestEventData,
    answer: { readonly choice: string; readonly flags: Readonly<Record<string, boolean>> },
  ) => Promise<unknown>
  readonly onEvent?: (event: ContextEvent) => void
  readonly frame?: RunFrame
}

/**
 * Resume a paused run with the answers to the requests it waits on (#433 S3).
 *
 * `answers` maps each waiting `requestId` to a choice — a bare option id, or
 * `{ choice, flags }`. An answer resumes ONLY the pause it was issued for (P1):
 * it must name a request this run is waiting on, not expired, raised on the
 * tier this resume runs on, with an available option of THAT request; every
 * waiting request must be answered at once; and the agent's top-level chain
 * must be the one the run paused in. Any other answer throws a
 * `HitlAnswerError` before anything is recorded and before `resolve` runs, so
 * the blob is untouched. Once accepted, an answer is recorded and its request
 * is no longer waiting, so presenting it again is refused.
 *
 * Then, in order: `opts.resolve` per answer; one `hitl_response` per answer,
 * `by: 'person'`, carrying `opts.principal` and what `resolve` returned; every
 * held tool result substituted with its sanitized outcome. If a chosen option
 * stops the run, it ends `done` with nothing re-entered; otherwise the paused
 * top-level pattern runs again from its start, and a gate it reaches replays
 * its answer. The run may pause again at a new gate.
 *
 * Single use against a concurrent resume of the SAME blob is the host's: save
 * the result only if the stored blob is still the version you loaded (P1d).
 *
 * @param serializedContext - The paused context, as the HOST stored it (P1a)
 * @param patterns - The agent's top-level patterns, unchanged since the pause
 * @param answers - `{ [requestId]: choice | { choice, flags } }`
 * @param opts - `principal`, `resolve`, and the usual `onEvent` / `frame`
 */
export async function resumeHarness<T extends HarnessData & Record<string, unknown>>(
  serializedContext: string,
  patterns: ConfiguredPattern<T>[],
  answers: HitlAnswers,
  opts: ResumeOptions = {},
): Promise<HarnessResultScoped<T>> {
  return enterRun(opts.frame, opts.onEvent, async (listener) => {
    const ctx = deserializeContext<T>(serializedContext)

    // Steps 1–6 only CHECK. A refusal throws before anything below runs.
    const { accepted, startAt } = checkResume(ctx, answers, {
      names: patterns.map((p) => p.name),
      tier: activeRunFrame().inference?.tier,
      now: Date.now(),
    })

    const startTime = Date.now()

    // 7. The host's side effects, one per answer, inside the frame and after
    //    every check [F4]. A throw fails the resume with nothing recorded.
    const resolutions: unknown[] = []
    for (const { request, answer } of accepted) {
      resolutions.push(opts.resolve ? await opts.resolve(request, answer) : undefined)
    }

    // 8–9. The decisions, and the held results they release.
    recordAnswers(ctx, accepted, resolutions, opts.principal)

    // Legacy-blob scrub, until 1.0 (#433 F9): a 0.1.x `resumeHarness(…,
    // approved)` wrote `approved` onto `ctx.data`, and a gate written for it
    // would read a stale one as a decision. Core no longer writes it.
    if (ctx.data && typeof ctx.data === 'object') {
      delete (ctx.data as Record<string, unknown>).approved
    }

    // Where THIS resume's events start — the restored context already holds
    // every previous turn's, including any error they recorded.
    const eventsBefore = ctx.events.length

    // 10. A choice that stops the run stops it: nothing is re-entered.
    const stop = accepted.find((a) => a.option.stopsRun)
    if (stop) {
      ctx.status = 'done'
      ctx.data = { ...ctx.data, response: `Stopped at your request (${stop.request.kind}).` }
      const settled = settleTurn(ctx, eventsBefore)
      return {
        response: settled.response,
        data: ctx.data,
        status: settled.status,
        duration_ms: Date.now() - startTime,
        context: ctx,
        serialized: serializeContext(ctx),
      }
    }

    ctx.status = 'running'

    try {
      // 11. Re-enter the paused top-level pattern; the ones before it already
      //     ran, and their events and data are in the context.
      await runChain(ctx, patterns, listener, { startAt })

      // How this turn ended — one shared decision, see `settleTurn`.
      const settled = settleTurn(ctx, eventsBefore)

      return {
        response: settled.response,
        data: ctx.data,
        status: settled.status,
        duration_ms: Date.now() - startTime,
        context: ctx,
        serialized: serializeContext(ctx),
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      setCtxError(ctx, msg, 'harness')

      return {
        response: `Error: ${msg}`,
        data: ctx.data,
        status: 'error' as CtxStatus,
        duration_ms: Date.now() - startTime,
        context: ctx,
        serialized: serializeContext(ctx),
      }
    }
  })
}

/**
 * Continue a session from serialized context with new input.
 *
 * @param serializedContext - The serialized UnifiedContext JSON from previous session
 * @param patterns - The patterns to execute
 * @param newInput - New user input for this turn
 * @returns The result with updated context
 */
export async function continueSession<T extends HarnessData & Record<string, unknown>>(
  serializedContext: string,
  patterns: ConfiguredPattern<T>[],
  newInput: string,
  onEvent?: (event: ContextEvent) => void,
  frame?: RunFrame,
): Promise<HarnessResultScoped<T>> {
  return enterRun(frame, onEvent, async (listener) => {
    // Restore context from serialized state
    const ctx = deserializeContext<T>(serializedContext)

    const startTime = Date.now()

    // A new message SUPERSEDES whatever the last run still waits on (#433,
    // D11): `{ choice: null, by: 'superseded' }` for each, and its held
    // results say nothing was kept. Before the reset and before the new
    // user_message, so the closing events belong to the run they close.
    supersedeHitl(ctx)

    // Update input and reset status for new turn
    ctx.input = newInput
    ctx.status = 'running'
    ctx.error = undefined

    // Clear stale fields from previous turn — patterns must produce fresh values.
    // Errors are event-scoped (read via EventView), and response must be
    // re-generated by the compactExecution to prevent duplicate messages.
    // `approved` is the legacy-blob scrub, kept until 1.0 (#433 F9): core no
    // longer writes it, but a 0.1.x blob may hold one, and leaving it would
    // hand every later turn's gate a decision the person made about a
    // different action — fail-open, and silent (#456 c′).
    if (ctx.data && typeof ctx.data === 'object') {
      delete (ctx.data as Record<string, unknown>).hasError
      delete (ctx.data as Record<string, unknown>).errorMessage
      delete (ctx.data as Record<string, unknown>).response
      delete (ctx.data as Record<string, unknown>).approved
    }

    // Add new user message event
    ctx.events.push({
      id: generateId('ev'),
      type: 'user_message',
      ts: Date.now(),
      patternId: 'harness',
      data: { content: newInput },
    })

    // Re-project chain turns for this turn — settings or pattern selection may
    // have changed between turns.
    stampChainEstimate(ctx, patterns)

    // Emit the new user_message live so consumers see the fresh estimate.
    const continuedMsg = ctx.events[ctx.events.length - 1]
    if (continuedMsg?.type === 'user_message' && listener) listener(continuedMsg)

    // Where THIS turn's events start — the restored context already holds every
    // previous turn's, including any error they recorded.
    const eventsBefore = ctx.events.length

    try {
      // Execute patterns
      await runChain(ctx, patterns, listener)

      // How this turn ended — one shared decision, see `settleTurn`.
      const settled = settleTurn(ctx, eventsBefore)

      return {
        response: settled.response,
        data: ctx.data,
        status: settled.status,
        duration_ms: Date.now() - startTime,
        context: ctx,
        serialized: serializeContext(ctx),
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      setCtxError(ctx, msg, 'harness')

      return {
        response: `Error: ${msg}`,
        data: ctx.data,
        status: 'error' as CtxStatus,
        duration_ms: Date.now() - startTime,
        context: ctx,
        serialized: serializeContext(ctx),
      }
    }
  })
}
