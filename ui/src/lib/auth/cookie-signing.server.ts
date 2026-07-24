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
 */
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { assertServerOnImport } from "../harness-patterns/assert.server";

assertServerOnImport();

function defaultSecret(): string {
  const s = process.env.AUTH_SESSION_SECRET?.trim();
  if (!s) {
    throw new Error(
      "[auth] AUTH_SESSION_SECRET is not set — required to sign auth cookies. " +
        "Generate one with `openssl rand -base64 32` (see docs/deploy/entra-setup.md).",
    );
  }
  return s;
}

/**
 * Sign a JSON-serializable payload → `"<base64url(json)>.<base64url(hmac)>"`.
 * `key` is injectable for tests; production callers omit it.
 */
export function signPayload(payload: unknown, key: string = defaultSecret()): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", key).update(body).digest("base64url");
  return `${body}.${sig}`;
}

/**
 * Verify + parse a token produced by {@link signPayload}. Returns the payload,
 * or `null` on any tampering / malformed input / bad signature. Uses a
 * constant-time comparison so signature checks don't leak via timing.
 */
export function verifyPayload<T = unknown>(
  token: string | null | undefined,
  key: string = defaultSecret(),
): T | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = createHmac("sha256", key).update(body).digest("base64url");

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

/** Cryptographically-random opaque id (default 256 bits), URL-safe. */
export function newOpaqueId(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}
