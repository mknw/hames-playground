/**
 * Organizational-knowledge confirmation RPCs (`docs/plan/org-knowledge-hook.md`,
 * slice 4). `'use server'`: every export is a browser-callable RPC, so every
 * export authenticates FIRST and takes no owner parameter — the owner is the
 * session's user, and another user's conversation or request id is
 * indistinguishable from an unknown one (SD-13). The gate returns before any
 * resource is opened.
 *
 * A client supplies a conversation id, a request id and a choice with optional
 * flags — never the payload, never the actor, never a node. Which assertions
 * are written is the answer's FLAGS, validated by core against the request
 * event the proposal recorded. The logic is `proposals.server.ts`; this file is
 * its authenticated door and holds nothing else.
 */
'use server'

import { isAnswerShape, type HitlAnswerValue } from '../db/hitl.server'
import { getAuthenticatedUser } from '../auth/server'
import { BYPASS_USER, isBypassEnabled } from '../auth/dev-bypass'
import {
  answerOrgProposalFor,
  listOrgProposalsFor,
  type OrgAnswerOutcome,
  type OrgProposalView,
} from './proposals.server'

/** The current user — this module's own copy of the gate, like every
 *  `'use server'` module's (SD-13: a shared helper would itself be an RPC). */
async function requireUser(): Promise<{ id: string }> {
  if (isBypassEnabled()) return { id: BYPASS_USER.id }
  const u = await getAuthenticatedUser()
  return { id: u.id }
}

/** The org-knowledge proposals waiting on the caller in one conversation. */
export async function listOrgProposals(sessionId: string): Promise<OrgProposalView[]> {
  const user = await requireUser()
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId is required')
  return listOrgProposalsFor(user.id, sessionId)
}

/** Answer one proposal: `add` (with `flags` naming the assertions to write) or
 *  `discard`. Anything but a choice id with boolean flags is refused before a
 *  resource is opened. */
export async function answerOrgProposal(
  sessionId: string,
  requestId: string,
  answer: string | HitlAnswerValue,
): Promise<OrgAnswerOutcome> {
  const user = await requireUser()
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('sessionId is required')
  if (typeof requestId !== 'string' || !requestId) throw new Error('requestId is required')
  if (!isAnswerShape(answer)) throw new Error('an answer is not a choice id with optional flags')
  return answerOrgProposalFor(user.id, sessionId, requestId, answer)
}
