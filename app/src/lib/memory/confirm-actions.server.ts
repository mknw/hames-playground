/**
 * Memory confirmation RPCs (#419 M6 = #433 S11).
 *
 * `'use server'` module: every export is a browser-callable RPC, so every export
 * authenticates FIRST and takes no owner parameter — the owner comes from the
 * session, and a foreign conversation or request id is indistinguishable from an
 * unknown one (SD-13). The gate returns before any resource is opened: before
 * the conversation is loaded, before a row is read.
 *
 * A client supplies a conversation id, a request id, and a choice with optional
 * flags — nothing else. It never supplies the payload (the memory text is held
 * server-side and shown, never accepted back), the principal (the session's
 * user) or a memory id. Which items an answer saves is the answer's FLAGS,
 * validated by core against the request event the proposal recorded.
 *
 * The logic is `proposals.server.ts`, which takes the owner and is therefore not
 * itself an RPC. This file is its authenticated door and holds nothing else; the
 * gated-export source scan in `confirm-actions.test.ts` pins that.
 */
'use server'

import { isAnswerShape, type HitlAnswerValue } from '../db/hitl.server'
import { getAuthenticatedUser } from '../auth/server'
import { BYPASS_USER, isBypassEnabled } from '../auth/dev-bypass'
import {
  answerMemoryProposalFor,
  listMemoryInboxFor,
  listMemoryProposalsFor,
  type MemoryInboxEntry,
  type MemoryAnswerOutcome,
  type MemoryProposalView,
} from './proposals.server'

/**
 * Resolve the current user. In dev with the bypass enabled, returns the shared
 * `BYPASS_USER`. This module's own copy, like every `'use server'` module's
 * (SD-13: the gate is duplicated per module, never imported — a shared helper
 * would itself be an export).
 */
async function requireUser(): Promise<{ id: string; email: string }> {
  if (isBypassEnabled()) {
    return { id: BYPASS_USER.id, email: BYPASS_USER.email }
  }
  const u = await getAuthenticatedUser()
  return { id: u.id, email: u.email }
}

/** The memory proposals waiting on the caller in one conversation. */
export async function listMemoryProposals(sessionId: string): Promise<MemoryProposalView[]> {
  const user = await requireUser()
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId is required')
  return listMemoryProposalsFor(user.id, sessionId)
}

/**
 * Answer one proposal: `choice` is `save` (with `flags` naming the items to
 * keep) or `discard`. Anything but a string choice, or `{ choice, flags? }` with
 * boolean flags and no other key, is refused for the whole call before a
 * resource is opened (F4/A2).
 */
export async function answerMemoryProposal(
  sessionId: string,
  requestId: string,
  answer: string | HitlAnswerValue,
): Promise<MemoryAnswerOutcome> {
  const user = await requireUser()
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId is required')
  if (typeof requestId !== 'string' || !requestId) throw new Error('requestId is required')
  if (!isAnswerShape(answer)) throw new Error('an answer is not a choice id with optional flags')
  return answerMemoryProposalFor(user.id, sessionId, requestId, answer)
}

/** Every memory proposal waiting on the caller, across conversations — the
 *  header inbox. No arguments: the owner is the session's user, never a value
 *  the browser supplies. */
export async function listMemoryInbox(): Promise<MemoryInboxEntry[]> {
  const user = await requireUser()
  return listMemoryInboxFor(user.id)
}
