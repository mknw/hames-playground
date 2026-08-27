/**
 * GET /api/auth/callback — Entra OIDC redirect endpoint.
 *
 * Validates the `state` against the signed handshake cookie, redeems the
 * authorization code (PKCE), enforces the email allow-list, mints a Postgres
 * session, and sets the session cookie. On any failure the browser is sent
 * back to sign-in / access-denied with the handshake cookie cleared — no
 * session is minted.
 */
import type { APIEvent } from '@solidjs/start/server'
import { buildEntraConfig } from '~/lib/auth/entra-config.server'
import { redeemAuthCode } from '~/lib/auth/entra.server'
import { verifyPayload } from '~/lib/auth/cookie-signing.server'
import { readCookie, HANDSHAKE_COOKIE, sessionCookie, clearCookie } from '~/lib/auth/cookies.server'
import { createSession, DEFAULT_SESSION_TTL_SECONDS } from '~/lib/auth/session-store.server'
import { upsertUser } from '~/lib/auth/users.server'
import { saveUserTokenCache } from '~/lib/auth/user-tokens.server'
import { isEmailAllowed } from '~/lib/auth/allowList'
import { onSessionStart } from '~/lib/routines/dispatch.server'
import { safeReturnTo } from '~/lib/auth/return-to'

interface Handshake {
  state: string
  verifier: string
  nonce: string
  /** Where to land after a successful sign-in (`/api/auth/login?returnTo=`).
   *  Absent on an ordinary sign-in; validated again below whatever it says. */
  returnTo?: string
}

function redirect(location: string, ...cookies: string[]): Response {
  const headers = new Headers({ Location: location })
  for (const c of cookies) headers.append('Set-Cookie', c)
  return new Response(null, { status: 302, headers })
}

export async function GET(event: APIEvent): Promise<Response> {
  const params = new URL(event.request.url).searchParams

  const oauthError = params.get('error')
  if (oauthError) {
    console.warn(
      '[auth/callback] Entra returned an error:',
      params.get('error_description') || oauthError,
    )
    return redirect('/auth/signin', clearCookie(HANDSHAKE_COOKIE))
  }

  const code = params.get('code')
  const state = params.get('state')
  if (!code || !state) {
    return redirect('/auth/signin', clearCookie(HANDSHAKE_COOKIE))
  }

  const handshake = verifyPayload<Handshake>(readCookie(event.request, HANDSHAKE_COOKIE))
  // verifyPayload also enforces the handshake's age (#129), so a cookie whose
  // signed payload is older than SIGNED_PAYLOAD_MAX_AGE_MS lands here too.
  if (!handshake || handshake.state !== state) {
    console.warn('[auth/callback] handshake cookie missing, expired, or state mismatch.')
    return redirect('/auth/signin', clearCookie(HANDSHAKE_COOKIE))
  }

  try {
    const cfg = buildEntraConfig()
    const { identity, homeAccountId, tokenCache } = await redeemAuthCode({
      code,
      codeVerifier: handshake.verifier,
      nonce: handshake.nonce,
      cfg,
    })

    // Same access policy as the legacy flow: unlisted emails never get a session.
    if (!isEmailAllowed(identity.email)) {
      console.warn('[auth/callback] email not in allow-list:', identity.email)
      return redirect('/auth/access-denied', clearCookie(HANDSHAKE_COOKIE))
    }

    // Record the sign-in (first/last_login + profile snapshot). Same DB as the
    // session insert below, so no separate failure handling: if Postgres is
    // down, sign-in fails either way and the catch sends us back to signin.
    await upsertUser({
      id: identity.userId,
      email: identity.email,
      displayName: identity.displayName,
      tenantId: identity.tenantId,
    })

    // Persist the MSAL cache per-user (encrypted) so Graph can be called as
    // this user later — including from runs with no live session (#110).
    await saveUserTokenCache(identity.userId, tokenCache, homeAccountId)

    const sessionId = await createSession({
      userId: identity.userId,
      email: identity.email,
      displayName: identity.displayName,
      homeAccountId,
    })

    // The session now exists: this is `session_start` (#131). Fire-and-forget
    // by construction — the redirect must not wait on a harness run, and a
    // routine failure must never cost the user their sign-in.
    onSessionStart(identity.userId)

    // Re-validated rather than trusted: the payload is signed, which proves
    // this app stamped it and says nothing about whether the value was ever a
    // safe redirect target. `/` is the default for absent, malformed and
    // off-origin alike (`lib/auth/return-to.ts`).
    return redirect(
      safeReturnTo(handshake.returnTo) ?? '/',
      sessionCookie(sessionId, DEFAULT_SESSION_TTL_SECONDS),
      clearCookie(HANDSHAKE_COOKIE),
    )
  } catch (err) {
    console.error('[auth/callback] code redemption failed:', err)
    return redirect('/auth/signin', clearCookie(HANDSHAKE_COOKIE))
  }
}
