/**
 * GET /api/auth/login — start the Entra OIDC auth-code flow.
 *
 * Generates PKCE + state + nonce, stashes them in a short-lived signed
 * handshake cookie, and 302s the browser to the Entra authorize endpoint.
 * `/api/auth/callback` completes the exchange.
 */
import type { APIEvent } from '@solidjs/start/server'
import { isEntraConfigured, buildEntraConfig } from '~/lib/auth/entra-config.server'
import { generatePkce, newStateValue, buildAuthCodeUrl } from '~/lib/auth/entra.server'
import { signPayload } from '~/lib/auth/cookie-signing.server'
import { handshakeCookie } from '~/lib/auth/cookies.server'

export async function GET(_event: APIEvent): Promise<Response> {
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
    const authUrl = await buildAuthCodeUrl({
      state,
      nonce,
      codeChallenge: challenge,
      cfg,
    })
    return new Response(null, {
      status: 302,
      headers: {
        Location: authUrl,
        'Set-Cookie': handshakeCookie(signPayload({ state, verifier, nonce })),
      },
    })
  } catch (err) {
    console.error('[auth/login] failed to start sign-in:', err)
    return new Response('Failed to start sign-in.', { status: 500 })
  }
}
