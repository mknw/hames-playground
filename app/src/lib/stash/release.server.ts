/**
 * Data Stash session release — Server Only
 *
 * What a deleted conversation leaves behind in the stash: its documents, chunk
 * records and embedding space in Redis. The session's claim is not handled
 * here — it leaves in the conversation delete's own transaction
 * (`releaseSessionClaims`); this runs after that commit.
 *
 * Best-effort by contract: the conversation is already gone, so a purge that
 * fails is logged and never thrown, and the delete still reports success.
 */

import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { deleteSessionStash } from '@hames-ai/harness-patterns/stash/document-ingest.server'
import { getSessionClaimOwner } from '../db/session-claims.server'

assertServerOnImport()

/**
 * Clear the stash of each session whose conversation was just deleted. A
 * session still held by a live claim is someone else's and is left alone: the
 * deleter's own claim was already removed with the row.
 */
export async function releaseDeletedSessions(sessionIds: readonly string[]): Promise<void> {
  for (const sessionId of sessionIds) {
    try {
      if (await getSessionClaimOwner(sessionId)) continue
      await deleteSessionStash(sessionId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`[stash] could not clear the stash of deleted session ${sessionId}:`, msg)
    }
  }
}
