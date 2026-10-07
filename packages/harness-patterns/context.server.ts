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

/** Deserialize context from JSON string.
 *
 *  Every `hitl_*` event comes back deep-frozen, as one is at mint (#433, F1):
 *  a stored decision is the record a resume is checked against, so a pattern
 *  that reads it through a view must not be able to rewrite it in place. */
export function deserializeContext<T = Record<string, unknown>>(json: string): UnifiedContext<T> {
  const ctx = JSON.parse(json) as UnifiedContext<T>
  for (const event of ctx.events) {
    if (HITL_EVENT_TYPES.has(event.type)) deepFreeze(event)
  }
  return ctx
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
// what is already in an array, so they drop every HITL event they find, with a
// warning.
//
// EVERY one, not only the ones core did not create (#433 S2, the #472
// review's ruling 4). No legitimate HITL event travels through a scope: what
// `askHuman` raises goes into the run frame's `hitl` slot, and the `runChain`
// that owns the slot commits it straight into `ctx.events`; the resume-time
// writers append to the context directly. S1 kept a module-private set of
// "minted" events and let those through, which was per loaded copy — on a
// tarball install with two resolved copies, one copy's request was "forged"
// to the other's commit and dropped — and which a deep import of the minting
// helper could join. With nothing legitimate left on the path, the set is
// gone and the rule is a type check. `readHitl` never consulted it either:
// events already in a stored blob are server-held state (spec #433 §2, P1a).

const HITL_EVENT_TYPES: ReadonlySet<EventType> = new Set<EventType>([
  'hitl_request',
  'hitl_response',
])

function refuseHitl(type: EventType, via: string): void {
  if (HITL_EVENT_TYPES.has(type)) {
    throw new Error(`${via} cannot write a ${type} event: only core writes HITL events (#433).`)
  }
}

/**
 * Create a HITL event: a deep-frozen copy of `data`.
 *
 * @internal Core's HITL writers only, which put what it returns straight into
 * the context or the run frame's `hitl` slot. It is not in the package barrel,
 * and what it builds cannot be smuggled in through a scope: `commitEvents` and
 * `chain()` drop every HITL event they meet.
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
  // A deep-frozen COPY (#433, F1). Frozen, so a pattern holding the event —
  // through a view, after the commit — cannot rewrite the decision in place.
  // A copy, so the caller's own
  // objects (an options constant shared by every request) are not frozen with
  // it, and so the request keeps the "frozen copy" of its options the spec asks for.
  return deepFreeze({
    id: generateId('ev'),
    type,
    ts: Date.now(),
    patternId,
    data: structuredClone(data),
  })
}

/** `Object.freeze`, recursively, over plain objects and arrays — in place. A
 *  value already frozen is left as it is, which also ends a cycle. */
function deepFreeze<T>(value: T): T {
  if (!Array.isArray(value) && !isPlainObject(value)) return value
  if (Object.isFrozen(value)) return value
  Object.freeze(value)
  for (const child of Object.values(value as object)) deepFreeze(child)
  return value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** `events` without any `hitl_*` event: none belongs on a scope (see above).
 *  Every other event passes untouched, and the same array comes back when
 *  nothing is dropped. Each drop is logged, so a forged one is not silent. */
export function dropHitl(events: ContextEvent[]): ContextEvent[] {
  const dropped = events.filter((e) => HITL_EVENT_TYPES.has(e.type))
  if (dropped.length === 0) return events
  for (const e of dropped) {
    console.warn(
      `[harness-patterns] dropped a ${e.type} event from '${e.patternId}' on a scope: only ` +
        'core writes HITL events, straight into the context (#433).',
    )
  }
  return events.filter((e) => !HITL_EVENT_TYPES.has(e.type))
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
 *  Includes 'decision_made' (#418) for the same family of reason, sharpened
 *  by what it records: the audit trail of WHAT the policy layer decided and
 *  WHY (which fallback answered, which threshold abstained). A decision is
 *  exactly the kind of fact a retry or a later pattern re-derives
 *  differently — dropping it under 'on-success'-with-error or 'never' leaves
 *  a verdict in `data.decisions` whose evidence is gone. It is metadata-only
 *  (see `DecisionMadeEventData`), so committing it always is safe under every
 *  strategy.
 *  The two `hitl_*` types are NOT here, although they are always committed
 *  (#433): they never reach a strategy at all. The owning `runChain` commits
 *  them from the run frame's slot straight into the context, after every
 *  pattern including one that threw, and a scope that carries one has it
 *  dropped before any strategy applies. An entry here would be unreachable. */
const ALWAYS_COMMIT_TYPES: Set<EventType> = new Set([
  'pattern_enter',
  'pattern_exit',
  'error',
  'content_sanitized',
  'warning',
  'loop_recovery',
  'decision_made',
])

/** Commit scope events to context based on strategy.
 *  Preserves original event order — lifecycle events (pattern_enter/exit) are
 *  always committed regardless of strategy, interleaved with content events
 *  in their original position. A `hitl_*` event on a scope is never
 *  committed, under any strategy (#433, F6). */
export function commitEvents<T>(
  ctx: UnifiedContext<T>,
  scope: PatternScope<unknown>,
  strategy: CommitStrategy,
): void {
  const events = dropHitl(scope.events)
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
