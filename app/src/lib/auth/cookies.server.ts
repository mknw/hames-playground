/**
 * Auth cookie plumbing — Server Only.
 *
 * Cookie names + parse/serialize helpers shared by the `/api/auth/*` routes
 * and the server-side session read (`session.ts`). Uses plain Web `Request`
 * headers + `Set-Cookie` strings to stay consistent with the existing API
 * routes (`routes/api/agents/[id].ts` et al.), no framework cookie API.
 */
import { assertServerOnImport } from '../harness-patterns/assert.server'

assertServerOnImport()

/** Durable session id (opaque; row lives in `auth_sessions`). */
export const SESSION_COOKIE = 'kg_session'
/** Short-lived OAuth handshake state (signed: state + PKCE verifier + nonce). */
export const HANDSHAKE_COOKIE = 'kg_auth_state'
/** Handshake lifetime — a sign-in round-trip should complete well within this. */
export const HANDSHAKE_MAX_AGE_SECONDS = 600

interface CookieAttrs {
  maxAgeSeconds?: number
  /** Omit to leave it a session cookie (cleared on browser close). */
  path?: string
  sameSite?: 'Lax' | 'Strict' | 'None'
  httpOnly?: boolean
  secure?: boolean
}

/**
 * Secure flag — set unless this is the dev server, which runs over
 * http://localhost and could not accept a `Secure` cookie.
 *
 * Deliberately NOT `NODE_ENV === 'production'`. `vinxi start` — the systemd
 * path in `docs/deployment/azure-vm.md` §6, and the one with mileage — sets
 * `PORT`, `HOST` and `SERVER_PRESET` and nothing else (`vinxi/bin/cli.mjs`,
 * the `start` command; only `build` sets `NODE_ENV`), and that unit file
 * passes no `NODE_ENV` either. So the host deployment ran with it unset and
 * issued `kg_session` WITHOUT `Secure` behind Caddy's TLS: the browser then
 * also sends the session cookie on the plaintext `http://` request Caddy is
 * about to redirect, which is the one hop an attacker on the network can read.
 *
 * `import.meta.env.DEV` is statically replaced with `false` in a production
 * bundle, so the flag is present there whatever the process environment says —
 * the same structural guarantee `dev-bypass.ts` relies on to make the auth
 * bypass unreachable from a prod build.
 */
function isDevServer(): boolean {
  return import.meta.env.DEV === true
}

/** Parse a `Cookie` header into a name→value map. */
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const name = part.slice(0, eq).trim()
    if (!name) continue
    out[name] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}

/** Read a single cookie from a request. */
export function readCookie(request: Request, name: string): string | null {
  return parseCookies(request.headers.get('cookie'))[name] ?? null
}

/** Serialize a `Set-Cookie` header value. */
export function serializeCookie(name: string, value: string, attrs: CookieAttrs = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`]
  parts.push(`Path=${attrs.path ?? '/'}`)
  parts.push(`SameSite=${attrs.sameSite ?? 'Lax'}`)
  if (attrs.httpOnly ?? true) parts.push('HttpOnly')
  if (attrs.secure ?? !isDevServer()) parts.push('Secure')
  if (typeof attrs.maxAgeSeconds === 'number') {
    parts.push(`Max-Age=${attrs.maxAgeSeconds}`)
  }
  return parts.join('; ')
}

/** `Set-Cookie` value that sets the durable session cookie. */
export function sessionCookie(id: string, maxAgeSeconds: number): string {
  return serializeCookie(SESSION_COOKIE, id, {
    maxAgeSeconds,
    httpOnly: true,
    sameSite: 'Lax',
  })
}

/** `Set-Cookie` value that sets the short-lived handshake cookie. */
export function handshakeCookie(signed: string): string {
  return serializeCookie(HANDSHAKE_COOKIE, signed, {
    maxAgeSeconds: HANDSHAKE_MAX_AGE_SECONDS,
    httpOnly: true,
    sameSite: 'Lax',
  })
}

/** `Set-Cookie` value that clears a cookie (Max-Age=0). */
export function clearCookie(name: string): string {
  return serializeCookie(name, '', { maxAgeSeconds: 0, httpOnly: true })
}
