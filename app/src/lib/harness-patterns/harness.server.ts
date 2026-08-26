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
} from './types'
import {
  createContext,
  serializeContext,
  deserializeContext,
  setError as setCtxError,
  generateId,
} from './context.server'
import { runWithLiveListener } from './live-event-context.server'
import { getRequestSettings } from '../settings-context.server'

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
  const s = getRequestSettings()
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
 *   simpleLoop(b.Neo4jController, tools.neo4j, { patternId: 'neo4j' }),
 *   compactExecution({ mode: 'response', patternId: 'compact-execution' })
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
) => Promise<HarnessResultScoped<T>> {
  return async (input, sessionId, initialData, onEvent) => {
    const startTime = Date.now()

    // Create UnifiedContext
    const ctx = createContext<T>(input, initialData as T, sessionId)

    // Project total chain turns upfront so progress UIs can seed themselves
    // before the first pattern_enter arrives.
    stampChainEstimate(ctx, patterns)

    // Emit the initial user_message live so consumers (e.g. SSE listeners)
    // see `chainTurnEstimate` before any pattern runs.
    const initial = ctx.events[ctx.events.length - 1]
    if (initial?.type === 'user_message' && onEvent) onEvent(initial)

    // Where this turn's events start. A fresh context holds only the
    // user_message, but `settleTurn` takes the boundary from all three entry
    // points for the same reason — see its docstring.
    const eventsBefore = ctx.events.length

    try {
      // Execute patterns using chain inside a live-event frame so that any
      // pattern with `liveEvents: true` streams events to `onEvent` as they
      // happen, not at commit time.
      await runWithLiveListener(onEvent, () => runChain(ctx, patterns, onEvent))

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
  }
}

/**
 * Resume a paused harness from serialized context.
 *
 * @param serializedContext - The serialized UnifiedContext JSON
 * @param patterns - The original patterns
 * @param approved - Whether the action was approved
 * @returns The resumed result with updated context
 */
export async function resumeHarness<
  T extends HarnessData & Record<string, unknown> & { approved?: boolean },
>(
  serializedContext: string,
  patterns: ConfiguredPattern<T>[],
  approved: boolean,
  onEvent?: (event: ContextEvent) => void,
): Promise<HarnessResultScoped<T>> {
  // Restore context from serialized state
  const ctx = deserializeContext<T>(serializedContext)

  if (ctx.status !== 'paused') {
    throw new Error('Cannot resume: context is not paused')
  }

  const startTime = Date.now()

  // Set approval state and resume
  ctx.status = 'running'
  ctx.data = { ...ctx.data, approved }

  // Add approval response event
  ctx.events.push({
    id: generateId('ev'),
    type: 'approval_response',
    ts: Date.now(),
    patternId: 'harness',
    data: { approved },
  })

  // Where THIS resume's events start — the restored context already holds
  // every previous turn's, including any error they recorded.
  const eventsBefore = ctx.events.length

  try {
    // Re-run patterns from the restored (now-running) context. The `approved`
    // flag rides on ctx.data for a resume-aware gating pattern to consume.
    await runWithLiveListener(onEvent, () => runChain(ctx, patterns, onEvent))

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
): Promise<HarnessResultScoped<T>> {
  // Restore context from serialized state
  const ctx = deserializeContext<T>(serializedContext)

  const startTime = Date.now()

  // Update input and reset status for new turn
  ctx.input = newInput
  ctx.status = 'running'
  ctx.error = undefined

  // Clear stale fields from previous turn — patterns must produce fresh values.
  // Errors are event-scoped (read via EventView), and response must be
  // re-generated by the compactExecution to prevent duplicate messages.
  if (ctx.data && typeof ctx.data === 'object') {
    delete (ctx.data as Record<string, unknown>).hasError
    delete (ctx.data as Record<string, unknown>).errorMessage
    delete (ctx.data as Record<string, unknown>).response
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
  if (continuedMsg?.type === 'user_message' && onEvent) onEvent(continuedMsg)

  // Where THIS turn's events start — the restored context already holds every
  // previous turn's, including any error they recorded.
  const eventsBefore = ctx.events.length

  try {
    // Execute patterns
    await runWithLiveListener(onEvent, () => runChain(ctx, patterns, onEvent))

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
}
