/**
 * GET /api/auth/logout — end the session.
 *
 * Deletes the Postgres session row (server-side revocation), clears the cookie,
 * and redirects to Entra's sign-out so the IdP session is cleared too. Falls
 * back to the local sign-in page when Entra isn't configured (e.g. dev-bypass).
 */
import type { APIEvent } from '@solidjs/start/server'
import { readCookie, SESSION_COOKIE, clearCookie } from '~/lib/auth/cookies.server'
import { deleteSession, getSession } from '~/lib/auth/session-store.server'
import { onSessionEnd } from '~/lib/routines/dispatch.server'
import { buildLogoutUrl } from '~/lib/auth/entra.server'
import { isEntraConfigured, buildEntraConfig } from '~/lib/auth/entra-config.server'

export async function GET(event: APIEvent): Promise<Response> {
  const sessionId = readCookie(event.request, SESSION_COOKIE)
  if (sessionId) {
    // Resolve the owner BEFORE deleting the row — afterwards there's nothing
    // left to map the opaque cookie back to a user. A failed lookup (expired,
    // unknown, DB down) just means no `session_end` routines fire; sign-out
    // itself proceeds regardless.
    const userId = await getSession(sessionId)
      .then((s) => s?.userId ?? null)
      .catch(() => null)

    await deleteSession(sessionId).catch((err) =>
      console.error('[auth/logout] failed to delete session:', err),
    )

    // The session is gone: this is `session_end` (#131). Fire-and-forget.
    if (userId) onSessionEnd(userId)
  }

  let location = '/auth/signin'
  if (isEntraConfigured()) {
    try {
      location = buildLogoutUrl(buildEntraConfig())
    } catch (err) {
      console.error('[auth/logout] could not build Entra logout URL:', err)
    }
  }

  return new Response(null, {
    status: 302,
    headers: (() => {
      const h = new Headers({ Location: location })
      h.append('Set-Cookie', clearCookie(SESSION_COOKIE))
      return h
    })(),
  })
}
