/**
 * Signed-cookie helpers — Server Only.
 *
 * HMAC-SHA256 sign/verify for small, tamper-evident cookie payloads, plus an
 * opaque-id generator. Used for the short-lived OAuth handshake cookie (state
 * + PKCE verifier + nonce) that bridges `/api/auth/login` → `/api/auth/callback`
 * and for minting the durable session id stored in Postgres.
 *
 * The durable session itself is a Postgres row (see `session-store.server.ts`);
 * the cookie only carries the opaque row id. The handshake cookie is signed
 * (not encrypted) — state/nonce/verifier are not secrets, they only need to be
 * unforgeable so an attacker can't inject a chosen `state`/`code_verifier`.
 *
 * Payloads carry an `iat` (issued-at, epoch ms) stamped at sign time, and
 * `verifyPayload` rejects anything older than {@link SIGNED_PAYLOAD_MAX_AGE_MS}
 * (#129). Without it the signature alone stayed valid forever, so the cookie's
 * `Max-Age` — which only the browser enforces — was the sole bound on how long
 * a handshake value remained usable. Server-side the two now agree.
 */
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto'
import { assertServerOnImport } from '../harness-patterns/assert.server'
import { HANDSHAKE_MAX_AGE_SECONDS } from './cookies.server'

assertServerOnImport()

/**
 * Server-side validity window for a signed payload. Mirrors the handshake
 * cookie's `Max-Age` so the browser-enforced and server-enforced lifetimes are
 * the same 10 minutes — a sign-in round-trip completes well inside it.
 */
export const SIGNED_PAYLOAD_MAX_AGE_MS = HANDSHAKE_MAX_AGE_SECONDS * 1000

function defaultSecret(): string {
  const s = process.env.AUTH_SESSION_SECRET?.trim()
  if (!s) {
    throw new Error(
      '[auth] AUTH_SESSION_SECRET is not set — required to sign auth cookies. ' +
        'Generate one with `openssl rand -base64 32` (see docs/deployment/entra-setup.md).',
    )
  }
  return s
}

/**
 * Sign a JSON-serializable payload → `"<base64url(json)>.<base64url(hmac)>"`.
 * An `iat` (epoch ms) is added to the payload so {@link verifyPayload} can bound
 * its lifetime; a caller-supplied `iat` is overwritten. `key` is injectable for
 * tests; production callers omit it.
 */
export function signPayload(
  payload: Record<string, unknown>,
  key: string = defaultSecret(),
): string {
  const stamped: Record<string, unknown> = { ...payload, iat: Date.now() }
  const body = Buffer.from(JSON.stringify(stamped)).toString('base64url')
  const sig = createHmac('sha256', key).update(body).digest('base64url')
  return `${body}.${sig}`
}

/**
 * Verify + parse a token produced by {@link signPayload}. Returns the payload,
 * or `null` on any tampering / malformed input / bad signature. Uses a
 * constant-time comparison so signature checks don't leak via timing.
 *
 * Also rejects a payload whose `iat` is missing or older than `maxAgeMs`
 * (default {@link SIGNED_PAYLOAD_MAX_AGE_MS}). Fails closed on a missing `iat`:
 * tokens minted before #129 are unsigned-for-age and are not honoured, which at
 * worst asks an in-flight sign-in to start over once, right after a deploy.
 */
export function verifyPayload<T = unknown>(
  token: string | null | undefined,
  key: string = defaultSecret(),
  maxAgeMs: number = SIGNED_PAYLOAD_MAX_AGE_MS,
): T | null {
  if (!token) return null
  const dot = token.lastIndexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const body = token.slice(0, dot)
  const provided = token.slice(dot + 1)
  const expected = createHmac('sha256', key).update(body).digest('base64url')

  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return null
  }

  const iat = (parsed as { iat?: unknown } | null)?.iat
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return null
  if (Date.now() - iat > maxAgeMs) return null

  return parsed as T
}

/** Cryptographically-random opaque id (default 256 bits), URL-safe. */
export function newOpaqueId(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}
