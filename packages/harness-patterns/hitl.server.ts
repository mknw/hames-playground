/**
 * Human in the loop (#433): the reader.
 *
 * HITL state is the context's events and nothing else (ADR-0009). A request
 * is a `hitl_request` event and its answer a `hitl_response`; nothing about a
 * decision rides `ctx.data`, and no store outside the context decides a resume.
 * {@link readHitl} is the ONE function that turns those events into state, so
 * every reader — a resume validating an answer, a gate replaying one, a host
 * listing what is pending — derives the same thing from the same record.
 *
 * Two rules decide what the reader admits, and both fail closed:
 *
 * - **One run.** Only events after the last `user_message` count. An answer is
 *   given for the run it was asked in, so a new message starts with nothing
 *   pending and nothing to replay.
 * - **The replay rule [F8].** An answer replays into a gate only if it answers
 *   a BLOCKING request of this run, carries that request's kind and key, and
 *   chose an available option of it — and only for a request with the same
 *   kind, key and option-id set ({@link hitlReplayKey}). A proposal's answer
 *   never replays into a gate, and an answer never authorizes a different
 *   request that happens to share its key.
 *
 * Legacy `approval_*` events are never read: a stored `{ approved: true }`
 * from a 0.1.x blob is inert by construction (#433, F9).
 */

import { assertServerOnImport } from './assert.server'
import type {
  ContextEvent,
  EventView,
  HitlRequestEventData,
  HitlResponseEventData,
  UnifiedContext,
} from './types'

assertServerOnImport()

/** What one run's HITL events say. */
export interface HitlState {
  /** The id of the `user_message` that opened the run. Informational. */
  readonly runId?: string
  /** The run's blocking requests that have no response, in raise order. */
  readonly pending: readonly HitlRequestEventData[]
  /** The replay journal, keyed by {@link hitlReplayKey}: the latest admitted
   *  answer for each request identity. */
  readonly answers: ReadonlyMap<string, HitlResponseEventData>
}

/**
 * The identity an answer replays under: kind, stored key and the SET of option
 * ids. Two requests with the same key but a different kind or option set are
 * different decisions [F8]. Encoded as a JSON tuple rather than a joined string,
 * so no kind or key can be spelled to collide with another.
 */
export function hitlReplayKey(
  request: Pick<HitlRequestEventData, 'kind' | 'key' | 'options'>,
): string {
  const ids = [...new Set(request.options.map((o) => o.id))].sort()
  return JSON.stringify([request.kind, request.key, ids])
}

/**
 * Derive the current run's HITL state from a context's events. Pure.
 *
 * It reads every event as it is, including the plain objects of a deserialized
 * blob — the blob is server-held state (#433 §2) — and ignores an event whose
 * payload it cannot read (not `v: 1`, or missing the fields the rules need)
 * rather than guessing at it.
 */
export function readHitl(ctx: Pick<UnifiedContext, 'events'>): HitlState {
  const { events } = ctx
  let start = 0
  let runId: string | undefined
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'user_message') {
      start = i + 1
      runId = events[i].id
      break
    }
  }

  // The first event per requestId wins: core writes exactly one of each.
  const requests = new Map<string, HitlRequestEventData>()
  const responses = new Map<string, HitlResponseEventData>()
  for (let i = start; i < events.length; i++) {
    const event = events[i]
    if (event.type === 'hitl_request' && isRequest(event)) {
      if (!requests.has(event.data.requestId)) requests.set(event.data.requestId, event.data)
    } else if (event.type === 'hitl_response' && isResponse(event)) {
      if (!responses.has(event.data.requestId)) responses.set(event.data.requestId, event.data)
    }
  }

  const pending = [...requests.values()].filter((r) => r.blocking && !responses.has(r.requestId))

  // Responses in log order, so a later answer to the same identity (a gate
  // asked again because its earlier choice became unavailable) replaces the
  // earlier one.
  const answers = new Map<string, HitlResponseEventData>()
  for (const answer of responses.values()) {
    const request = requests.get(answer.requestId)
    if (!request?.blocking) continue
    if (answer.kind !== request.kind || answer.key !== request.key) continue
    if (!request.options.some((o) => o.id === answer.choice && !o.unavailable)) continue
    answers.set(hitlReplayKey(request), answer)
  }

  return { runId, pending, answers }
}

/**
 * The current run's answer to the decision stored under `key` — the
 * `${kind}:${key}` form both HITL events carry — or undefined.
 *
 * It reads the view's UNFILTERED log [F18]: a `ViewConfig` that narrows by
 * pattern or type would otherwise hide the `hitl_response` and read as "not
 * answered". Only the replay journal counts, so a proposal's answer is never
 * returned. When the run holds two decisions under one key (the same kind and
 * key, different option sets) there is no single answer, and it returns
 * undefined rather than pick one: an answer must not authorize a different
 * request [F8].
 */
export function answerOf(view: EventView, key: string): HitlResponseEventData | undefined {
  let found: HitlResponseEventData | undefined
  for (const answer of readHitl({ events: view.unfiltered().get() }).answers.values()) {
    if (answer.key !== key) continue
    if (found) return undefined
    found = answer
  }
  return found
}

function isRequest(event: ContextEvent): event is ContextEvent & { data: HitlRequestEventData } {
  const d = event.data as Partial<HitlRequestEventData> | null | undefined
  return (
    typeof d === 'object' &&
    d !== null &&
    d.v === 1 &&
    typeof d.requestId === 'string' &&
    Array.isArray(d.options)
  )
}

function isResponse(event: ContextEvent): event is ContextEvent & { data: HitlResponseEventData } {
  const d = event.data as Partial<HitlResponseEventData> | null | undefined
  return typeof d === 'object' && d !== null && d.v === 1 && typeof d.requestId === 'string'
}
