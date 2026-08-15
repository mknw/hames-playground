/**
 * UnifiedContext - Server Only
 *
 * Factory functions for creating and managing UnifiedContext.
 * This is the single source of truth for session state.
 */

import { assertServerOnImport } from './assert.server'
import { emitLive } from './live-event-context.server'
import type {
  UnifiedContext,
  PatternScope,
  ContextEvent,
  EventType,
  CommitStrategy,
  TrackHistory,
  PatternConfig,
  UserMessageEventData,
  LLMCallData,
} from './types'

assertServerOnImport()

// ============================================================================
// ID Generation
// ============================================================================

/** Generate a short unique ID */
export function generateId(prefix = ''): string {
  const id = Math.random().toString(36).substring(2, 8)
  return prefix ? `${prefix}-${id}` : id
}

// ============================================================================
// UnifiedContext Factory
// ============================================================================

/** Create a new UnifiedContext */
export function createContext<T = Record<string, unknown>>(
  input: string,
  initialData?: T,
  sessionId?: string,
): UnifiedContext<T> {
  const now = Date.now()
  const ctx: UnifiedContext<T> = {
    sessionId: sessionId ?? generateId('session'),
    createdAt: now,
    events: [],
    status: 'running',
    data: initialData ?? ({} as T),
    input,
  }

  // Add initial user message event
  ctx.events.push({
    id: generateId('ev'),
    type: 'user_message',
    ts: now,
    patternId: 'harness',
    data: { content: input } as UserMessageEventData,
  })

  return ctx
}

/** Serialize context to JSON string */
export function serializeContext<T>(ctx: UnifiedContext<T>): string {
  return JSON.stringify(ctx)
}

/** Deserialize context from JSON string */
export function deserializeContext<T = Record<string, unknown>>(json: string): UnifiedContext<T> {
  return JSON.parse(json) as UnifiedContext<T>
}

// ============================================================================
// PatternScope Factory
// ============================================================================

/** Create a new PatternScope for pattern execution */
export function createScope<T>(patternId: string, data: T): PatternScope<T> {
  return {
    id: patternId,
    events: [],
    data,
    startTime: Date.now(),
  }
}

// ============================================================================
// Event Helpers
// ============================================================================

/** Create a context event. Step-level token/cost accounting (`metrics`,
 *  computed by the adapters across ALL attempts of the call) is lifted from
 *  the llmCall carrier onto the event itself, making events self-contained
 *  accounting records for any consumer (panel, exports, recordings). */
export function createEvent(
  type: EventType,
  patternId: string,
  data: unknown,
  llmCall?: LLMCallData,
): ContextEvent {
  return {
    id: generateId('ev'),
    type,
    ts: Date.now(),
    patternId,
    data,
    ...(llmCall && { llmCall }),
    ...(llmCall?.metrics && { metrics: llmCall.metrics }),
  }
}

/** Check if an event type should be tracked based on trackHistory config */
export function shouldTrack(type: EventType, trackHistory: TrackHistory): boolean {
  if (typeof trackHistory === 'boolean') {
    return trackHistory
  }
  if (typeof trackHistory === 'string') {
    return trackHistory === type
  }
  if (Array.isArray(trackHistory)) {
    return trackHistory.includes(type)
  }
  return false
}

/** Add event to scope if it should be tracked.
 *  When the current pattern has `liveEvents: true`, the event is also forwarded
 *  to the harness `onEvent` listener immediately via `emitLive()`. */
export function trackEvent(
  scope: PatternScope<unknown>,
  type: EventType,
  data: unknown,
  trackHistory: TrackHistory,
  llmCall?: LLMCallData,
): void {
  if (!shouldTrack(type, trackHistory)) return
  const event = createEvent(type, scope.id, data, llmCall)
  scope.events.push(event)
  emitLive(event)
}

// ============================================================================
// Commit Strategies
// ============================================================================

/** Event types that are always committed regardless of strategy.
 *  Includes 'error' because errors are informational (not partial results)
 *  and must be visible to downstream patterns via EventView. */
const ALWAYS_COMMIT_TYPES: Set<EventType> = new Set(['pattern_enter', 'pattern_exit', 'error'])

/** Commit scope events to context based on strategy.
 *  Preserves original event order — lifecycle events (pattern_enter/exit) are
 *  always committed regardless of strategy, interleaved with content events
 *  in their original position. */
export function commitEvents<T>(
  ctx: UnifiedContext<T>,
  scope: PatternScope<unknown>,
  strategy: CommitStrategy,
): void {
  switch (strategy) {
    case 'always':
      // All events in original order
      ctx.events.push(...scope.events)
      break
    case 'on-success':
      if (ctx.status !== 'error') {
        ctx.events.push(...scope.events)
      } else {
        // Only lifecycle events
        ctx.events.push(...scope.events.filter((e) => ALWAYS_COMMIT_TYPES.has(e.type)))
      }
      break
    case 'last': {
      // Lifecycle events + last content event, preserving order
      const lastContentIdx = findLastIndex(scope.events, (e) => !ALWAYS_COMMIT_TYPES.has(e.type))
      for (let i = 0; i < scope.events.length; i++) {
        const e = scope.events[i]
        if (ALWAYS_COMMIT_TYPES.has(e.type) || i === lastContentIdx) {
          ctx.events.push(e)
        }
      }
      break
    }
    case 'never':
      // Only lifecycle events
      ctx.events.push(...scope.events.filter((e) => ALWAYS_COMMIT_TYPES.has(e.type)))
      break
  }
}

function findLastIndex<T>(arr: T[], pred: (item: T) => boolean): number {
  for (let i = arr.length - 1; i >= 0; i--) {
    if (pred(arr[i])) return i
  }
  return -1
}

// ============================================================================
// Pattern Lifecycle Helpers
// ============================================================================

/** Add pattern_enter event to context.
 *  Optional `meta` is merged into the event's data (e.g. `{ maxTurns }`)
 *  so downstream consumers (UI progress bar) can compute progress. */
export function enterPattern<T>(
  ctx: UnifiedContext<T>,
  patternId: string,
  patternName: string,
  meta?: Record<string, unknown>,
): void {
  const event: ContextEvent = {
    id: generateId('ev'),
    type: 'pattern_enter',
    ts: Date.now(),
    patternId,
    data: { pattern: patternName, ...(meta ?? {}) },
  }
  ctx.events.push(event)
  emitLive(event)
}

/** Add pattern_exit event to context */
export function exitPattern<T>(ctx: UnifiedContext<T>, patternId: string): void {
  const event: ContextEvent = {
    id: generateId('ev'),
    type: 'pattern_exit',
    ts: Date.now(),
    patternId,
    data: { status: ctx.status, error: ctx.error },
  }
  ctx.events.push(event)
  emitLive(event)
}

// ============================================================================
// Post-Hoc Event Mutation
// ============================================================================

/**
 * Enrich a committed tool_result event with summary or visibility state.
 * Mutates the event in-place — caller must re-serialize the context to persist.
 */
export function enrichToolResult<T>(
  ctx: UnifiedContext<T>,
  eventId: string,
  patch: { summary?: string; hidden?: boolean; archived?: boolean },
): boolean {
  const event = ctx.events.find((e) => e.id === eventId && e.type === 'tool_result')
  if (!event) return false
  Object.assign(event.data as object, patch)
  return true
}

// ============================================================================
// Context Status Helpers
// ============================================================================

/** Set context status to error */
export function setError<T>(ctx: UnifiedContext<T>, error: string, patternId = 'unknown'): void {
  ctx.status = 'error'
  ctx.error = error
  ctx.events.push({
    id: generateId('ev'),
    type: 'error',
    ts: Date.now(),
    patternId,
    data: { error },
  })
}

/** Set context status to done */
export function setDone<T>(ctx: UnifiedContext<T>): void {
  ctx.status = 'done'
}

/** Set context status to paused */
export function setPaused<T>(ctx: UnifiedContext<T>): void {
  ctx.status = 'paused'
}

// ============================================================================
// Default Config Helpers
// ============================================================================

import { DEFAULT_TRACK_HISTORY, DEFAULT_COMMIT_STRATEGY, DEFAULT_ERROR_SEVERITY } from './types'

/** Get default trackHistory for a pattern type */
export function getDefaultTrackHistory(patternType: string): TrackHistory {
  return DEFAULT_TRACK_HISTORY[patternType] ?? false
}

/** Get default commitStrategy for a pattern type */
export function getDefaultCommitStrategy(patternType: string): CommitStrategy {
  return DEFAULT_COMMIT_STRATEGY[patternType] ?? 'always'
}

/** Merge pattern config with defaults.
 *  Spreads the caller's config first so unrecognised fields (e.g. pattern-specific
 *  options like `maxTurns`, plus opt-in flags like `liveEvents`) are preserved
 *  after defaults are applied for the well-known base fields. */
export function resolveConfig(
  patternType: string,
  config?: PatternConfig,
): Required<
  Pick<PatternConfig, 'patternId' | 'commitStrategy' | 'trackHistory' | 'errorSeverity'>
> &
  PatternConfig {
  return {
    ...config,
    patternId: config?.patternId ?? generateId(patternType),
    commitStrategy: config?.commitStrategy ?? getDefaultCommitStrategy(patternType),
    trackHistory: config?.trackHistory ?? getDefaultTrackHistory(patternType),
    errorSeverity: config?.errorSeverity ?? DEFAULT_ERROR_SEVERITY[patternType] ?? 'irrecoverable',
    viewConfig: config?.viewConfig,
  }
}
