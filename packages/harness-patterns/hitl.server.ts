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
 *
 * ## Asking (slice S2)
 *
 * {@link askHuman} is the one writer a run has. It is called from inside a run
 * — a pattern body, or a tool executor that holds no scope and no context.
 * The run frame's `hitl` slot says only whether a person is there (a frozen
 * `{ attended }`); the bookkeeping — the owning context, where it is, the
 * buffer, what waits and whether a rule stopped the run — is in a store of its
 * own that the owning `runChain` opens, which nothing public hands out (#477
 * F1), and which each concurrent run gets separately (F2). `askHuman` replays a
 * decision the run already holds, applies the unattended rule when nobody is
 * there, or raises the request into that buffer and returns `pending`. Nothing
 * it raises goes through a scope: the owning `runChain` commits the buffer
 * straight into the context at the next boundary and pauses there
 * ({@link commitHitlBuffer}, {@link hitlHalt}). The STOP is cooperative — the loops and sequencers ask
 * {@link hitlPending} between steps — but the WITHHOLDING is not: a gated
 * executor returns {@link held} instead of the content, so a loop that ignored
 * the check would still never see what is being decided.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { assertServerOnImport } from './assert.server'
import { mintHitlEvent } from './context.server'
import { emitLive } from './live-event-context.server'
import { activeRunFrame } from './run-frame.server'
import type {
  ContextEvent,
  EventView,
  HeldResult,
  HitlDecidedBy,
  HitlOption,
  HitlOutcome,
  HitlRequest,
  HitlRequestEventData,
  HitlResponseEventData,
  HitlUnattended,
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
 * The current run's answer to the `kind` request raised with `key`, or
 * undefined.
 *
 * `key` is the key the consumer gave the request — not the stored
 * `${kind}:${key}` form, which core composes here. A request raised with the
 * default content-hash key has no key a consumer can name, so a request whose
 * answer will be looked up needs an explicit `key`.
 *
 * It reads the view's UNFILTERED log [F18]: a `ViewConfig` that narrows by
 * pattern or type would otherwise hide the `hitl_response` and read as "not
 * answered". Only the replay journal counts, so a proposal's answer is never
 * returned. When the run holds two decisions under one kind and key
 * (different option sets) there is no single answer, and it returns undefined
 * rather than pick one: an answer must not authorize a different request [F8].
 */
export function answerOf(
  view: EventView,
  kind: string,
  key: string,
): HitlResponseEventData | undefined {
  const stored = `${kind}:${key}`
  let found: HitlResponseEventData | undefined
  for (const answer of readHitl({ events: view.unfiltered().get() }).answers.values()) {
    if (answer.key !== stored) continue
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

// ============================================================================
// Asking (#433, slice S2)
// ============================================================================

/** An invalid request: a wiring bug, thrown when it is raised. Every other
 *  path through {@link askHuman} is total. */
export class HitlRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HitlRequestError'
  }
}

const UNATTENDED_RULES: ReadonlySet<HitlUnattended> = new Set(['apply-default', 'park', 'stop'])

function refuse(message: string): never {
  throw new HitlRequestError(`askHuman: ${message}`)
}

/** May the unattended rule pick this option? Only when it says so, and only
 *  when it can be picked at all [P4]. */
const pickable = (o: HitlOption): boolean => o.unattended === true && !o.unavailable

/** Validation at raise (spec §1, with the #472 amendment on ':'). */
function validate(request: HitlRequest): void {
  if (typeof request.kind !== 'string' || request.kind.includes(':')) {
    refuse(`kind must be a string without ':' (got ${JSON.stringify(request.kind)})`)
  }
  if (!Array.isArray(request.options) || request.options.length < 2) {
    refuse(`a '${request.kind}' request needs at least 2 options`)
  }
  const options: readonly HitlOption[] = request.options
  const ids = options.map((o) => o.id)
  if (new Set(ids).size !== ids.length) refuse(`option ids must be unique (${ids.join(', ')})`)
  const fallback = options.find((o) => o.id === request.defaultOption)
  if (!fallback || fallback.unavailable) {
    refuse(`defaultOption '${request.defaultOption}' must name an available option`)
  }
  const rule = request.unattended ?? 'apply-default'
  if (!UNATTENDED_RULES.has(rule)) refuse('unattended must be one of apply-default, park, stop')
  if (rule === 'stop' && !options.some((o) => o.stopsRun)) {
    refuse("the 'stop' rule needs an option with stopsRun")
  }
  for (const option of options) {
    const flagIds = (option.flags ?? []).map((f) => f.id)
    if (new Set(flagIds).size !== flagIds.length) {
      refuse(`flag ids must be unique on option '${option.id}'`)
    }
    if (option.unattended === true && option.flags?.some((f) => f.required)) {
      refuse(`option '${option.id}' may be picked unattended, so it cannot carry a required flag`)
    }
  }
}

/**
 * The unattended rule (#433 §4). Pure, and shared by core and host.
 *
 * - `apply-default`: the default if it is available and the rule may pick it,
 *   else the first available option it may pick, in display order; else
 *   nothing, and the run stops.
 * - `stop`: the first available `stopsRun` option the rule may pick; else
 *   nothing, and the run still stops. An option without `unattended: true` is
 *   never picked by the rule, not even to stop [P4].
 * - `park`: decides nothing; the request waits for a person.
 */
export function resolveUnattended<C extends string>(
  request: HitlRequest<C>,
): { choice: C | null; stopsRun: boolean } {
  const rule = request.unattended ?? 'apply-default'
  if (rule === 'park') return { choice: null, stopsRun: false }
  const candidates = request.options.filter(pickable)
  const picked =
    rule === 'stop'
      ? candidates.find((o) => o.stopsRun)
      : (candidates.find((o) => o.id === request.defaultOption) ?? candidates[0])
  return picked
    ? { choice: picked.id, stopsRun: picked.stopsRun === true }
    : { choice: null, stopsRun: true }
}

/** The default key: content-addressed over what the person is shown (the
 *  question, the SET of option ids and the summary) as a canonical tuple, so
 *  neither display order nor key order changes it. */
function defaultKey(request: HitlRequest): string {
  const ids = [...new Set(request.options.map((o) => o.id))].sort()
  const summary = Object.entries(request.summary ?? {}).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )
  return createHash('sha256')
    .update(JSON.stringify([request.question, ids, summary]))
    .digest('hex')
}

const isAvailable = (options: readonly HitlOption[], choice: string | null): boolean =>
  options.some((o) => o.id === choice && !o.unavailable)

/** The default flags of the option the rule chose: a flag is a sub-choice
 *  made WITH the option, and nobody made one. */
function defaultFlags(option: HitlOption | undefined): Record<string, boolean> {
  return Object.fromEntries((option?.flags ?? []).map((f) => [f.id, f.default]))
}

/**
 * Ask a person to decide, from inside a run (a pattern body or a tool
 * executor; no scope is needed). In order:
 *
 * 1. Validate the request; an invalid one throws {@link HitlRequestError}.
 * 2. Find the run. Outside a frame, with no `hitl` slot, or with no `runChain`
 *    owning a HITL run in this async context, it THROWS: there is no run to
 *    pause.
 * 3. Replay: a decision this run already holds for the same kind, key and
 *    option set is returned, if its choice is still an available option of
 *    THIS request, and nothing is written.
 * 4. A request this run already raised and is waiting on is not raised twice.
 * 5. Otherwise a new `requestId` (a UUID v4), stamped with `resumeAt` and the
 *    run's opaque tier (C1).
 * 6. Unattended, unless the rule is `park`: the rule decides, the request and
 *    an `unattended` response are buffered, and it returns `answered`. A
 *    choice that stops the run stops it at the next boundary.
 * 7. Attended (and `park`): the request is buffered, emitted live whatever the
 *    pattern's `liveEvents` says, and it returns `pending`.
 */
export async function askHuman<C extends string>(request: HitlRequest<C>): Promise<HitlOutcome<C>> {
  validate(request)
  const frame = activeRunFrame()
  if (!frame.hitl) {
    refuse(
      'this run has no hitl slot. harness() and its siblings supply one when they open the ' +
        'frame; a host that opens its own adds `hitl: { attended }` around its main run.',
    )
  }
  // The bookkeeping comes from the run's OWN store, never from the frame
  // (#477 F1): nothing a pattern can reach through the frame writes it.
  const run = hitlRunStore.getStore()
  const position = run?.position
  if (!run || !position) refuse('no runChain owns this run, so there is no run to pause')

  const kind = request.kind
  const key = `${kind}:${request.key ?? defaultKey(request)}`
  const identity = hitlReplayKey({ kind, key, options: request.options })
  const state = readHitl({ events: [...run.owner.events, ...run.buffer] })

  const earlier = state.answers.get(identity)
  if (earlier && isAvailable(request.options, earlier.choice)) {
    return {
      status: 'answered',
      requestId: earlier.requestId,
      choice: earlier.choice as C,
      flags: earlier.flags ?? {},
      by: earlier.by,
    }
  }

  const waiting = state.pending.find((p) => hitlReplayKey(p) === identity)
  if (waiting) {
    // Still waiting, so the run still stops for it — including when the
    // request was committed by an earlier attempt of this run rather than
    // raised by this one (a host re-running a paused context it has not
    // answered): no second request, and no run past it either.
    run.waiting.add(waiting.requestId)
    return { status: 'pending', requestId: waiting.requestId }
  }

  const requestId = randomUUID()
  const rule = request.unattended ?? 'apply-default'
  const tier = frame.inference?.tier
  const data: HitlRequestEventData = {
    v: 1,
    requestId,
    runId: state.runId ?? '',
    key,
    kind,
    question: request.question,
    options: request.options,
    defaultOption: request.defaultOption,
    unattended: rule,
    summary: request.summary ?? {},
    ...(request.payloadRef !== undefined ? { payloadRef: request.payloadRef } : {}),
    ...(request.expiresInMs !== undefined ? { expiresAt: Date.now() + request.expiresInMs } : {}),
    blocking: true,
    resumeAt: { index: position.index, names: position.names },
    ...(tier !== undefined ? { tier } : {}),
  }
  const event = mintHitlEvent('hitl_request', position.patternId, data)

  if (!run.attended && rule !== 'park') {
    const { choice, stopsRun } = resolveUnattended(request)
    const flags = defaultFlags(request.options.find((o) => o.id === choice))
    const by: HitlDecidedBy = 'unattended'
    run.buffer.push(
      event,
      mintHitlEvent('hitl_response', position.patternId, {
        v: 1,
        requestId,
        key,
        kind,
        choice,
        ...(Object.keys(flags).length > 0 ? { flags } : {}),
        by,
      }),
    )
    if (stopsRun) run.stopKind ??= kind
    return { status: 'answered', requestId, choice, flags, by }
  }

  run.buffer.push(event)
  run.waiting.add(requestId)
  // Forced: the person watching must see the question while the run is still
  // going. Recorded as delivered, so the commit does not send it twice.
  emitLive(event, true)
  return { status: 'pending', requestId }
}

/** The note a held result carries when the consumer gives none. */
export const HELD_NOTE = "This call is waiting for a person's decision. Do not retry it; stop."

/** What a gated tool executor returns while its request is pending: the
 *  placeholder, never the content. */
export function held(
  outcome: { readonly requestId: string },
  note: string = HELD_NOTE,
): HeldResult {
  return { held: true, requestId: outcome.requestId, note }
}

/**
 * The stop check every loop and sequencer makes between steps: must this run
 * stop at its next boundary, because a request waits for a person or an
 * unattended choice stops the run? False outside a HITL run. A SOFT read, like
 * the live emitters: a pattern driven outside any frame simply never stops
 * for a person.
 */
export function hitlPending(): boolean {
  const run = hitlRunStore.getStore()
  return !!run && (run.waiting.size > 0 || run.stopKind !== undefined)
}

// ============================================================================
// The owning runChain's half (internal)
// ============================================================================

/** Where the owning `runChain` is: what a raised request records as its
 *  `resumeAt`, and the pattern its events are tagged with. */
interface HitlPosition {
  readonly index: number
  /** EVERY top-level pattern name, so a resume can refuse a changed chain [m4]. */
  readonly names: readonly string[]
  readonly patternId: string
}

/**
 * One run's HITL bookkeeping (#433 S2). It is NOT on the run frame (#477 F1):
 * the frame is a public, typed surface (`activeRunFrame()` is in the barrel),
 * and a buffer the owner commits unchecked, or a `waiting` set that decides
 * whether the run stops, would be a write path into the record and around the
 * pause for any pattern holding it. It lives in {@link hitlRunStore}, which
 * nothing exports, and each `runChain` that owns a run opens its own — so two
 * runs started concurrently in one host frame never share one (F2).
 *
 * @internal `runChain` and `askHuman` only.
 */
export interface HitlRun {
  readonly attended: boolean
  /** The context of the `runChain` that opened this run. */
  readonly owner: Pick<UnifiedContext, 'events'>
  /** Where the owner is. Undefined until it dispatches its first pattern. */
  position?: HitlPosition
  /** HITL events raised this run and not yet committed. The owner commits them
   *  STRAIGHT into `ctx.events` at the next boundary, never through a scope,
   *  so no `commitStrategy` and no copy of the scope filter can drop one. */
  readonly buffer: ContextEvent[]
  /** Request ids this run waits on for a person. */
  readonly waiting: Set<string>
  /** The kind whose unattended rule chose to stop the run, if one did. */
  stopKind?: string
}

/**
 * The store, on a `globalThis` symbol: the run frame's two-copy idiom (#374
 * D4). Two loaded copies of this package find the same store, so a request
 * one copy raises is the one the other copy's `runChain` commits.
 */
const HITL_RUN_KEY: unique symbol = Symbol.for('hames.harness-patterns.hitl-run') as never
type HitlRunHolder = { store: AsyncLocalStorage<HitlRun> }
const hitlRunHolders = globalThis as unknown as Record<symbol, HitlRunHolder | undefined>
const hitlRunStore = (hitlRunHolders[HITL_RUN_KEY] ??= {
  store: new AsyncLocalStorage<HitlRun>(),
}).store

/**
 * Run `body` as the owner of a HITL run, or not. The `runChain` that finds the
 * frame's `hitl` slot set and no HITL run open in its async context opens one,
 * `hitlRunStore.run(bookkeeping, body)`, and is handed it; a `runChain` nested
 * inside one of the owner's patterns sees it open and claims nothing [F7]. A
 * frame with no slot opens nothing, and `askHuman` refuses there (H12).
 *
 * @internal `runChain` only.
 */
export function withHitlRun<R>(
  ctx: Pick<UnifiedContext, 'events'>,
  body: (run: HitlRun | undefined) => Promise<R>,
): Promise<R> {
  const slot = activeRunFrame().hitl
  if (!slot || hitlRunStore.getStore()) return body(undefined)
  const run: HitlRun = {
    attended: slot.attended === true,
    owner: ctx,
    buffer: [],
    waiting: new Set<string>(),
  }
  return hitlRunStore.run(run, () => body(run))
}

/** Where the owner is, before each pattern. @internal `runChain` only. */
export function positionHitlRun(
  run: HitlRun,
  index: number,
  names: readonly string[],
  patternId: string,
): void {
  run.position = { index, names, patternId }
}

/** Commit the buffer straight into the context, never through a scope, so no
 *  strategy and no copy of the scope filter can drop the record of a question.
 *  @internal `runChain` only. */
export function commitHitlBuffer(run: HitlRun, ctx: Pick<UnifiedContext, 'events'>): void {
  ctx.events.push(...run.buffer.splice(0))
}

/** Must the run end at this boundary, and how? A stop wins over a pause: a
 *  choice that stops the run stops it, whatever else is waiting.
 *  @internal `runChain` only. */
export function hitlHalt(
  run: HitlRun,
): { readonly stop: string } | { readonly pause: true } | undefined {
  if (run.stopKind !== undefined) return { stop: run.stopKind }
  if (run.waiting.size > 0) return { pause: true }
  return undefined
}

/** The response a run stopped by an unattended rule ends with. */
export function unattendedStopMessage(kind: string): string {
  return (
    `Stopped at the ${kind} check: there was no one to ask, and its rule for that case is ` +
    'to stop the run.'
  )
}
