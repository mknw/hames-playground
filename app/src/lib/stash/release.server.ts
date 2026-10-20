/**
 * Data Stash session release — Server Only
 *
 * What a deleted conversation leaves behind: its documents, chunk records and
 * embedding space in Redis, and the session's claim in Postgres. Runs after the
 * conversation delete has committed and off the request path (`deleteSessions`
 * does not await it).
 *
 * The sessions passed in are the ones the deleter's own delete returned, so the
 * deleter owned each conversation row: the row is the authority, and the stash
 * is cleared whoever holds a claim on the id. Per session the stash is cleared
 * FIRST and the deleter's own claim dropped only if that fully succeeded; a
 * claim another user holds is never touched. A failed or partial clear keeps
 * the claim, so whatever is left stays attributed to the user who deleted the
 * conversation, and the failure is logged.
 *
 * Best-effort by contract: the conversation is already gone, so nothing here
 * is ever thrown.
 */

import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { deleteSessionStash } from '@hames-ai/harness-patterns/stash/document-ingest.server'
import { releaseSessionClaim } from '../db/session-claims.server'

assertServerOnImport()

/** Sessions released at once; a bulk delete is up to 200. */
export const RELEASE_CONCURRENCY = 4
/** After this long no further session is started; the rest keep their claims. */
export const RELEASE_DEADLINE_MS = 60_000

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function releaseOne(sessionId: string, userId: string): Promise<void> {
  try {
    await deleteSessionStash(sessionId)
    // Only reached when the clear fully succeeded. Scoped to `userId`: a claim
    // held by someone else stays.
    await releaseSessionClaim(sessionId, userId)
  } catch (err) {
    console.error(
      `[stash] could not clear the stash of deleted session ${sessionId}; its claim is kept:`,
      message(err),
    )
  }
}

/**
 * Release each session whose conversation `userId` just deleted (pass only the
 * ids that delete returned). Never throws.
 */
export async function releaseDeletedSessions(
  sessionIds: readonly string[],
  userId: string,
): Promise<void> {
  try {
    const queue = [...sessionIds]
    const deadline = Date.now() + RELEASE_DEADLINE_MS
    const worker = async () => {
      for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
        if (Date.now() > deadline) {
          console.error(
            `[stash] release deadline reached; ${queue.length + 1} deleted session(s) not cleared, claims kept`,
          )
          queue.length = 0
          return
        }
        await releaseOne(id, userId)
      }
    }
    await Promise.all(Array.from({ length: Math.min(RELEASE_CONCURRENCY, queue.length) }, worker))
  } catch (err) {
    console.error('[stash] session release failed:', message(err))
  }
}
