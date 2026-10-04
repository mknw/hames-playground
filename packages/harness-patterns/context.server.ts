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
  HitlRequestEventData,
  HitlResponseEventData,
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
 *  accounting records for any consumer (panel, exports, recordings).
 *
 *  Throws for `hitl_request` / `hitl_response`: only core writes those. */
export function createEvent(
  type: EventType,
  patternId: string,
  data: unknown,
  llmCall?: LLMCallData,
): ContextEvent {
  refuseHitl(type, 'createEvent')
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
 *  to the harness `onEvent` listener immediately via `emitLive()`.
 *
 *  Throws for `hitl_request` / `hitl_response` WHATEVER `trackHistory` says:
 *  only core writes those, and a refusal that depended on configuration would
 *  pass in one agent and throw in the next. */
export function trackEvent(
  scope: PatternScope<unknown>,
  type: EventType,
  data: unknown,
  trackHistory: TrackHistory,
  llmCall?: LLMCallData,
): void {
  refuseHitl(type, 'trackEvent')
  if (!shouldTrack(type, trackHistory)) return
  const event = createEvent(type, scope.id, data, llmCall)
  scope.events.push(event)
  emitLive(event)
}

// ============================================================================
// HITL events: only core writes them (#433, F6)
// ============================================================================
//
// A `hitl_response` is an answer, and an answer resumes a run past a decision
// a person was asked to make. So the paths a pattern author is TOLD to use —
// `createEvent` / `trackEvent`, and pushing onto `scope.events` (GUIDE §1),
// which `commitEvents` and `chain()` then merge — must not be able to write
// one. The first two refuse both types outright. The second two cannot refuse
// what is already in an array, so they keep only the HITL events core itself
// created: each is minted into the module-private set below, and anything
// else of those two types is dropped, with a warning.
//
// Identity, not content, is what the set records, and it is per process: a
// context that went through `serializeContext` comes back as plain objects.
// That is deliberate. `readHitl` never consults the set — events already in a
// stored blob are not re-filtered, because the blob is server-held state the
// host owns (spec #433 §2, P1a). The set guards the in-run write paths only.

const HITL_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'hitl_request',
  'hitl_response',
])

/** Every HITL event core created in this process. Module-private: the only
 *  way in is {@link mintHitlEvent}. */
const mintedHitlEvents = new WeakSet<ContextEvent>()

function refuseHitl(type: EventType, via: string): void {
  if (HITL_EVENT_TYPES.has(type)) {
    throw new Error(`${via} cannot write a ${type} event: only core writes HITL events (#433).`)
  }
}

/**
 * Create a HITL event and record it as core's own.
 *
 * @internal Core's HITL writers only. It is not in the package barrel: a
 * pattern that called it would be forging the record a resume is checked
 * against, which is exactly what {@link createEvent}'s refusal stops.
 */
export function mintHitlEvent(
  type: 'hitl_request',
  patternId: string,
  data: HitlRequestEventData,
): ContextEvent
export function mintHitlEvent(
  type: 'hitl_response',
  patternId: string,
  data: HitlResponseEventData,
): ContextEvent
export function mintHitlEvent(
  type: 'hitl_request' | 'hitl_response',
  patternId: string,
  data: HitlRequestEventData | HitlResponseEventData,
): ContextEvent {
  const event: ContextEvent = { id: generateId('ev'), type, ts: Date.now(), patternId, data }
  mintedHitlEvents.add(event)
  return event
}

/** `events` without any `hitl_*` event core did not mint. Every other event
 *  passes untouched, and the same array comes back when nothing is dropped. */
export function dropUnmintedHitl(events: ContextEvent[]): ContextEvent[] {
  const forged = events.filter((e) => HITL_EVENT_TYPES.has(e.type) && !mintedHitlEvents.has(e))
  if (forged.length === 0) return events
  for (const e of forged) {
    console.warn(
      `[harness-patterns] dropped a ${e.type} event from '${e.patternId}' that core did not ` +
        'write: only core writes HITL events (#433).',
    )
  }
  return events.filter((e) => !forged.includes(e))
}

// ============================================================================
// Commit Strategies
// ============================================================================

/** Event types that are always committed regardless of strategy.
 *  Includes 'error' because errors are informational (not partial results)
 *  and must be visible to downstream patterns via EventView.
 *  Includes 'content_sanitized' for the same reason, sharpened: it is the audit
 *  record of a security control firing. A loop that neutralizes an injection
 *  and THEN fails would, under 'on-success', discard the one event proving the
 *  guard did anything — the failure would look unexplained and the attack
 *  invisible.
 *  Includes 'warning' because it is the ONLY record that a side task (a title,
 *  a summary, an intent rewrite) failed and the turn ran on a fallback (#420):
 *  dropping it under 'on-success' is the silent degradation it exists to end.
 *  Includes 'loop_recovery' for the same reason: when a controller's answer
 *  would not parse, it is the only event carrying what the model said, and a
 *  loop that then fails must not drop the record of how it got there (#437).
 *  Includes 'hitl_request' and 'hitl_response' because they ARE the state a
 *  resume derives from (#433): a pattern that asked a person and then failed
 *  must not lose the record of the question, nor of the answer. */
const ALWAYS_COMMIT_TYPES: Set<EventType> = new Set([
  'pattern_enter',
  'pattern_exit',
  'error',
  'content_sanitized',
  'warning',
  'loop_recovery',
  'hitl_request',
  'hitl_response',
])

/** Commit scope events to context based on strategy.
 *  Preserves original event order — lifecycle events (pattern_enter/exit) are
 *  always committed regardless of strategy, interleaved with content events
 *  in their original position. A `hitl_*` event core did not mint is never
 *  committed, under any strategy (#433, F6). */
export function commitEvents<T>(
  ctx: UnifiedContext<T>,
  scope: PatternScope<unknown>,
  strategy: CommitStrategy,
): void {
  const events = dropUnmintedHitl(scope.events)
  switch (strategy) {
    case 'always':
      // All events in original order
      ctx.events.push(...events)
      break
    case 'on-success':
      if (ctx.status !== 'error') {
        ctx.events.push(...events)
      } else {
        // Only lifecycle events
        ctx.events.push(...events.filter((e) => ALWAYS_COMMIT_TYPES.has(e.type)))
      }
      break
    case 'last': {
      // Lifecycle events + last content event, preserving order
      const lastContentIdx = findLastIndex(events, (e) => !ALWAYS_COMMIT_TYPES.has(e.type))
      for (let i = 0; i < events.length; i++) {
        const e = events[i]
        if (ALWAYS_COMMIT_TYPES.has(e.type) || i === lastContentIdx) {
          ctx.events.push(e)
        }
      }
      break
    }
    case 'never':
      // Only lifecycle events
      ctx.events.push(...events.filter((e) => ALWAYS_COMMIT_TYPES.has(e.type)))
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
    // The last fallback covers only a `configurePattern` name this package
    // does not know (every built-in type has a DEFAULT_ERROR_SEVERITY entry),
    // and it says `recoverable` because since #273 D-d this value can END A
    // TURN: `runChain` stops the chain on an irrecoverable error. Defaulting an
    // unknown pattern to chain-fatal would make a custom pattern's first
    // logged error kill turns that used to complete, on no evidence — we know
    // nothing about a pattern we have never seen, and the owner's rule is to
    // gate only when the turn genuinely cannot continue. A pattern that IS
    // turn-fatal says so, in its own config or on the event it emits.
    errorSeverity: config?.errorSeverity ?? DEFAULT_ERROR_SEVERITY[patternType] ?? 'recoverable',
    viewConfig: config?.viewConfig,
  }
}
