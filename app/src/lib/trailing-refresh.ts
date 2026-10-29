/**
 * Live delivery of a turn's trailing pass to the panels (#784 item 12).
 *
 * A turn's post-turn summarization (`compactAndSave` in
 * `harness-client/turn.server.ts`) is deliberately detached: it starts after
 * the answer has reached the caller, and for the SSE route after the stream
 * closed, so nobody holds a response open for the whole describe call. What it
 * adds to the context — the `model_call` events of the describe calls, the
 * `memory_written` events, a summarizer-failure `warning`, and the `summary`
 * each describe call leaves on its `tool_result` — is therefore persisted but
 * never emitted: the observability panel only showed it after a reload.
 *
 * The fix stays client-side and respects the detachment: after a watched turn
 * settles, a bounded poll re-reads the persisted context through the existing
 * `loadConversation` server action and merges what the trailing pass landed.
 * The trailing pass writes the row exactly once, so a poll either sees the
 * pre-pass context (nothing to merge yet) or the whole pass — never a part of
 * it — which is what makes "stop at first delta" correct.
 *
 * Framework-free: no Solid, no DOM. The caller supplies narrow hooks over its
 * session state, so the delta and the merge are unit-testable without a
 * component.
 */
import type { ContextEvent } from '@hames-ai/harness-patterns'

// ============================================================================
// Timing
// ============================================================================

/** Delay before the first re-read, from the moment the turn settled. */
export const TRAILING_REFRESH_FIRST_DELAY_MS = 3_000

/** Interval between re-reads while nothing has landed yet. */
export const TRAILING_REFRESH_INTERVAL_MS = 3_000

/** Hard cap on re-reads. The trailing pass is two describe-tier calls behind
 *  a box the turn itself already woke, so seconds on either tier; ten tries
 *  (~30s) over-provision it without spinning on a turn that had nothing to
 *  summarize. A call that fails is recorded as a persisted `warning` event —
 *  itself a delta — so the failure case lands through the same poll. */
export const TRAILING_REFRESH_MAX_ATTEMPTS = 10

// ============================================================================
// Delta
// ============================================================================

/** What a trailing pass added that the live stream did not deliver. */
export interface TrailingDelta {
  /** Events the pass appended — `model_call`, `memory_written`, `warning` —
   *  in persisted order. */
  additions: ContextEvent[]
  /** `summary` fields the pass enriched onto `tool_result` events the buffer
   *  already holds, keyed by event id. */
  summaries: ReadonlyArray<{ eventId: string; summary: string }>
}

/**
 * Diff the session's event buffer against the conversation's persisted events.
 *
 * Returns null when the persisted context holds nothing the buffer lacks —
 * either the trailing pass has not landed yet, or this turn had nothing
 * trailing at all. The caller keeps polling until null flips to a delta or the
 * attempt cap runs out.
 */
export function trailingDelta(
  local: readonly ContextEvent[],
  fetched: readonly ContextEvent[],
): TrailingDelta | null {
  const localById = new Map(local.filter((e) => e.id).map((e) => [e.id, e]))
  const additions = fetched.filter((e) => e.id && !localById.has(e.id))
  const summaries: Array<{ eventId: string; summary: string }> = []
  for (const event of fetched) {
    if (event.type !== 'tool_result' || !event.id) continue
    const data = event.data as { summary?: unknown } | undefined
    if (typeof data?.summary !== 'string' || data.summary.length === 0) continue
    // Only a summary the buffer does not have yet: re-applying one would
    // rewrite a field the user may have watched land, and the Data Stash's
    // hide/archive flags ride on the same event data.
    const existing = localById.get(event.id)
    const existingData = existing?.data as { summary?: unknown } | undefined
    if (existing?.type !== 'tool_result' || typeof existingData?.summary === 'string') continue
    summaries.push({ eventId: event.id, summary: data.summary })
  }
  if (additions.length === 0 && summaries.length === 0) return null
  return { additions, summaries }
}

// ============================================================================
// The poll
// ============================================================================

/** The narrow session-state surface the poll needs. All hooks are bound to
 *  one session by the caller — a conversation switched mid-poll cannot
 *  misfile a merge (the same rule `TurnSink`'s writes follow). */
export interface TrailingRefreshHooks {
  /** The session's current event buffer, read fresh on every use. */
  local(): readonly ContextEvent[]
  /** The conversation's persisted events. Rejecting stops the poll — the
   *  conversation is gone (deleted under the user). */
  fetch(): Promise<readonly ContextEvent[]>
  /** Append events to the buffer. */
  append(events: readonly ContextEvent[]): void
  /** Rewrite the buffer's events in place. */
  map(map: (event: ContextEvent) => ContextEvent): void
}

/**
 * Poll for the just-settled turn's trailing pass and merge it into the panel
 * buffers. Stops at the first landed delta, when the buffer is empty (cleared
 * by the user or pruned — hydration owns the view then), when the conversation
 * is gone, or at the attempt cap.
 */
export function startTrailingRefresh(hooks: TrailingRefreshHooks): void {
  let attempts = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const tick = () => {
    timer = undefined
    attempts += 1
    void (async () => {
      // An empty buffer means the user cleared the panel or the registry
      // pruned the session: either way hydration reloads from Postgres on the
      // next visit, and resurrecting cleared events here would fight it.
      // Re-checked after the fetch too — the fetch is a network round trip,
      // and a clear landing inside it must win.
      if (hooks.local().length === 0) return stop()
      let fetched: readonly ContextEvent[]
      try {
        fetched = await hooks.fetch()
      } catch {
        return stop()
      }
      if (hooks.local().length === 0) return stop()
      const delta = trailingDelta(hooks.local(), fetched)
      if (delta) {
        applyDelta(hooks, delta)
        return stop()
      }
      if (attempts >= TRAILING_REFRESH_MAX_ATTEMPTS) return stop()
      timer = setTimeout(tick, TRAILING_REFRESH_INTERVAL_MS)
    })()
  }

  timer = setTimeout(tick, TRAILING_REFRESH_FIRST_DELAY_MS)
}

/**
 * Apply a delta, re-checking against the buffer as it is NOW: the stream can
 * deliver an event between the delta's computation and its application (a
 * newer turn started streaming into the same session), and `append` does not
 * dedupe — a second copy of an id would be a duplicated panel row.
 */
function applyDelta(hooks: TrailingRefreshHooks, delta: TrailingDelta): void {
  if (delta.additions.length > 0) {
    const present = new Set(
      hooks
        .local()
        .filter((e) => e.id)
        .map((e) => e.id),
    )
    const fresh = delta.additions.filter((e) => e.id !== undefined && !present.has(e.id))
    if (fresh.length > 0) hooks.append(fresh)
  }
  if (delta.summaries.length > 0) {
    const byId = new Map(delta.summaries.map((s) => [s.eventId, s.summary]))
    hooks.map((event) => {
      const summary = event.id === undefined ? undefined : byId.get(event.id)
      if (summary === undefined) return event
      const data = event.data as Record<string, unknown>
      if (typeof data.summary === 'string') return event // landed while we worked
      return { ...event, data: { ...data, summary } }
    })
  }
}
