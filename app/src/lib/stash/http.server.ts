/**
 * Data Stash HTTP helpers — Server Only
 *
 * Shared auth + response helpers for the Data Stash routes
 * (`/api/stash/upload`, `/api/stash/document/:id`, `/api/stash/search`,
 * `/api/stash/ingest`). Mirrors the auth posture of the existing
 * `routes/api/stash.ts` (dev-bypass aware) so every stash path gates the same
 * way: authenticate the caller, then check that the session it names is theirs.
 *
 * The sandbox PTY routes (`/api/sandbox/pty/*`) gate on the same helpers —
 * a session's terminal and its stash share one ownership record, so the two
 * surfaces cannot disagree about who a session belongs to.
 */

import { assertServerOnImport } from '../harness-patterns/assert.server'
import { getAuthenticatedUser } from '../auth/server'
import { BYPASS_USER, isBypassEnabled } from '../auth/dev-bypass'
import { claimSessionOwnership, userOwnsSession } from './ownership.server'

assertServerOnImport()

/** Resolve the current user id, honouring the dev-bypass switch. */
export async function requireUserId(): Promise<string> {
  if (isBypassEnabled()) return BYPASS_USER.id
  return (await getAuthenticatedUser()).id
}

/** JSON response with the right content-type. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

/**
 * Run a handler with an authenticated user id, returning a 401 JSON response
 * if authentication fails. Keeps each route handler free of the try/catch
 * auth boilerplate.
 *
 * Authentication only — every handler must additionally gate on the session it
 * names, via {@link requireSessionOwner} (reads) or {@link claimSession}
 * (writes). See `lib/stash/ownership.server.ts`.
 */
export async function withUser(fn: (userId: string) => Promise<Response>): Promise<Response> {
  let userId: string
  try {
    userId = await requireUserId()
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : 'Unauthorized' }, 401)
  }
  return fn(userId)
}

/**
 * The response a stash route returns for a session that is not the caller's.
 * Deliberately the same 404 a genuinely absent session gets, so the two cases
 * are indistinguishable from outside.
 */
export function sessionNotFound(): Response {
  return json({ error: 'Session not found' }, 404)
}

/**
 * Read gate: resolve to `null` when `userId` owns the session, or to the 404
 * response the route should return instead. Usage:
 *
 * ```ts
 * const denied = await requireSessionOwner(sessionId, userId)
 * if (denied) return denied
 * ```
 */
export async function requireSessionOwner(
  sessionId: string,
  userId: string,
): Promise<Response | null> {
  return (await userOwnsSession(sessionId, userId)) ? null : sessionNotFound()
}

/**
 * Write gate: record the caller as the session's owner if it is unclaimed,
 * then apply the same rule as {@link requireSessionOwner}. This is what makes
 * an upload for a not-yet-persisted session legal — it establishes the
 * ownership that later reads are checked against.
 */
export async function claimSession(sessionId: string, userId: string): Promise<Response | null> {
  return (await claimSessionOwnership(sessionId, userId)) ? null : sessionNotFound()
}
