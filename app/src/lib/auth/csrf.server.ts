/**
 * CSRF defences (#429) — Server Only.
 *
 * Two rules, and each export below enforces one of them:
 *
 * 1. **No state change on a `GET`.** The session cookie is `SameSite=Lax`
 *    (`cookies.server.ts`), and Lax is exactly the mode that still sends it on
 *    a cross-site top-level `GET`: a link in a mail, a redirect, `window.open`
 *    from any page. A `GET` that changes state can therefore be made by any
 *    site, with the user's session, at a moment that site chooses. Same-origin
 *    resource loads (`<img src>`) send it too, which is why the chat sanitizer
 *    refuses same-origin images.
 * 2. **A state-changing request comes from the app's own pages**, checked with
 *    {@link isSameOriginRequest} on every route that this issue moved off `GET`.
 *    A cross-site `POST` already arrives without the Lax cookie; what the check
 *    adds is the sibling origin, which `SameSite` counts as the same site.
 *
 * The cookie stays `Lax`. `Strict` would withhold it from every cross-site
 * navigation, including the redirect chain back from Entra and any link into
 * the app from mail or Teams, and neither rule above depends on it: once no
 * `GET` changes state, what a cross-site navigation carries does not matter.
 *
 * Failure policy: **fail closed.** A request that carries none of the three
 * provenance headers is refused. Every browser sends at least one of them on
 * the requests these routes serve (`Sec-Fetch-Site` everywhere current,
 * `Origin` on every `POST`), and nothing but a browser calls them.
 */
import type { FetchEvent } from '@solidjs/start/server'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'

assertServerOnImport()

/**
 * Whether the browser says this request came from a page on this origin.
 *
 * `Sec-Fetch-Site` decides when it is present: the browser sets it and a page
 * cannot, and `same-site` (a sibling subdomain) or `none` (a typed URL) is a
 * refusal. Without it, `Origin` — then `Referer` — must name this origin.
 * The origin compared against is the one the server sees, scheme included, so
 * it relies on the proxy forwarding `Host` and `X-Forwarded-Proto` (Caddy does
 * both by default). Only a browser too old to send `Sec-Fetch-Site` gets there.
 */
export function isSameOriginRequest(request: Request): boolean {
  const site = request.headers.get('sec-fetch-site')
  if (site !== null) return site === 'same-origin'

  const own = new URL(request.url).origin
  const origin = request.headers.get('origin')
  if (origin !== null) return origin === own

  const referer = request.headers.get('referer')
  if (referer === null) return false
  try {
    return new URL(referer).origin === own
  } catch {
    return false
  }
}

/**
 * The response a state-changing route returns to a request from anywhere but
 * the app's own pages, or `null` to proceed. Call it before authenticating, so
 * a refused request never reaches a session lookup either.
 */
export function refuseCrossSite(request: Request): Response | null {
  if (isSameOriginRequest(request)) return null
  return new Response('Cross-site request refused', {
    status: 403,
    headers: { 'Content-Type': 'text/plain' },
  })
}

/** `405` naming the one method a route accepts. */
export function methodNotAllowed(allow: string): Response {
  return new Response(`Method not allowed — use ${allow}`, {
    status: 405,
    headers: { Allow: allow, 'Content-Type': 'text/plain' },
  })
}

/**
 * The vinxi router that serves SolidStart's server functions. vinxi builds this
 * middleware once per router and defines `import.meta.env.ROUTER_NAME` in each
 * build, so the test below is a constant in every copy.
 */
export const SERVER_FUNCTION_ROUTER = 'server-fns'

/**
 * Middleware hook: refuse every `'use server'` call that is not a `POST`.
 *
 * SolidStart's handler answers `GET /_server?id=<fn>&name=…&args=<json>` too —
 * its no-JavaScript path — and runs the function with those arguments. The ids
 * are readable in the public client bundle, so every exported server function
 * was a `GET` any site could link to: `deleteConversationsBulk`,
 * `shareConversation`, `igniteVerdaBox`, the graph and skill edits. Each one's
 * `requireUser()` gate passed, because the cookie rode along. The app's own
 * client always `POST`s (`server-runtime.js`), and nothing here uses the
 * `.GET` form, so the only thing this refuses is the attack.
 *
 * **It decides by router, never by path.** h3 hands that router any request
 * whose percent-DECODED path merely starts with `/_server`, with no segment
 * boundary — `/_serverx`, `/_server.js`, `/%5Fserver`, `/_server%2F` — while
 * the request URL a hook sees is the raw one. A path test therefore has to
 * re-implement h3's matcher exactly, and the first version of this hook did
 * not: it refused `/_server` and `/_server/…` and let every variant above run
 * its function (#451 review). The router's own name has no such gap: if this
 * copy of the middleware runs, the server-function handler is next.
 */
export function refuseServerFunctionGet(event: Pick<FetchEvent, 'request'>): Response | undefined {
  if (event.request.method === 'POST') return undefined
  if (import.meta.env.ROUTER_NAME !== SERVER_FUNCTION_ROUTER) return undefined
  return methodNotAllowed('POST')
}
