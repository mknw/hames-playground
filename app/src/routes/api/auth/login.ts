/**
 * POST /api/auth/login — start the Entra OIDC auth-code flow.
 *
 * Generates PKCE + state + nonce, stashes them in a short-lived signed
 * handshake cookie, and 303s the browser to the Entra authorize endpoint.
 * `/api/auth/callback` completes the exchange.
 *
 * `?returnTo=` rides in the SAME signed payload, so a deep-linked conversation
 * survives the round trip. It is validated here rather than only at the
 * callback: the signature proves this app stamped the value, never that the
 * value was safe, and an attacker's way in is exactly a crafted link to this
 * route. `safeReturnTo` runs at both ends — see its header.
 *
 * A `POST` from the app's own sign-in page only (#429). As a `GET`, any site
 * could start the flow in the user's browser. The authorize URL asks for no
 * `prompt`, so Entra can complete it unattended for a user already signed in
 * there, and the callback then mints a session and fires that user's
 * `session_start` routines at a moment of that site's choosing. A `GET` now
 * lands on the sign-in page, which is where the `POST` comes from, and starts
 * nothing.
 */
import type { APIEvent } from '@solidjs/start/server'
import { isEntraConfigured, buildEntraConfig } from '~/lib/auth/entra-config.server'
import { generatePkce, newStateValue, buildAuthCodeUrl } from '~/lib/auth/entra.server'
import { signPayload } from '~/lib/auth/cookie-signing.server'
import { handshakeCookie } from '~/lib/auth/cookies.server'
import { safeReturnTo } from '~/lib/auth/return-to'
import { refuseCrossSite } from '~/lib/auth/csrf.server'

/** An old link or bookmark: show the sign-in page, keeping a safe `returnTo`. */
export function GET(event: APIEvent): Response {
  const returnTo = safeReturnTo(new URL(event.request.url).searchParams.get('returnTo'))
  const location =
    returnTo && returnTo !== '/'
      ? `/auth/signin?returnTo=${encodeURIComponent(returnTo)}`
      : '/auth/signin'
  return new Response(null, { status: 303, headers: { Location: location } })
}

export async function POST(event: APIEvent): Promise<Response> {
  const refused = refuseCrossSite(event.request)
  if (refused) return refused

  if (!isEntraConfigured()) {
    return new Response(
      'Entra SSO is not configured on this server. Set AZURE_TENANT_ID / ' +
        'AZURE_CLIENT_ID / AZURE_CLIENT_SECRET (see docs/deployment/entra-setup.md), ' +
        'or run dev with VITE_DEV_BYPASS_AUTH=true.',
      { status: 503, headers: { 'Content-Type': 'text/plain' } },
    )
  }

  try {
    const cfg = buildEntraConfig()
    const { verifier, challenge } = await generatePkce()
    const state = newStateValue()
    const nonce = newStateValue()
    // `null` rather than `'/'`: the callback substitutes the default, so only
    // one place decides what "no target" means.
    const returnTo = safeReturnTo(new URL(event.request.url).searchParams.get('returnTo'))
    const authUrl = await buildAuthCodeUrl({
      state,
      nonce,
      codeChallenge: challenge,
      cfg,
    })
    return new Response(null, {
      // 303: the browser follows a POST's redirect with a GET.
      status: 303,
      headers: {
        Location: authUrl,
        'Set-Cookie': handshakeCookie(
          signPayload(returnTo ? { state, verifier, nonce, returnTo } : { state, verifier, nonce }),
        ),
      },
    })
  } catch (err) {
    console.error('[auth/login] failed to start sign-in:', err)
    return new Response('Failed to start sign-in.', { status: 500 })
  }
}
