/**
 * HITL server actions — the answer RPC (#433 S7).
 *
 * `'use server'` module: every export is a browser-callable RPC, so every
 * export authenticates FIRST and takes no owner parameter — the owner comes
 * from the session and a foreign conversation simply does not exist for the
 * caller (SD-13). The gate must return before any resource is opened, which
 * here means before the conversation is loaded.
 *
 * The ONE write this module owns is `answerHitl`: the person's answer,
 * recorded against the stored request. It is TRANSPORT, never authority: the
 * decision state is the conversation blob's `hitl_*` events (ADR-0009), so
 * this module never writes the blob — the resume turn
 * (`turn.server.ts` mode `'resume'`) reads these rows, validates them
 * against `readHitl(blob).pending` and lets core bind them to the pause.
 *
 * What a client may supply is choice ids and flags, and NOTHING else (F4/A2):
 * no `principal` (the host stamps it from the session), no `resolution` (the
 * host's `resolve` produces it). The input type and `isAnswerShape` enforce
 * that at the trust boundary, and a second answer to a request that already
 * has one is `already-answered` — first answer wins.
 */
'use server'

import { deserializeContext, readHitl, type HitlRequestEventData } from '@hames-ai/harness-patterns'
import { loadSession } from '../harness-client/session.server'
import { isAnswerShape, recordHitlAnswer, type HitlAnswerValue } from '../db/hitl.server'
import { getAuthenticatedUser } from '../auth/server'
import { BYPASS_USER, isBypassEnabled } from '../auth/dev-bypass'

/**
 * Resolve the current user. In dev with the bypass enabled, returns the
 * shared `BYPASS_USER` so persistence works without a real Entra session.
 * See `lib/auth/dev-bypass.ts` for the gate. This module's own copy, like
 * every `'use server'` module's (SD-13: the gate is duplicated per module,
 * never imported — a shared helper would itself be an export).
 */
async function requireUser(): Promise<{ id: string; email: string }> {
  if (isBypassEnabled()) {
    return { id: BYPASS_USER.id, email: BYPASS_USER.email }
  }
  const u = await getAuthenticatedUser()
  return { id: u.id, email: u.email }
}

/** What became of one answer the client sent. The client renders `outcome` as
 *  the card's state; nothing here quotes what the caller sent back. */
export interface AnswerOutcome {
  readonly requestId: string
  readonly outcome:
    | 'answered'
    | 'already-answered'
    | 'unknown-request'
    | 'expired'
    | 'invalid-choice'
    | 'unavailable-option'
    | 'invalid-flag'
    | 'required-flag'
}

/** The answers a client may send: `requestId → choice | { choice, flags }`.
 *  Core's own answer type, re-declared so a caller cannot smuggle extra keys
 *  through a wider type. */
export type ClientAnswers = Readonly<Record<string, string | HitlAnswerValue>>

/**
 * Record the person's answers to a conversation's pending HITL requests.
 *
 * Never writes the conversation blob (A6): it loads the owner's stored
 * context, derives the pending requests with core's reader, and checks each
 * answer against ITS request event — a choice that is not an available
 * option of the request is refused here, because the resume that would
 * consume the answer would refuse it too (`invalid-choice`) and a recorded
 * but unusable answer would brick the request behind `already-answered`.
 *
 * First answer wins per request (A2): a second answer — a double submit, a
 * replayed form — changes nothing and comes back `already-answered`.
 */
export async function answerHitl(
  sessionId: string,
  answers: ClientAnswers,
): Promise<AnswerOutcome[]> {
  const user = await requireUser()
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('sessionId is required')
  }
  // F4/A2 at the trust boundary: only choice ids and flags may cross the wire,
  // and anything else is refused for the whole call — before the conversation
  // is loaded, so a malformed body opens no resource.
  if (typeof answers !== 'object' || answers === null || Array.isArray(answers)) {
    throw new Error('answers must be an object of requestId → choice')
  }
  for (const [requestId, value] of Object.entries(answers)) {
    if (!requestId || !isAnswerShape(value)) {
      throw new Error('an answer is not a choice id with optional flags')
    }
  }

  const loaded = await loadSession(sessionId, user.id)
  if (!loaded) throw new Error('Conversation not found')

  const ctx = deserializeContext(loaded.serializedContext)
  const pending = ctx.status === 'paused' ? readHitl(ctx).pending : []
  const byId = new Map(pending.map((r) => [r.requestId, r]))

  const results: AnswerOutcome[] = []
  for (const [requestId, value] of Object.entries(answers)) {
    results.push(await answerOne(sessionId, user.id, byId, requestId, value))
  }
  return results
}

/** Validate and record one answer against its request event. */
async function answerOne(
  sessionId: string,
  userId: string,
  byId: ReadonlyMap<string, HitlRequestEventData>,
  requestId: string,
  value: string | HitlAnswerValue,
): Promise<AnswerOutcome> {
  const request = byId.get(requestId)
  // A request this run is not waiting on: superseded, already answered,
  // expired, someone else's, or a typed id. Refused without saying which —
  // the resume is where a stale id would be refused as `unknown-request`.
  if (!request) return { requestId, outcome: 'unknown-request' }
  // A request past its `expiresAt` is dead even though the blob still lists
  // it: the resume closes it by expiry, and the card should not accept an
  // answer nothing will consume.
  if (request.expiresAt !== undefined && Date.now() >= request.expiresAt) {
    return { requestId, outcome: 'expired' }
  }
  const choice = typeof value === 'string' ? value : value.choice
  const flags = typeof value === 'string' ? undefined : value.flags
  const option = request.options.find((o) => o.id === choice)
  if (!option) return { requestId, outcome: 'invalid-choice' }
  if (option.unavailable) return { requestId, outcome: 'unavailable-option' }
  if (flags !== undefined) {
    const declared = option.flags ?? []
    const names = Object.keys(flags)
    if (names.some((id) => !declared.some((f) => f.id === id))) {
      return { requestId, outcome: 'invalid-flag' }
    }
  }
  for (const flag of option.flags ?? []) {
    if (flag.required && flags?.[flag.id] !== true) {
      return { requestId, outcome: 'required-flag' }
    }
  }

  const recorded = await recordHitlAnswer({
    requestId,
    userId,
    sessionId,
    kind: request.kind,
    runId: request.runId || null,
    blocksRun: request.blocking,
    expiresAt: request.expiresAt !== undefined ? new Date(request.expiresAt) : null,
    answer: value,
  })
  return { requestId, outcome: recorded ? 'answered' : 'already-answered' }
}
