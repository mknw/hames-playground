/**
 * Where sign-in is allowed to send you afterwards.
 *
 * Deep-linked conversation URLs (`/?c=…`) made this necessary: an
 * unauthenticated hit on a link a colleague sent has to survive the Entra round
 * trip and land on the conversation, not on the app's front page. The value
 * therefore travels from the browser, through `/api/auth/login`, into the
 * signed handshake cookie, and back out in `/api/auth/callback`'s `Location`
 * header.
 *
 * That is a redirect target chosen by whoever wrote the URL, which makes it an
 * **open-redirect hole unless it is validated** — and being carried in a signed
 * cookie does not validate it. The signature proves *we* stamped the value, not
 * that the value was ever safe: an attacker mints one by sending a victim to
 * `/api/auth/login?returnTo=https://evil.example`, and the app signs it on the
 * way past. So the check runs on the way IN (login) and again on the way OUT
 * (callback), and it is this function both times.
 *
 * Client-safe and dependency-free: the same rule has to be applied by a server
 * route and describable by a unit test, and a second copy of it is how the two
 * ends come to disagree.
 */

/**
 * Longest `returnTo` accepted. Comfortably past `/?c=<uuid>` (40 characters)
 * and short enough that nothing interesting fits in the part we would have to
 * reason about. A cap rather than an exact grammar because the app's own routes
 * will grow parameters, and an over-precise rule here would reject them.
 */
const MAX_RETURN_TO_LENGTH = 512

/**
 * Reduce a caller-supplied `returnTo` to a same-origin path, or `null`.
 *
 * Accepted: a path on this app — one leading `/`, then anything printable.
 *
 * Rejected, each for its own reason:
 *   - anything not starting with `/` — an absolute URL, `javascript:`, a bare
 *     hostname the browser would resolve as a relative path on some other page;
 *   - `//host` and `/\host` — protocol-relative URLs, which browsers follow
 *     off-origin while looking like paths. This is the case a naive
 *     `startsWith('/')` misses, and it is the whole reason this function is not
 *     one line;
 *   - control characters, including CR and LF — the redirect goes into a
 *     `Location` header, and a newline in a header value is response splitting;
 *   - anything over {@link MAX_RETURN_TO_LENGTH};
 *   - `/api/…` — the app's own RPC and auth endpoints are not pages, and
 *     `/api/auth/login` in particular would make sign-in loop.
 *
 * The caller substitutes `/` for `null`. There is deliberately no "trusted
 * hosts" escape hatch: nothing in this app needs to send a freshly
 * authenticated browser to another origin.
 */
export function safeReturnTo(value: unknown): string | null {
  if (typeof value !== 'string') return null
  if (value.length === 0 || value.length > MAX_RETURN_TO_LENGTH) return null
  if (value[0] !== '/') return null
  // Protocol-relative: `//evil.example` and the backslash form browsers also
  // normalise to it.
  if (value[1] === '/' || value[1] === '\\') return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return null
  if (value === '/api' || value.startsWith('/api/')) return null
  return value
}
