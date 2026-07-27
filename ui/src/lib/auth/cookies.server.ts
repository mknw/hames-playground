/**
 * Auth cookie plumbing — Server Only.
 *
 * Cookie names + parse/serialize helpers shared by the `/api/auth/*` routes
 * and the server-side session read (`session.ts`). Uses plain Web `Request`
 * headers + `Set-Cookie` strings to stay consistent with the existing API
 * routes (`routes/api/agents/[id].ts` et al.), no framework cookie API.
 */
import { assertServerOnImport } from "../harness-patterns/assert.server";

assertServerOnImport();

/** Durable session id (opaque; row lives in `auth_sessions`). */
export const SESSION_COOKIE = "kg_session";
/** Short-lived OAuth handshake state (signed: state + PKCE verifier + nonce). */
export const HANDSHAKE_COOKIE = "kg_auth_state";
/** Handshake lifetime — a sign-in round-trip should complete well within this. */
export const HANDSHAKE_MAX_AGE_SECONDS = 600;

interface CookieAttrs {
  maxAgeSeconds?: number;
  /** Omit to leave it a session cookie (cleared on browser close). */
  path?: string;
  sameSite?: "Lax" | "Strict" | "None";
  httpOnly?: boolean;
  secure?: boolean;
}

/** Secure flag only in production — dev runs over http://localhost. */
function isProd(): boolean {
  return process.env.NODE_ENV === "production";
}

/** Parse a `Cookie` header into a name→value map. */
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return out;
}

/** Read a single cookie from a request. */
export function readCookie(request: Request, name: string): string | null {
  return parseCookies(request.headers.get("cookie"))[name] ?? null;
}

/** Serialize a `Set-Cookie` header value. */
export function serializeCookie(
  name: string,
  value: string,
  attrs: CookieAttrs = {},
): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${attrs.path ?? "/"}`);
  parts.push(`SameSite=${attrs.sameSite ?? "Lax"}`);
  if (attrs.httpOnly ?? true) parts.push("HttpOnly");
  if (attrs.secure ?? isProd()) parts.push("Secure");
  if (typeof attrs.maxAgeSeconds === "number") {
    parts.push(`Max-Age=${attrs.maxAgeSeconds}`);
  }
  return parts.join("; ");
}

/** `Set-Cookie` value that sets the durable session cookie. */
export function sessionCookie(id: string, maxAgeSeconds: number): string {
  return serializeCookie(SESSION_COOKIE, id, {
    maxAgeSeconds,
    httpOnly: true,
    sameSite: "Lax",
  });
}

/** `Set-Cookie` value that sets the short-lived handshake cookie. */
export function handshakeCookie(signed: string): string {
  return serializeCookie(HANDSHAKE_COOKIE, signed, {
    maxAgeSeconds: HANDSHAKE_MAX_AGE_SECONDS,
    httpOnly: true,
    sameSite: "Lax",
  });
}

/** `Set-Cookie` value that clears a cookie (Max-Age=0). */
export function clearCookie(name: string): string {
  return serializeCookie(name, "", { maxAgeSeconds: 0, httpOnly: true });
}
