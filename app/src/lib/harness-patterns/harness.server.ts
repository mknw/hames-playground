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
  TurnEstimateSettings
} from './types'
import {
  createContext,
  serializeContext,
  deserializeContext,
  setError as setCtxError,
  generateId
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
  settings: TurnEstimateSettings
): number {
  return patterns.reduce(
    (sum, p) => sum + (p.estimateTurns?.(settings) ?? 1),
    0
  )
}

function turnEstimateSettings(): TurnEstimateSettings {
  const s = getRequestSettings()
  return { maxToolTurns: s.maxToolTurns, maxRetries: s.maxRetries }
}

/** Stamp `chainTurnEstimate` on the most recent user_message event in-place. */
function stampChainEstimate<T>(
  ctx: UnifiedContext<T>,
  patterns: ConfiguredPattern<T>[]
): void {
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
 *   synthesizer({ mode: 'response', patternId: 'synth' })
 * )
 *
 * const result = await agent('Show me all nodes')
 * // result.context contains full session state
 * // result.serialized can be stored for session persistence
 */
export function harness<T extends HarnessData & Record<string, unknown>>(
  ...patterns: ConfiguredPattern<T>[]
): (input: string, sessionId?: string, initialData?: Partial<T>, onEvent?: (event: ContextEvent) => void) => Promise<HarnessResultScoped<T>> {
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

    try {
      // Execute patterns using chain inside a live-event frame so that any
      // pattern with `liveEvents: true` streams events to `onEvent` as they
      // happen, not at commit time.
      await runWithLiveListener(onEvent, () => runChain(ctx, patterns, onEvent))

      // Extract response from final data
      const response = ctx.data.response ?? ''

      // Add assistant message event if we have a response
      if (ctx.status === 'done' && response) {
        ctx.events.push({
          id: generateId('ev'),
          type: 'assistant_message',
          ts: Date.now(),
          patternId: 'harness',
          data: { content: response } as AssistantMessageEventData
        })
      }

      return {
        response,
        data: ctx.data,
        status: ctx.status,
        duration_ms: Date.now() - startTime,
        context: ctx,
        serialized: serializeContext(ctx)
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
        serialized: serializeContext(ctx)
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
export async function resumeHarness<T extends HarnessData & Record<string, unknown> & { approved?: boolean }>(
  serializedContext: string,
  patterns: ConfiguredPattern<T>[],
  approved: boolean,
  onEvent?: (event: ContextEvent) => void
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
    data: { approved }
  })

  try {
    // Re-run patterns from the restored (now-running) context. The `approved`
    // flag rides on ctx.data for a resume-aware gating pattern to consume.
    await runWithLiveListener(onEvent, () => runChain(ctx, patterns, onEvent))

    const response = ctx.data.response ?? ''
    const finalStatus = ctx.status as CtxStatus // chain may mutate ctx.status

    if (finalStatus === 'done' && response) {
      ctx.events.push({
        type: 'assistant_message',
        ts: Date.now(),
        patternId: 'harness',
        data: { content: response } as AssistantMessageEventData
      })
    }

    return {
      response,
      data: ctx.data,
      status: finalStatus,
      duration_ms: Date.now() - startTime,
      context: ctx,
      serialized: serializeContext(ctx)
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
      serialized: serializeContext(ctx)
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
  onEvent?: (event: ContextEvent) => void
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
  // re-generated by the synthesizer to prevent duplicate messages.
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
    data: { content: newInput }
  })

  // Re-project chain turns for this turn — settings or pattern selection may
  // have changed between turns.
  stampChainEstimate(ctx, patterns)

  // Emit the new user_message live so consumers see the fresh estimate.
  const continuedMsg = ctx.events[ctx.events.length - 1]
  if (continuedMsg?.type === 'user_message' && onEvent) onEvent(continuedMsg)

  try {
    // Execute patterns
    await runWithLiveListener(onEvent, () => runChain(ctx, patterns, onEvent))

    const response = ctx.data.response ?? ''
    const finalStatus = ctx.status as CtxStatus // chain may mutate ctx.status

    if (finalStatus === 'done' && response) {
      ctx.events.push({
        type: 'assistant_message',
        ts: Date.now(),
        patternId: 'harness',
        data: { content: response } as AssistantMessageEventData
      })
    }

    return {
      response,
      data: ctx.data,
      status: finalStatus,
      duration_ms: Date.now() - startTime,
      context: ctx,
      serialized: serializeContext(ctx)
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
      serialized: serializeContext(ctx)
    }
  }
}
