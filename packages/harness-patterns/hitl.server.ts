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
 *
 * ## Resuming, superseding, expiring (slice S3)
 *
 * A pause ends the turn; what continues it is an ANSWER, and an answer resumes
 * only the pause it was issued for (P1). {@link checkResume} is that binding:
 * every answer must name a request this run is waiting on, not expired, raised
 * on the tier the resume runs on, with a choice that is an available option of
 * THAT request event — and every waiting request must be answered in the same
 * call. It is checked against `pending`, never against the journal, so an
 * answer that was already applied is refused: acceptance appends a
 * `hitl_response`, and an answered request is no longer pending.
 * {@link recordAnswers} then writes the decisions and substitutes each held
 * result with its sanitized outcome. A new message SUPERSEDES whatever is
 * still waiting ({@link supersedeHitl}), and {@link expireHitl} closes a
 * request nobody answered in time — a non-blocking proposal included (m6).
 * Every one of them substitutes the held results it closes and deletes their
 * `summary`, so the placeholder's compaction summary can never mask the
 * outcome (Δ2).
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { assertServerOnImport } from './assert.server'
import {
  deserializeContext,
  generateId,
  mintHitlEvent,
  resolveConfig,
  serializeContext,
} from './context.server'
import { redactReport, sanitizeUntrusted } from './injection-guard'
import { emitLive } from './live-event-context.server'
import { activeRunFrame } from './run-frame.server'
import type {
  AssistantMessageEventData,
  ConfiguredPattern,
  ContextEvent,
  EventView,
  HeldResult,
  HitlAnswers,
  HitlDecidedBy,
  HitlOption,
  HitlOutcome,
  HitlRequest,
  HitlRequestEventData,
  HitlResponseEventData,
  HitlUnattended,
  PatternConfig,
  PatternScope,
  ScopedPattern,
  ToolResultEventData,
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
  if (!run || !position || run.closed) {
    refuse('no runChain owns this run, so there is no run to pause')
  }

  const kind = request.kind
  const key = `${kind}:${request.key ?? defaultKey(request)}`
  const identity = hitlReplayKey({ kind, key, options: request.options })
  // What the run holds: its committed record, plus what this run raised and
  // has not committed yet — the latter only as far as core could have written
  // it, so an answer pushed into the buffer by anything else is never replayed
  // here, before the commit would have dropped it (#433 S3).
  const state = readHitl({
    events: [...run.ownerEvents(), ...admitBuffered(run.buffer, run.attended)],
  })

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
 * for a person. A run that has CLOSED with a request still waiting still says
 * yes: the decision is still pending in the record, so work left running in a
 * continuation must stop rather than carry on past it (fail closed; a late
 * `askHuman` on that run is refused instead).
 */
export function hitlPending(): boolean {
  const run = hitlRunStore.getStore()
  return !!run && (run.waiting.size > 0 || run.stopKind !== undefined)
}

// ============================================================================
// Resuming, superseding, expiring (#433, slice S3)
// ============================================================================

/** Why `resumeHarness` refused. Every refusal is thrown BEFORE anything is
 *  recorded and before the host's `resolve` runs, so the blob it was given is
 *  untouched and still resumable with a correct answer. */
export type HitlAnswerErrorCode =
  | 'not-paused'
  | 'no-pending'
  | 'expired'
  | 'tier-changed'
  | 'unknown-request'
  | 'missing-answer'
  | 'invalid-choice'
  | 'unavailable-option'
  | 'invalid-flag'
  | 'required-flag'
  | 'chain-changed'

/** An answer that does not resume this pause. `code` says which check refused
 *  it; `requestId` names the waiting request it concerns, when there is one.
 *  The message never quotes what the caller sent. */
export class HitlAnswerError extends Error {
  readonly code: HitlAnswerErrorCode
  readonly requestId?: string
  constructor(code: HitlAnswerErrorCode, message: string, requestId?: string) {
    super(`resumeHarness refused (${code}): ${message}`)
    this.name = 'HitlAnswerError'
    this.code = code
    if (requestId !== undefined) this.requestId = requestId
  }
}

/** One answer that passed every check, normalized. @internal `resumeHarness`. */
export interface AcceptedAnswer {
  /** The waiting request it answers — the event as recorded, so frozen. */
  readonly request: HitlRequestEventData
  /** The option chosen, from THAT request's own options. */
  readonly option: HitlOption
  readonly answer: { readonly choice: string; readonly flags: Readonly<Record<string, boolean>> }
}

/** Past its `expiresAt`? One predicate for the resume check and for
 *  {@link expireHitl}, so a request `resumeHarness` refuses as expired is one
 *  `expireHitl` closes at that instant or any later one. */
const pastDue = (r: HitlRequestEventData, now: number): boolean =>
  r.expiresAt !== undefined && now >= r.expiresAt

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const own = (o: object, key: string): boolean => Object.prototype.hasOwnProperty.call(o, key)

/**
 * The binding (P1), steps 1–6 of the spec: checks only, in order, and the
 * first that fails throws {@link HitlAnswerError}. Nothing here writes.
 *
 * 1. the context is `paused` (`not-paused`);
 * 2. it waits on something (`no-pending`) — `readHitl(ctx).pending`, the
 *    blocking requests of the CURRENT run with no response:
 *    2b. none of them is past due (`expired`) [F5];
 *    2c. each was raised on the tier this resume runs on (`tier-changed`) [C1];
 * 3. every answer names one of them (`unknown-request`) — checked against
 *    `pending`, NEVER against the journal: an answer already applied names a
 *    request that is no longer waiting, so a replay, a double submit, an answer
 *    to a pause the run has moved past and one from an earlier run are all
 *    refused here;
 * 4. every one of them is answered (`missing-answer`);
 * 5. each answer's choice is an option of THAT request event
 *    (`invalid-choice`), an available one (`unavailable-option`), its flags are
 *    that option's flags (`invalid-flag`), and every required flag is set true
 *    by the answer itself (`required-flag`) — a default does not confirm;
 * 6. the top-level chain is the one the run paused in (`chain-changed`) [m4].
 *
 * @internal `resumeHarness` only.
 */
export function checkResume(
  ctx: Pick<UnifiedContext, 'events' | 'status'>,
  answers: HitlAnswers,
  at: {
    readonly names: readonly string[]
    readonly tier: string | undefined
    readonly now: number
  },
): { readonly accepted: readonly AcceptedAnswer[]; readonly startAt: number } {
  if (ctx.status !== 'paused') {
    throw new HitlAnswerError('not-paused', `the context is '${ctx.status}', not paused`)
  }
  const { pending } = readHitl(ctx)
  if (pending.length === 0) {
    throw new HitlAnswerError('no-pending', 'the context is paused, but waits on no request')
  }
  for (const r of pending) {
    if (pastDue(r, at.now)) {
      throw new HitlAnswerError('expired', `request ${r.requestId} is past due`, r.requestId)
    }
  }
  for (const r of pending) {
    if (r.tier !== at.tier) {
      throw new HitlAnswerError(
        'tier-changed',
        `request ${r.requestId} was raised on another inference tier than this resume runs on`,
        r.requestId,
      )
    }
  }

  const given: Record<string, unknown> = isRecord(answers) ? answers : {}
  const waiting = new Set(pending.map((r) => r.requestId))
  for (const id of Object.keys(given)) {
    if (!waiting.has(id)) {
      throw new HitlAnswerError('unknown-request', 'an answer names no request this run waits on')
    }
  }
  for (const r of pending) {
    if (!own(given, r.requestId)) {
      throw new HitlAnswerError(
        'missing-answer',
        `request ${r.requestId} is not answered`,
        r.requestId,
      )
    }
  }

  const accepted = pending.map((request): AcceptedAnswer => {
    const raw = given[request.requestId]
    const choice = typeof raw === 'string' ? raw : isRecord(raw) ? raw.choice : undefined
    const option =
      typeof choice === 'string' ? request.options.find((o) => o.id === choice) : undefined
    if (!option) {
      throw new HitlAnswerError(
        'invalid-choice',
        `the answer to ${request.requestId} is not one of its options`,
        request.requestId,
      )
    }
    if (option.unavailable) {
      throw new HitlAnswerError(
        'unavailable-option',
        `'${option.id}' is not available on ${request.requestId}`,
        request.requestId,
      )
    }
    const sent = isRecord(raw) ? raw.flags : undefined
    if (sent !== undefined && !isRecord(sent)) {
      throw new HitlAnswerError('invalid-flag', 'flags must be an object', request.requestId)
    }
    const declared = option.flags ?? []
    for (const [id, value] of Object.entries(sent ?? {})) {
      if (typeof value !== 'boolean' || !declared.some((f) => f.id === id)) {
        throw new HitlAnswerError(
          'invalid-flag',
          `a flag is not one '${option.id}' declares`,
          request.requestId,
        )
      }
    }
    for (const flag of declared) {
      if (flag.required && sent?.[flag.id] !== true) {
        throw new HitlAnswerError(
          'required-flag',
          `'${option.id}' needs '${flag.id}' confirmed`,
          request.requestId,
        )
      }
    }
    const flags = { ...defaultFlags(option), ...(sent as Record<string, boolean> | undefined) }
    return { request, option, answer: { choice: option.id, flags } }
  })

  const startAt = pending[0].resumeAt?.index
  const sameChain = (r: HitlRequestEventData): boolean =>
    r.resumeAt !== undefined &&
    r.resumeAt.index === startAt &&
    r.resumeAt.names.length === at.names.length &&
    r.resumeAt.names.every((name, i) => name === at.names[i])
  if (
    startAt === undefined ||
    !Number.isInteger(startAt) ||
    startAt < 0 ||
    startAt >= at.names.length ||
    !pending.every(sameChain)
  ) {
    throw new HitlAnswerError(
      'chain-changed',
      "the agent's top-level patterns are not the ones this run paused in",
    )
  }
  return { accepted, startAt }
}

/**
 * Steps 8–9: append one `hitl_response` per accepted answer (`by: 'person'`;
 * `principal` and `resolution` from the HOST, never from the answer) and
 * substitute each held result with its outcome. Returns the response events,
 * in the order they were appended.
 *
 * @internal `resumeHarness` only.
 */
export function recordAnswers(
  ctx: Pick<UnifiedContext, 'events'>,
  accepted: readonly AcceptedAnswer[],
  resolutions: readonly unknown[],
  principal: string | undefined,
): ContextEvent[] {
  const recorded: ContextEvent[] = []
  const outcomes = new Map<string, unknown>()
  accepted.forEach(({ request, option, answer }, i) => {
    const resolution = resolutions[i]
    recorded.push(
      mintHitlEvent('hitl_response', 'harness', {
        v: 1,
        requestId: request.requestId,
        key: request.key,
        kind: request.kind,
        choice: answer.choice,
        ...(option.flags?.length ? { flags: answer.flags } : {}),
        by: 'person',
        ...(principal !== undefined ? { principal } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
      }),
    )
    outcomes.set(request.requestId, resolution ?? `The user chose: ${option.label}.`)
  })
  ctx.events.push(...recorded)
  substituteHeld(ctx, outcomes)
  return recorded
}

/** What a superseded held result says. */
export const SUPERSEDED_NOTE = 'The user did not answer; nothing was kept.'

/** What an expired held result says. */
export const EXPIRED_NOTE = 'Nobody answered in time; nothing was kept.'

/**
 * A new message SUPERSEDES the run that was waiting (D11). `continueSession`
 * calls this before its reset and before the new `user_message`: every request
 * the run still waits on gets `{ choice: null, by: 'superseded' }` — nobody
 * chose, and nothing is chosen for them (P4) — and its held results say so.
 * The new run starts with an empty journal by construction, because its
 * window starts at the new message. Returns the closed request ids.
 *
 * @internal `continueSession` only.
 */
export function supersedeHitl(ctx: Pick<UnifiedContext, 'events'>): string[] {
  return closeUnanswered(ctx, readHitl(ctx).pending, 'superseded', SUPERSEDED_NOTE)
}

/**
 * Close every request nobody answered in time, from a stored blob. Expiry is
 * lazy: the host calls this when it next reads the conversation, and after a
 * resume refused as `expired`.
 *
 * Each request past its `expiresAt` with no response gets `{ choice: null,
 * by: 'expired' }`: a blocking one the current run waits on, and a
 * non-blocking proposal wherever it sits in the log [m6]. Held results are
 * substituted. When a blocking request expired while the run was paused, the
 * run ends `done` with a fixed response and nothing is re-entered — and the
 * run's OTHER pending requests are closed `{ choice: null, by: 'superseded' }`
 * [#481 F2]. Answers are all-or-nothing, so once one has expired the rest
 * cannot be answered either; left open, they would be listed as pending on a
 * finished run that no resume can take. Returns null when nothing was due, so
 * the host writes nothing.
 */
export function expireHitl(
  serialized: string,
  now: number,
): { serialized: string; expired: string[]; superseded: string[] } | null {
  const ctx = deserializeContext(serialized)
  const answered = new Set<string>()
  for (const event of ctx.events) {
    if (event.type === 'hitl_response' && isResponse(event)) answered.add(event.data.requestId)
  }
  const seen = new Set<string>()
  const proposals: HitlRequestEventData[] = []
  for (const event of ctx.events) {
    if (event.type !== 'hitl_request' || !isRequest(event)) continue
    const r = event.data
    if (seen.has(r.requestId)) continue
    seen.add(r.requestId)
    if (!r.blocking && !answered.has(r.requestId) && pastDue(r, now)) proposals.push(r)
  }
  const pending = readHitl(ctx).pending
  const blocking = pending.filter((r) => pastDue(r, now))
  if (blocking.length === 0 && proposals.length === 0) return null

  const expired = [
    ...closeUnanswered(ctx, blocking, 'expired', EXPIRED_NOTE),
    ...closeUnanswered(ctx, proposals, 'expired', EXPIRED_NOTE),
  ]
  const superseded: string[] = []
  if (blocking.length > 0 && ctx.status === 'paused') {
    superseded.push(
      ...closeUnanswered(
        ctx,
        pending.filter((r) => !pastDue(r, now)),
        'superseded',
        SUPERSEDED_NOTE,
      ),
    )
    const response =
      `The ${blocking[0].kind} decision expired before anyone answered, ` +
      'so the run stopped there.'
    ctx.status = 'done'
    ctx.data = { ...(ctx.data as Record<string, unknown>), response }
    ctx.events.push({
      id: generateId('ev'),
      type: 'assistant_message',
      ts: Date.now(),
      patternId: 'harness',
      data: { content: response } satisfies AssistantMessageEventData,
    })
  }
  return { serialized: serializeContext(ctx), expired, superseded }
}

/** Record that nobody chose (`choice: null`) on each request, and substitute
 *  its held results with `note`. */
function closeUnanswered(
  ctx: Pick<UnifiedContext, 'events'>,
  requests: readonly HitlRequestEventData[],
  by: 'superseded' | 'expired',
  note: string,
): string[] {
  const outcomes = new Map<string, unknown>()
  for (const r of requests) {
    ctx.events.push(
      mintHitlEvent('hitl_response', 'harness', {
        v: 1,
        requestId: r.requestId,
        key: r.key,
        kind: r.kind,
        choice: null,
        by,
      }),
    )
    outcomes.set(r.requestId, note)
  }
  substituteHeld(ctx, outcomes)
  return requests.map((r) => r.requestId)
}

/** Is this a gated executor's placeholder? */
export function isHeldResult(value: unknown): value is HeldResult {
  return isRecord(value) && value.held === true && typeof value.requestId === 'string'
}

/**
 * Replace every held `tool_result` of the current run whose request has an
 * outcome now. `result` becomes the outcome AFTER `sanitizeUntrusted`
 * (namespace `hitl`): a resolution is host output about content that may be
 * hostile, and this is the one path by which it reaches a model (P3). The
 * event is marked `heldBy`, and its `summary` is DELETED [Δ2]: a summary is
 * what compaction wrote about the placeholder, and both compaction (which
 * skips a summarized result) and the loops' prior-results preview (which
 * prefers one) would otherwise keep serving "waiting for a decision" in place
 * of the outcome, to the re-entered controller and to every later turn.
 *
 * A held result is identified by the UUID v4 INSIDE its `requestId`, not by an
 * exact match [#481 F1]: the opt-in LLM screen fences every string leaf of a
 * result it flags, the placeholder's id included, and an exact match would
 * then record the answer and leave the fenced held note in place for good. A
 * leaf with no UUID naming one of these outcomes is not substituted; a forged
 * placeholder that carries a real waiting id gets only core's sanitized
 * outcome, which is harmless.
 */
function substituteHeld(
  ctx: Pick<UnifiedContext, 'events'>,
  outcomes: ReadonlyMap<string, unknown>,
): void {
  if (outcomes.size === 0) return
  for (let i = runStart(ctx.events); i < ctx.events.length; i++) {
    const event = ctx.events[i]
    if (event.type !== 'tool_result') continue
    const data = event.data as ToolResultEventData
    if (!isHeldResult(data.result)) continue
    const requestId = heldRequestId(data.result.requestId, outcomes)
    if (requestId === undefined) continue
    const { data: result, report } = sanitizeUntrusted(outcomes.get(requestId), {
      tool: data.tool,
      namespace: 'hitl',
    })
    // A fresh object: no `summary`, and no `sanitized` that described the
    // placeholder rather than what replaced it.
    const { summary: _summary, sanitized: _sanitized, ...rest } = data
    event.data = {
      ...rest,
      result,
      heldBy: requestId,
      ...(report.findings.length > 0 ? { sanitized: redactReport(report) } : {}),
    } satisfies ToolResultEventData
  }
}

/** The UUID v4 found in a held placeholder's `requestId` that names one of
 *  `outcomes`, or undefined. Unanchored, so a fenced id still resolves. */
function heldRequestId(
  requestId: string,
  outcomes: ReadonlyMap<string, unknown>,
): string | undefined {
  for (const [found] of requestId.matchAll(UUID_V4_IN_TEXT)) {
    if (outcomes.has(found)) return found
  }
  return undefined
}

/** Index of the first event of the current run: just after the last
 *  `user_message` (0 when there is none). */
function runStart(events: readonly ContextEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'user_message') return i + 1
  }
  return 0
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
 * The store is still reachable by naming its `Symbol.for` key — the price of
 * the two-copy idiom — so nothing on this object may be a way to WRITE THE
 * RECORD (#433 S3): `attended`, `ownerEvents`, `buffer` and `waiting` are
 * non-writable properties, `ownerEvents()` hands out a copy and never the live
 * log, and what sits in `buffer` is admitted only as far as core could have
 * written it ({@link admitBuffered}). What stays reachable is the stop:
 * clearing `waiting` still suppresses a pause, which forges no answer — the
 * gated executor has already withheld the content, and the request is still
 * pending in the record.
 *
 * @internal `runChain` and `askHuman` only.
 */
export interface HitlRun {
  readonly attended: boolean
  /** A COPY of the owning context's events. Never the live array. */
  readonly ownerEvents: () => ContextEvent[]
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
  /** Set when the owning `runChain` has returned. A continuation the run
   *  started and did not await still sees this run in its async context, and
   *  must not ask into a buffer nobody will commit (#477 delta review). */
  closed?: boolean
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
  // Non-writable (`defineProperties` defaults), so nothing that reaches the
  // store can swap the reader for one that serves a forged log, or flip the
  // run to unattended (#433 S3).
  const run = Object.defineProperties({} as HitlRun, {
    attended: { value: slot.attended === true, enumerable: true },
    ownerEvents: { value: (): ContextEvent[] => [...ctx.events], enumerable: true },
    buffer: { value: [] as ContextEvent[], enumerable: true },
    waiting: { value: new Set<string>(), enumerable: true },
  })
  return hitlRunStore.run(run, () =>
    body(run).finally(() => {
      run.closed = true
    }),
  )
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

/**
 * Commit the buffer straight into the context, never through a scope, so no
 * strategy and no copy of the scope filter can drop the record of a question.
 *
 * Only what core could have written is committed ({@link admitBuffered}), and
 * a request only where the OWNER is: at the top-level index and names it is
 * passed here from its own loop, on the tier of its own frame, in the run its
 * own context is on. So an answer, or a request carrying another `resumeAt` or
 * another tier, pushed into the buffer by anything but `askHuman` never
 * reaches the record a resume is checked against (#433 S3, P6).
 *
 * @internal `runChain` only.
 */
export function commitHitlBuffer(
  run: HitlRun,
  ctx: Pick<UnifiedContext, 'events'>,
  index: number,
  names: readonly string[],
): void {
  const buffered = run.buffer.splice(0)
  if (buffered.length === 0) return
  const known = new Set<string>()
  for (const event of ctx.events) {
    if (event.type === 'hitl_request' && isRequest(event)) known.add(event.data.requestId)
  }
  const at: CommitPoint = {
    index,
    names,
    tier: activeRunFrame().inference?.tier,
    runId: runIdOf(ctx.events),
    known,
  }
  ctx.events.push(...admitBuffered(buffered, run.attended, at))
}

/** Where and on what the owner is when it commits: what a request it raised
 *  must say about itself. */
interface CommitPoint {
  readonly index: number
  readonly names: readonly string[]
  readonly tier: string | undefined
  readonly runId: string
  /** Request ids the context already holds. */
  readonly known: ReadonlySet<string>
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
/** {@link UUID_V4}, unanchored: the ids inside a string that may be fenced. */
const UUID_V4_IN_TEXT = new RegExp(UUID_V4.source.slice(1, -1), 'g')

/**
 * The buffered events core could have written, in order. `askHuman` writes
 * exactly two shapes into the buffer, so nothing else is admitted:
 *
 * - a blocking `hitl_request` with a fresh UUID, a valid request, and — at
 *   commit, when `at` is given — the owner's `resumeAt`, tier and run;
 * - an UNATTENDED `hitl_response`, only in an unattended run, to a request
 *   admitted earlier in the same buffer, whose choice and flags are exactly
 *   what {@link resolveUnattended} picks for it. A person's answer is never in
 *   a buffer: only a resume records one, straight into the context.
 *
 * At commit every other event is dropped with a warning, so a forgery is not
 * silent. `askHuman` reads the buffer through the same rule (without `at`),
 * so an answer forged into it is not replayed before the commit drops it.
 */
function admitBuffered(
  buffer: readonly ContextEvent[],
  attended: boolean,
  at?: CommitPoint,
): ContextEvent[] {
  const admitted: ContextEvent[] = []
  const raised = new Map<string, HitlRequestEventData>()
  const answered = new Set<string>()
  for (const event of buffer) {
    if (
      event.type === 'hitl_request' &&
      isRequest(event) &&
      admitsRequest(event.data, raised, at)
    ) {
      raised.set(event.data.requestId, event.data)
      admitted.push(event)
      continue
    }
    if (event.type === 'hitl_response' && isResponse(event) && !attended) {
      const request = raised.get(event.data.requestId)
      if (request && !answered.has(request.requestId) && isRuleAnswer(event.data, request)) {
        answered.add(request.requestId)
        admitted.push(event)
        continue
      }
    }
    if (at) {
      console.warn(
        `[harness-patterns] dropped a ${event.type} event from '${event.patternId}' in the HITL ` +
          'buffer: only askHuman writes there, and this is not an event it wrote (#433).',
      )
    }
  }
  return admitted
}

function admitsRequest(
  r: HitlRequestEventData,
  raised: ReadonlyMap<string, HitlRequestEventData>,
  at: CommitPoint | undefined,
): boolean {
  if (r.blocking !== true || !UUID_V4.test(r.requestId) || raised.has(r.requestId)) return false
  if (typeof r.kind !== 'string' || typeof r.key !== 'string') return false
  if (!r.key.startsWith(`${r.kind}:`)) return false
  try {
    validate(r)
  } catch {
    return false
  }
  if (!at) return true
  return (
    !at.known.has(r.requestId) &&
    r.tier === at.tier &&
    r.runId === at.runId &&
    r.resumeAt !== undefined &&
    r.resumeAt.index === at.index &&
    r.resumeAt.names.length === at.names.length &&
    r.resumeAt.names.every((name, i) => name === at.names[i])
  )
}

/** Exactly the response `askHuman`'s unattended path writes for `request`. */
function isRuleAnswer(r: HitlResponseEventData, request: HitlRequestEventData): boolean {
  if (r.by !== 'unattended' || r.kind !== request.kind || r.key !== request.key) return false
  if (r.principal !== undefined || r.resolution !== undefined) return false
  const { choice } = resolveUnattended(request)
  if (r.choice !== choice) return false
  const expected = defaultFlags(request.options.find((o) => o.id === choice))
  const got = r.flags ?? {}
  const ids = Object.keys(expected)
  return Object.keys(got).length === ids.length && ids.every((id) => got[id] === expected[id])
}

/** The id of the run's `user_message`, or '' — what `askHuman` stamps. */
function runIdOf(events: readonly ContextEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'user_message') return events[i].id ?? ''
  }
  return ''
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

// ============================================================================
// The gate patterns (#433, slice S4)
// ============================================================================

/** Configuration for {@link humanGate}. */
export interface HumanGateConfig<
  T extends Record<string, unknown>,
  C extends string,
> extends PatternConfig {
  /** The request this gate raises, built from the view and the data the
   *  pattern started from. Return null to pass through without asking —
   *  how a gate decides there is nothing to decide. Thrown
   *  {@link HitlRequestError}s are validation at raise, not runtime conditions. */
  readonly request: (view: EventView, data: Readonly<T>) => HitlRequest<C> | null
  /** What to do with a decision. Runs once per DECISION, not once per raise:
   *  on the run that raised it (an unattended rule's choice), and again on the
   *  re-entry after a resume, where the replayed answer is the person's. The
   *  answer is the shape the record holds — the same fields a `hitl_response`
   *  event carries, with no `principal` or `resolution` (those are the
   *  host's, and a pattern never sees them). */
  readonly onAnswer?: (answer: HitlResponseEventData, data: T) => T
}

/**
 * The custom gate: a pattern that asks when its `request` says there is
 * something to ask (#433 S4). This is the shape `confirm` presets; build one
 * directly when the decision is not approve/reject — the provenance options,
 * a memory proposal, anything with its own kind, options and rule.
 *
 * - `request(view, data)` returns null → the pattern passes through and asks
 *   nothing.
 * - `askHuman` answers (a replayed or unattended decision) → `onAnswer` runs,
 *   and its return value becomes the pattern's data.
 * - `askHuman` returns `pending` → the pattern returns unchanged, and the run
 *   pauses at the boundary. On the resume that re-enters this pattern, the
 *   gate replays the person's answer and `onAnswer` hears it.
 *
 * To READ a decision later instead of acting on it here, give the request an
 * explicit `key` and call `answerOf(view, kind, key)`.
 */
export function humanGate<T extends Record<string, unknown>, C extends string = string>(
  config: HumanGateConfig<T, C>,
): ConfiguredPattern<T> {
  const resolved = resolveConfig('humanGate', config)
  const fn: ScopedPattern<T> = async (scope: PatternScope<T>, view: EventView) => {
    const request = config.request(view, scope.data)
    if (!request) return scope
    const outcome = await askHuman(request)
    if (outcome.status === 'pending' || !config.onAnswer) return scope
    // The decision as the record holds it: the stored key is composed here for
    // the same reason `askHuman` composes it, and the flags are the answer's.
    const answer: HitlResponseEventData = {
      v: 1,
      requestId: outcome.requestId,
      key: `${request.kind}:${request.key ?? defaultKey(request)}`,
      kind: request.kind,
      choice: outcome.choice,
      ...(Object.keys(outcome.flags).length > 0 ? { flags: outcome.flags } : {}),
      by: outcome.by,
    }
    scope.data = config.onAnswer(answer, scope.data)
    return scope
  }
  return { name: 'humanGate', fn, config: resolved }
}

/** Configuration for {@link confirm}. */
export interface ConfirmConfig<T extends Record<string, unknown>> extends PatternConfig {
  /** The question, fixed or computed from the data (and the view). Consumer
   *  text: never an attacker-chosen string [m7]. */
  readonly question: string | ((data: Readonly<T>, view: EventView) => string)
  /** Display facts, computed from the data. Untrusted; never rendered into an
   *  LLM-facing view. */
  readonly summary?: (data: Readonly<T>) => HitlRequest['summary']
  /** The replay key. Give one when a later turn will read the decision with
   *  `answerOf(view, 'confirm', key)` — the default is a content hash no
   *  consumer can name. */
  readonly key?: string
  readonly approveLabel?: string
  readonly rejectLabel?: string
  /** What a rejection does. `'stop'` (default) ends the run — attended (the
   *  resume records the stop) and unattended (the rule's pick stops it)
   *  alike. `'continue'` lets the chain go on past the gate. */
  readonly onReject?: 'stop' | 'continue'
  /** What an unattended run does. Default `'apply-default'`: the rule picks
   *  Reject. `'park'` waits for a person instead. */
  readonly unattended?: 'apply-default' | 'park'
}

/**
 * The one-call gate at a chain boundary (#433 S4; the common case of O5):
 *
 * ```typescript
 * const agent = harness(planner, confirm({ question: (d) => `Run this plan? ${d.plan.summary}` }), executeLoop)
 * ```
 *
 * Two options, in display order: **Approve** — never picked by the unattended
 * rule, because nothing is approved without a person (P4) — and **Reject**,
 * the default and the unattended choice. By default a rejection STOPS the run
 * (`onReject: 'stop'`): attended, the resume records it and nothing is
 * re-entered; unattended, the rule picks Reject and the run ends `done` at
 * the boundary. `onReject: 'continue'` lets the chain run past the gate
 * instead; read the decision with `answerOf(view, 'confirm', key)` — which
 * needs an explicit `key` — or act on it with `onAnswer` by composing
 * `humanGate` directly.
 */
export function confirm<T extends Record<string, unknown>>(
  config: ConfirmConfig<T>,
): ConfiguredPattern<T> {
  const {
    question,
    summary,
    key,
    approveLabel,
    rejectLabel,
    onReject,
    unattended,
    ...patternConfig
  } = config
  const gate = humanGate<T, 'approve' | 'reject'>({
    ...patternConfig,
    request: (view, data) => ({
      kind: 'confirm',
      ...(key !== undefined ? { key } : {}),
      question: typeof question === 'function' ? question(data, view) : question,
      options: [
        { id: 'approve', label: approveLabel ?? 'Approve' },
        {
          id: 'reject',
          label: rejectLabel ?? 'Reject',
          unattended: true,
          ...(onReject !== 'continue' ? { stopsRun: true } : {}),
        },
      ],
      defaultOption: 'reject',
      ...(summary ? { summary: summary(data) } : {}),
      ...(unattended !== undefined ? { unattended } : {}),
    }),
  })
  return { ...gate, name: 'confirm' }
}
