/**
 * EventView - Server Only
 *
 * Fluent API for filtering and querying events from UnifiedContext.
 * Used by patterns to access events from previous patterns.
 */

import { assertServerOnImport } from '../assert.server'
import type {
  UnifiedContext,
  ContextEvent,
  EventType,
  ViewConfig,
  ContentTransform,
  EventView as IEventView,
  UserMessageEventData,
  AssistantMessageEventData,
  ToolCallEventData,
  ToolResultEventData
} from '../types'

assertServerOnImport()

// ============================================================================
// EventView Implementation
// ============================================================================

type EventFilter = (event: ContextEvent) => boolean

export class EventViewImpl implements IEventView {
  /** Predicate filters applied sequentially (AND chain) in get() */
  private filters: EventFilter[] = []
  private limitLast?: number
  private limitFirst?: number
  private sinceTs?: number
  /** Rolling turn window — slices events at the Nth-to-last user_message boundary */
  private fromLastNTurnsCount?: number
  /** Read-time content transforms — applied as final step in get().
   *  Never mutates stored ctx.events. */
  private contentTransforms?: ContentTransform[]

  constructor(
    private ctx: UnifiedContext,
    config?: ViewConfig,
    /** Pattern ID of the current scope — excluded from fromLastPattern() */
    private selfPatternId?: string
  ) {
    // Apply initial config
    if (config) {
      this.applyConfig(config)
    }
  }

  /**
   * Apply ViewConfig by pushing filters directly to this instance.
   *
   * Previously this called cloning selector methods (fromPatterns(), ofTypes(),
   * etc.) whose return values were discarded — making applyConfig a no-op.
   * Fixed to mutate `this` directly.
   *
   * Application order in get():
   *   1. sinceTs       — timestamp cutoff
   *   2. fromLastNTurns — turn-based slice (needs user_message events for
   *                       boundary detection, so runs before type filters)
   *   3. filters[]     — pattern scope + type predicates (AND chain)
   *   4. limitFirst / limitLast — quantity caps
   */
  private applyConfig(config: ViewConfig): void {
    // ── Pattern scope (mutually exclusive: first match wins) ──
    // These restrict which pattern's events are visible.
    // Setting fromLast: false with no other scope option disables pattern
    // filtering entirely, giving cross-turn visibility over all events.
    if (config.fromPatterns && config.fromPatterns.length > 0) {
      const idSet = new Set(config.fromPatterns)
      this.filters.push((e) => idSet.has(e.patternId))
    } else if (config.fromLastN !== undefined) {
      const all = this.selfPatternId
        ? this.getPatternIds().filter(id => id !== this.selfPatternId)
        : this.getPatternIds()
      const ids = new Set(all.slice(-config.fromLastN))
      if (ids.size > 0) this.filters.push((e) => ids.has(e.patternId))
      else this.filters.push(() => false)
    } else if (config.fromLast !== false) {
      // Default: only see events from the immediately preceding pattern
      const lastId = this.getLastPatternId()
      if (lastId) this.filters.push((e) => e.patternId === lastId)
      else this.filters.push(() => false)
    }

    // ── Turn-based rolling window ──
    // Stored as a field and applied in get() BEFORE the filters loop,
    // because we need user_message events present to detect turn boundaries.
    if (config.fromLastNTurns !== undefined) {
      this.fromLastNTurnsCount = config.fromLastNTurns
    }

    // ── Type filter ──
    if (config.eventTypes && config.eventTypes.length > 0) {
      const typeSet = new Set(config.eventTypes)
      this.filters.push((e) => typeSet.has(e.type))
    }

    // ── Quantity limit ──
    if (config.limit !== undefined) {
      this.limitLast = config.limit
    }

    // ── Content transforms ──
    if (config.contentTransforms && config.contentTransforms.length > 0) {
      this.contentTransforms = config.contentTransforms
    }
  }

  private addFilter(filter: EventFilter): this {
    this.filters.push(filter)
    return this
  }

  /** Create a shallow copy preserving all filters, limits, window state, and transforms */
  private clone(): EventViewImpl {
    const view = new EventViewImpl(this.ctx, undefined, this.selfPatternId)
    view.filters = [...this.filters]
    view.limitLast = this.limitLast
    view.limitFirst = this.limitFirst
    view.sinceTs = this.sinceTs
    view.fromLastNTurnsCount = this.fromLastNTurnsCount
    view.contentTransforms = this.contentTransforms
    return view
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Pattern Selectors
  // ─────────────────────────────────────────────────────────────────────────

  /** Events from a specific pattern by ID */
  fromPattern(patternId: string): EventViewImpl {
    const view = this.clone()
    view.addFilter((e) => e.patternId === patternId)
    return view
  }

  /** Events from multiple specific patterns */
  fromPatterns(patternIds: string[]): EventViewImpl {
    const view = this.clone()
    const idSet = new Set(patternIds)
    view.addFilter((e) => idSet.has(e.patternId))
    return view
  }

  /** Events from the most recent execution of the immediately preceding pattern.
   *  Scoped to the last pattern_enter → pattern_exit boundary for that ID,
   *  so repeated executions of the same pattern across turns don't bleed. */
  fromLastPattern(): EventViewImpl {
    const lastPatternId = this.getLastPatternId()
    if (!lastPatternId) {
      const view = this.clone()
      view.addFilter(() => false)
      return view
    }

    // Build a set of events within the last execution boundary for O(1) lookup
    const [startIdx, endIdx] = this.getLastExecutionBounds(lastPatternId)
    const boundaryEvents = new Set(this.ctx.events.slice(startIdx, endIdx + 1))

    const view = this.clone()
    view.addFilter((e) => boundaryEvents.has(e) && e.patternId === lastPatternId)
    return view
  }

  /** Events from the last N patterns in execution order (excluding self) */
  fromLastNPatterns(n: number): EventViewImpl {
    const ids = this.selfPatternId
      ? this.getPatternIds().filter(id => id !== this.selfPatternId)
      : this.getPatternIds()
    const patternIds = ids.slice(-n)
    if (patternIds.length === 0) {
      const view = this.clone()
      view.addFilter(() => false)
      return view
    }
    return this.fromPatterns(patternIds)
  }

  /** Events from all patterns (no pattern filter) */
  fromAll(): EventViewImpl {
    return this.clone()
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Type Selectors
  // ─────────────────────────────────────────────────────────────────────────

  /** Events of a specific type */
  ofType(type: EventType): EventViewImpl {
    const view = this.clone()
    view.addFilter((e) => e.type === type)
    return view
  }

  /** Events of multiple types */
  ofTypes(types: EventType[]): EventViewImpl {
    const view = this.clone()
    const typeSet = new Set(types)
    view.addFilter((e) => typeSet.has(e.type))
    return view
  }

  /** Tool-related events (tool_call + tool_result) */
  tools(): EventViewImpl {
    return this.ofTypes(['tool_call', 'tool_result'])
  }

  /** Message events (user_message + assistant_message) */
  messages(): EventViewImpl {
    return this.ofTypes(['user_message', 'assistant_message'])
  }

  /** Controller action events */
  actions(): EventViewImpl {
    return this.ofType('controller_action')
  }

  /** Error events */
  errors(): EventViewImpl {
    return this.ofType('error')
  }

  /** Check if any errors in view */
  hasErrors(): boolean {
    return this.errors().exists()
  }

  /** Get last error message */
  lastError(): string | undefined {
    const errors = this.errors().last(1).get()
    return errors.length > 0
      ? (errors[0].data as { error: string })?.error
      : undefined
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Quantity Selectors
  // ─────────────────────────────────────────────────────────────────────────

  /** Last N events (after other filters applied) */
  last(n: number): EventViewImpl {
    const view = this.clone()
    view.limitLast = n
    return view
  }

  /** First N events (after other filters applied) */
  first(n: number): EventViewImpl {
    const view = this.clone()
    view.limitFirst = n
    return view
  }

  /** Events since a specific timestamp */
  since(ts: number): EventViewImpl {
    const view = this.clone()
    view.sinceTs = ts
    return view
  }

  /**
   * Rolling window: keep only events from the last N user turns.
   * A "turn" = one user_message event. Events before the Nth-to-last
   * user_message are excluded. Applied in get() before predicate filters
   * so that user_message boundaries are still present for detection.
   */
  fromLastNTurns(n: number): EventViewImpl {
    const view = this.clone()
    view.fromLastNTurnsCount = n
    return view
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Execution
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Execute query and return matching events.
   *
   * Pipeline order:
   *   1. sinceTs          — hard timestamp cutoff
   *   2. fromLastNTurns   — slice at Nth-to-last user_message boundary
   *                         (runs before filters so user_message events are
   *                          present for boundary detection even when the
   *                          caller later filters to other types)
   *   3. filters[]        — predicate chain (pattern scope, event types, …)
   *   4. limitFirst/Last  — quantity caps on the final result
   */
  get(): ContextEvent[] {
    let events = this.ctx.events

    // 1. Timestamp cutoff
    if (this.sinceTs !== undefined) {
      events = events.filter((e) => e.ts >= this.sinceTs!)
    }

    // 2. Turn-based rolling window
    if (this.fromLastNTurnsCount !== undefined) {
      events = sliceByLastNTurns(events, this.fromLastNTurnsCount)
    }

    // 3. Predicate filters (AND chain — each pass narrows further)
    for (const filter of this.filters) {
      events = events.filter(filter)
    }

    // 4. Quantity caps
    if (this.limitFirst !== undefined) {
      events = events.slice(0, this.limitFirst)
    }
    if (this.limitLast !== undefined) {
      events = events.slice(-this.limitLast)
    }

    // 5. Content transforms (read-time lens — never mutates ctx.events)
    if (this.contentTransforms?.length) {
      events = events.map(e =>
        this.contentTransforms!.reduce((evt, fn) => fn(evt), e)
      )
    }

    return events
  }

  /** Serialize events to XML format for LLM context */
  serialize(): string {
    return this.get()
      .map((event) => formatEvent(event))
      .join('\n')
  }

  /**
   * Serialize events with compact pointers for older tool results.
   *
   * Events within the last `recentTurns` user turns render in full.
   * Older tool_result events render as compact pointers with ref IDs,
   * allowing the LLM to reference them via `ref:<eventId>`.
   *
   * @param options.recentTurns - Number of recent user turns to show in full (default: 1)
   */
  serializeCompact(options?: { recentTurns?: number }): string {
    const recentTurns = options?.recentTurns ?? 1
    const events = this.get()
    if (events.length === 0) return ''

    // Find turn boundaries by locating user_message events
    const userMessageIndices: number[] = []
    for (let i = 0; i < this.ctx.events.length; i++) {
      if (this.ctx.events[i].type === 'user_message') {
        userMessageIndices.push(i)
      }
    }

    // Determine the timestamp cutoff: events from the last N user turns are "recent"
    let recentCutoffTs = 0
    if (userMessageIndices.length > recentTurns) {
      const cutoffIdx = userMessageIndices[userMessageIndices.length - recentTurns]
      recentCutoffTs = this.ctx.events[cutoffIdx].ts
    }

    // Exclude hidden/archived tool_results from LLM context
    const visibleEvents = events.filter(event => {
      if (event.type !== 'tool_result') return true
      const d = event.data as ToolResultEventData
      return !d.hidden && !d.archived
    })

    return visibleEvents
      .map((event) => {
        const isRecent = event.ts >= recentCutoffTs
        if (!isRecent && event.type === 'tool_result' && event.id) {
          return formatEventCompact(event)
        }
        return formatEvent(event)
      })
      .join('\n')
  }

  /** Check if any events match */
  exists(): boolean {
    return this.get().length > 0
  }

  /** Count matching events */
  count(): number {
    return this.get().length
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Internal Helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Get unique pattern IDs ordered by *most recent* pattern_enter.
   *
   * Ordering by last-appearance (not first-appearance) is critical for
   * multi-turn sessions: when a pattern was introduced in an earlier turn
   * but a different pattern just executed in the current turn,
   * fromLastPattern() must resolve to the *just-executed* one, not to
   * whichever pattern happened to be introduced latest historically.
   */
  private getPatternIds(): string[] {
    const seen = new Set<string>()
    const reverseOrder: string[] = []
    for (let i = this.ctx.events.length - 1; i >= 0; i--) {
      const e = this.ctx.events[i]
      if (e.type !== 'pattern_enter') continue
      if (seen.has(e.patternId)) continue
      seen.add(e.patternId)
      reverseOrder.push(e.patternId)
    }
    return reverseOrder.reverse()
  }

  /** Get the ID of the last pattern that entered (excluding self) */
  private getLastPatternId(): string | undefined {
    const ids = this.selfPatternId
      ? this.getPatternIds().filter(id => id !== this.selfPatternId)
      : this.getPatternIds()
    return ids.at(-1)
  }

  /**
   * Get the [startIdx, endIdx] bounds of the last execution of a pattern.
   * Scans backwards for the last pattern_enter, then forwards for
   * the matching pattern_exit (or end of events if still running).
   */
  private getLastExecutionBounds(patternId: string): [number, number] {
    const events = this.ctx.events
    let startIdx = 0

    // Scan backwards for the last pattern_enter with this ID
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'pattern_enter' && events[i].patternId === patternId) {
        startIdx = i
        break
      }
    }

    // Scan forwards from startIdx for the matching pattern_exit
    let endIdx = events.length - 1
    for (let i = startIdx + 1; i < events.length; i++) {
      if (events[i].type === 'pattern_exit' && events[i].patternId === patternId) {
        endIdx = i
        break
      }
    }

    return [startIdx, endIdx]
  }
}

// ============================================================================
// Turn Window Helper
// ============================================================================

/**
 * Slice an event array to keep only events from the last N user turns.
 * A turn boundary is defined by a user_message event.
 * If fewer than N turns exist, all events are returned.
 */
function sliceByLastNTurns(events: ContextEvent[], n: number): ContextEvent[] {
  // Find indices of all user_message events — these mark turn boundaries
  const userMsgIndices = events
    .map((e, i) => (e.type === 'user_message' ? i : -1))
    .filter(i => i >= 0)

  if (userMsgIndices.length === 0) return events

  // Slice from the Nth-to-last user_message onwards
  const startIdx = userMsgIndices.length > n
    ? userMsgIndices[userMsgIndices.length - n]
    : 0

  return events.slice(startIdx)
}

// ============================================================================
// Event Formatting
// ============================================================================

/** Format a single event as XML for LLM context */
function formatEvent(event: ContextEvent): string {
  const content = formatEventData(event)
  return `<${event.type}>${content}</${event.type}>`
}

/** Format a tool_result event as a compact pointer (uses summary if available) */
function formatEventCompact(event: ContextEvent): string {
  const data = event.data as ToolResultEventData
  const resultStr = typeof data.result === 'string'
    ? data.result
    : JSON.stringify(data.result)
  // Prefer LLM-generated summary over raw result slice for the compact preview
  const preview = data.summary ?? resultStr.slice(0, 120).replace(/\n/g, ' ')
  const suffix = !data.summary && resultStr.length > 120 ? '...' : ''
  return `<tool_result id="${event.id}" tool="${data.tool}" compact="true">${preview}${suffix} (${resultStr.length} chars). Use ref:${event.id} to access full data.</tool_result>`
}

/** Format event data based on type */
function formatEventData(event: ContextEvent): string {
  switch (event.type) {
    case 'user_message': {
      const data = event.data as UserMessageEventData
      return data.content
    }
    case 'assistant_message': {
      const data = event.data as AssistantMessageEventData
      return data.content
    }
    case 'tool_call': {
      const data = event.data as ToolCallEventData
      return `${data.tool}: ${JSON.stringify(data.args)}`
    }
    case 'tool_result': {
      const data = event.data as ToolResultEventData
      if (!data.success) {
        return `${data.tool} ERROR: ${data.error}`
      }
      const base = `${data.tool}: ${JSON.stringify(data.result)}`
      return data.summary ? `${base}\n[Summary: ${data.summary}]` : base
    }
    default:
      return typeof event.data === 'object'
        ? JSON.stringify(event.data)
        : String(event.data)
  }
}

// ============================================================================
// Factory Function
// ============================================================================

/** Create a new EventView for querying context events */
export function createEventView(
  ctx: UnifiedContext,
  config?: ViewConfig,
  selfPatternId?: string
): EventViewImpl {
  return new EventViewImpl(ctx, config, selfPatternId)
}
