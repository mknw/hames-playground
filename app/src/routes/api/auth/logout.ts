/**
 * POST /api/auth/logout — end the session.
 *
 * Deletes the Postgres session row (server-side revocation), clears the cookie,
 * and redirects to Entra's sign-out so the IdP session is cleared too. Falls
 * back to the local sign-in page when Entra isn't configured (e.g. dev-bypass).
 *
 * A `POST` from the app's own pages only (#429). It used to be a `GET`, which
 * any site could send with the user's session — a link, a redirect, or an
 * `<img>` in a rendered answer — and sign them out while firing their
 * `session_end` routines at a moment of that site's choosing. A `GET` now
 * answers `405` and changes nothing. The sign-out control submits a form
 * (`AuthProvider.signOut`), so the browser follows the redirect in the tab.
 */
import type { APIEvent } from '@solidjs/start/server'
import { readCookie, SESSION_COOKIE, clearCookie } from '~/lib/auth/cookies.server'
import { deleteSession, getSession } from '~/lib/auth/session-store.server'
import { onSessionEnd } from '~/lib/routines/dispatch.server'
import { buildLogoutUrl } from '~/lib/auth/entra.server'
import { isEntraConfigured, buildEntraConfig } from '~/lib/auth/entra-config.server'
import { methodNotAllowed, refuseCrossSite } from '~/lib/auth/csrf.server'

export function GET(): Response {
  return methodNotAllowed('POST')
}

export async function POST(event: APIEvent): Promise<Response> {
  const refused = refuseCrossSite(event.request)
  if (refused) return refused

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

  // 303: the browser follows a POST's redirect with a GET.
  const headers = new Headers({ Location: location })
  headers.append('Set-Cookie', clearCookie(SESSION_COOKIE))
  return new Response(null, { status: 303, headers })
}
