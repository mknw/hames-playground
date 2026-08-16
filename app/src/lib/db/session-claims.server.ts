/**
 * Session Claims Repository — Server Only
 *
 * Records which user owns a session id, for the window in which the
 * `conversations` row does not exist yet: a Data Stash upload can precede the
 * session's first persisted turn (a file dropped before the first message), so
 * ownership has to be recorded at first touch rather than inferred from the
 * conversation.
 *
 * Semantics:
 *   - First toucher wins. {@link claimSession} is a single atomic upsert whose
 *     `ON CONFLICT` only re-targets a row that is already the caller's (or has
 *     expired), so a concurrent claim by a second user returns the first user.
 *   - Claims expire. `expires_at` mirrors the Data Stash document TTL
 *     (`DEFAULT_TTL_SECONDS`), refreshed on every claim, so a claim outlives the
 *     documents it scopes but not indefinitely. Expired rows read as absent and
 *     are reused in place by the next claim.
 *
 * The `conversations` row is the long-lived ownership record; this table is the
 * bridge that covers the pre-persistence window. See
 * `lib/stash/ownership.server.ts` for how the two are combined.
 */

import { assertServerOnImport } from '../harness-patterns/assert.server'
import { query } from './client.server'

assertServerOnImport()

/** Owner of a live (non-expired) claim, or null when there is none. */
export async function getSessionClaimOwner(sessionId: string): Promise<string | null> {
  const { rows } = await query<{ user_id: string }>(
    'SELECT user_id FROM session_claims WHERE session_id = $1 AND expires_at > NOW()',
    [sessionId],
  )
  return rows.length > 0 ? rows[0].user_id : null
}

/**
 * Claim a session for `userId`, or return the user who already holds it.
 *
 * One statement, so concurrent first touches resolve deterministically: the
 * `DO UPDATE` fires only when the existing claim is the caller's (refresh the
 * TTL) or has expired (take it over). Any other conflict updates nothing and
 * `RETURNING` yields no row — we then read back the live holder.
 */
export async function claimSession(
  sessionId: string,
  userId: string,
  ttlSeconds: number,
): Promise<string> {
  const { rows } = await query<{ user_id: string }>(
    `INSERT INTO session_claims (session_id, user_id, expires_at)
     VALUES ($1, $2, NOW() + ($3::int * INTERVAL '1 second'))
     ON CONFLICT (session_id) DO UPDATE SET
       user_id    = EXCLUDED.user_id,
       expires_at = EXCLUDED.expires_at
     WHERE session_claims.user_id = EXCLUDED.user_id
        OR session_claims.expires_at <= NOW()
     RETURNING user_id`,
    [sessionId, userId, ttlSeconds],
  )
  if (rows.length > 0) return rows[0].user_id
  // The conflicting row belongs to someone else and is still live.
  return (await getSessionClaimOwner(sessionId)) ?? userId
}
