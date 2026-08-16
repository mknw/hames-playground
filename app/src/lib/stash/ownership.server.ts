/**
 * Data Stash session ownership — Server Only
 *
 * Data Stash documents are keyed by `sessionId`, so every stash route needs one
 * question answered before it touches storage: does this session belong to the
 * requesting user? Two records can answer it, and this module is the single
 * place that combines them.
 *
 *   1. `session_claims` — ownership recorded at first touch (see
 *      `db/session-claims.server.ts`). This is what covers the pre-persistence
 *      window: an upload can arrive before the session has a conversation row
 *      (a file dropped before the first chat message), and the row that is
 *      eventually written is not guaranteed to be written by the same user.
 *   2. `conversations.user_id` — the long-lived record, written by the chat
 *      path (`actions.server.ts` seeds the row before the first turn runs) and
 *      by the agent-trigger path (`action-runner.server.ts` → `seedActionRow`,
 *      which inserts the row inside the same request that stores the
 *      recording, so a triggered run's documents are owned from the start).
 *
 * A live claim wins over the conversation row: the claim is the earlier of the
 * two touches whenever both exist, and first toucher wins. Claims expire with
 * the documents they scope, after which the conversation row — which never
 * changes hands, `saveConversation` only ever updates content columns — is the
 * remaining record.
 *
 * Writes go through {@link claimSessionOwnership} (record-or-verify); reads go
 * through {@link userOwnsSession} (verify only).
 */

import { assertServerOnImport } from '../harness-patterns/assert.server'
import { getConversationOwner } from '../db/conversations.server'
import { claimSession, getSessionClaimOwner } from '../db/session-claims.server'
import { DEFAULT_TTL_SECONDS } from '../document-store.server'

assertServerOnImport()

/**
 * The user a session's stash belongs to, or null when nothing has claimed it
 * yet. A null owner means the session has no documents either: every write path
 * claims before it stores.
 */
export async function resolveSessionOwner(sessionId: string): Promise<string | null> {
  const claimed = await getSessionClaimOwner(sessionId)
  if (claimed) return claimed
  return getConversationOwner(sessionId)
}

/** Whether `userId` owns this session's stash. Read paths gate on this. */
export async function userOwnsSession(sessionId: string, userId: string): Promise<boolean> {
  return (await resolveSessionOwner(sessionId)) === userId
}

/**
 * Record `userId` as the session's owner if nobody holds it yet, and report
 * whether the caller ends up owning it. Write paths (upload, ingest, flag
 * edits, delete) gate on this so the very first write is what establishes
 * ownership; a later write by a different user is refused.
 *
 * An existing conversation row is authoritative for its own user — the claim is
 * (re)written so ownership stays pinned for the TTL window even if the row is
 * later removed.
 */
export async function claimSessionOwnership(sessionId: string, userId: string): Promise<boolean> {
  const conversationOwner = await getConversationOwner(sessionId)
  if (conversationOwner && conversationOwner !== userId) {
    // Someone else's conversation — but a live claim still outranks the row,
    // so only refuse when the claim agrees (or is absent).
    const claimed = await getSessionClaimOwner(sessionId)
    return claimed === userId
  }
  return (await claimSession(sessionId, userId, DEFAULT_TTL_SECONDS)) === userId
}
