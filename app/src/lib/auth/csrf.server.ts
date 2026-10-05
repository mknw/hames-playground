/**
 * CSRF defences (#429, #455) — Server Only.
 *
 * Two rules, and the exports below enforce them:
 *
 * 1. **No state change on a `GET`.** The session cookie is `SameSite=Lax`
 *    (`cookies.server.ts`), and Lax is exactly the mode that still sends it on
 *    a cross-site top-level `GET`: a link in a mail, a redirect, `window.open`
 *    from any page. A `GET` that changes state can therefore be made by any
 *    site, with the user's session, at a moment that site chooses. Same-origin
 *    resource loads (`<img src>`) send it too, which is why the chat sanitizer
 *    refuses same-origin images. {@link refuseServerFunctionGet} closes it for
 *    `'use server'` functions; the routes close it by declaring no `GET` that
 *    writes.
 * 2. **A state-changing request comes from the app's own pages.** Since #455
 *    this is ONE middleware hook, {@link refuseCrossOriginStateChange}, run in
 *    front of every route in both routers: every API route and SolidStart's
 *    server-function handler (`/_server`), on every method but `GET`, `HEAD`
 *    and `OPTIONS`. A cross-site `POST` already arrives without the Lax cookie.
 *    What the check adds is the **sibling origin** — another app under the
 *    same registrable domain, or a compromised one — which `SameSite` counts
 *    as the same site and so sends the cookie from. Before #455 only the three
 *    routes #429 touched checked; `/api/events`, the stash, routines, the
 *    terminal's input and every server function did not.
 *
 * The cookie stays `Lax`. `Strict` would withhold it from every cross-site
 * navigation, including the redirect chain back from Entra and any link into
 * the app from mail or Teams, and neither rule above depends on it: once no
 * `GET` changes state, what a cross-site navigation carries does not matter.
 *
 * ## "The app's own pages" is a configured origin, never the request's `Host`
 *
 * Every check compares `Origin` (else `Referer`) with {@link resolveAppOrigin}:
 * the origin of `AUTH_REDIRECT_URI`. That variable is already where the app
 * learns its public URL, and it names the right thing by construction: the
 * OIDC callback it points at is what sets `kg_session`, host-only, so its
 * origin is the one origin whose pages hold the session at all. One variable
 * for one fact, so the sign-in host and the write check cannot disagree.
 *
 * `Host` (and `X-Forwarded-Host`) is not compared, because the request being
 * judged must not be the one that says who the server is. The case that makes
 * it concrete is DNS rebinding: a page on `rebound.example` whose name was
 * pointed at the server sends `Host`, `Origin` and `Sec-Fetch-Site` that all
 * agree it is "same origin". Against a production host it gains nothing — the
 * cookie is scoped to the real name, and the proxy only routes that name — but
 * a dev server runs the auth bypass (`dev-bypass.ts`, SD-15), where every
 * request is authenticated with no cookie at all, so a Host comparison there
 * hands any web page the developer's whole app. The same reasoning is why
 * `Sec-Fetch-Site: same-origin` is a veto and no longer a pass on its own.
 *
 * A dev build also accepts {@link DEV_ORIGIN_HOSTS} — `localhost`, `127.0.0.1`,
 * `[::1]`, `host.docker.internal` — on the configured origin's scheme and port,
 * because one origin cannot serve a developer's own tab and Playwright MCP
 * (through the docker host alias) at once. The list is fixed in source, no
 * variable widens it, and a production build ignores it entirely
 * ({@link acceptedOrigins}). It is safe where it applies: no page is served
 * from those names on that port but the dev server's own, and vite already
 * answers a rebound `Host` with its own 403 before this hook runs.
 *
 * The check depends on the page's **referrer policy**. The app's own native
 * form `POST`s (sign-in, sign-out) carry their real `Origin`, and the
 * terminal's `EventSource` its `Referer`, only under a policy that keeps them
 * on same-origin requests — the browser default and Caddy's
 * `strict-origin-when-cross-origin`. Under `no-referrer` the forms send
 * `Origin: null` and the stream sends neither, and all three get a 403.
 * `security-headers.test.ts` pins the Caddyfile against that value.
 *
 * ## Who is exempt: no browser provenance and no session cookie
 *
 * CSRF needs a browser to attach a credential the attacker does not hold. The
 * only ambient credential this app honours is the `kg_session` cookie (the
 * bypass aside — see below). So a request that carries no session cookie and
 * none of `Origin`, `Referer` or `Sec-Fetch-Site` is let through untouched,
 * and the route's own authentication decides. That is how the agent-trigger
 * endpoint (`POST /api/agents/:id`) keeps working: its callers are devices
 * presenting a bearer secret, and their HTTP clients send none of the three
 * (Node's `fetch` sends `Sec-Fetch-Mode` and nothing else).
 *
 * The exemption is two conditions, not one, so that it never has to consult
 * the bypass. "No cookie" alone would wave through every request a dev server
 * authenticates by bypass, including a DNS-rebound page's. "No provenance"
 * alone would wave through a cookie-bearing request from a browser old enough
 * to omit `Origin`. Every current browser sends `Origin` on every non-`GET`
 * request, so a request that names an origin is judged however it
 * authenticates — a token caller that sends a foreign `Origin` is refused.
 *
 * Failure policy: **fail closed.** A request with a session cookie and no
 * `Origin` or `Referer` is refused: no current browser sends one, and no
 * caller of this app is a script holding a copied cookie. A production build
 * whose `AUTH_REDIRECT_URI` is unset or not an `http(s)` URL **does not boot**
 * ({@link assertAppOriginConfigured}, decision B of the #467 review): serving
 * 403s while `/api/health` answers 200 would pass every healthcheck and
 * deploy gate and tell only the first user to click. `DATA_ENCRYPTION_KEY` is
 * the precedent. Sign-in is broken in that state anyway, since the redirect
 * falls back to localhost.
 */
import type { FetchEvent } from '@solidjs/start/server'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { readCookie, SESSION_COOKIE } from './cookies.server'

assertServerOnImport()

/** The variable the app's public origin is read from. */
export const APP_ORIGIN_ENV = 'AUTH_REDIRECT_URI'

/**
 * The public origin a dev build assumes when {@link APP_ORIGIN_ENV} is unset:
 * `pnpm dev`'s own address, which is also the origin of the OIDC redirect's
 * dev default (`entra-config.server.ts`; a test pins the two together).
 * {@link DEV_ORIGIN_HOSTS} cover the other loopback names on the same port;
 * any other name or port — the browser e2e suite's, say — means setting the
 * variable to that address.
 */
export const DEV_APP_ORIGIN = 'http://localhost:3444'

/**
 * The host names a DEV build accepts besides the configured origin's own, each
 * on the configured origin's scheme and port. Fixed here and frozen: no
 * environment variable widens it, and a production build never consults it.
 */
export const DEV_ORIGIN_HOSTS = Object.freeze([
  'localhost',
  '127.0.0.1',
  '[::1]',
  'host.docker.internal',
] as const)

/**
 * The origin this app's pages are served from, or `null` when it cannot be
 * known — which every check treats as "refuse".
 *
 * The origin of `AUTH_REDIRECT_URI`, serialised the way a browser serialises
 * `Origin` (lower-case host, default port dropped). Unset, a dev build falls
 * back to {@link DEV_APP_ORIGIN} and a production build gets `null`. A value
 * that is set but is not an `http(s)` URL is `null` in both, rather than the
 * default: a typo should fail loudly, not quietly widen to localhost.
 */
export function resolveAppOrigin(
  env: Record<string, string | undefined> = process.env,
  dev: boolean = import.meta.env.DEV === true,
): string | null {
  const raw = env[APP_ORIGIN_ENV]?.trim()
  if (!raw) return dev ? DEV_APP_ORIGIN : null
  try {
    const url = new URL(raw)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null
  } catch {
    return null
  }
}

/**
 * The origins whose pages may write: the configured one, plus — in a dev build
 * only — {@link DEV_ORIGIN_HOSTS} on its scheme and port. Empty when the
 * origin is unknown, which every check treats as "refuse".
 */
export function acceptedOrigins(
  appOrigin: string | null,
  dev: boolean = import.meta.env.DEV === true,
): ReadonlySet<string> {
  if (appOrigin === null) return new Set()
  if (!dev) return new Set([appOrigin])
  const { protocol, port } = new URL(appOrigin)
  const onPort = port ? `:${port}` : ''
  return new Set([appOrigin, ...DEV_ORIGIN_HOSTS.map((host) => `${protocol}//${host}${onPort}`)])
}

/**
 * Refuse to boot a production build that does not know its public origin.
 *
 * Runs at module load, which is server boot: the middleware imports this
 * module before any request is served. The line goes to the log first, so the
 * operator gets one named sentence whatever the runtime then does with the
 * uncaught error. A dev build never throws: it has {@link DEV_APP_ORIGIN}.
 */
export function assertAppOriginConfigured(
  env: Record<string, string | undefined> = process.env,
  dev: boolean = import.meta.env.DEV === true,
  log: (message: string) => void = console.error,
): void {
  if (dev || resolveAppOrigin(env, dev) !== null) return
  const message =
    `[csrf] ${APP_ORIGIN_ENV} is unset or not an http(s) URL, so this server does not know ` +
    `its public origin and refuses to boot: it could not tell the app's own pages from any ` +
    `other site's. Set it to https://<public host>/api/auth/callback.`
  log(message)
  throw new Error(message)
}

assertAppOriginConfigured()

/**
 * Whether the browser says this request came from a page on `appOrigin`.
 *
 * `Sec-Fetch-Site` vetoes when present: the browser sets it and a page cannot,
 * and `same-site` (a sibling subdomain), `cross-site` and `none` (a typed URL)
 * are refusals. It never admits on its own — see the module header on DNS
 * rebinding. `Origin`, then `Referer`, must name one of
 * {@link acceptedOrigins} exactly; a request with neither is refused, as is
 * every request when `appOrigin` is `null`.
 */
export function isSameOriginRequest(
  request: Request,
  appOrigin: string | null = resolveAppOrigin(),
  dev: boolean = import.meta.env.DEV === true,
): boolean {
  const site = request.headers.get('sec-fetch-site')
  if (site !== null && site !== 'same-origin') return false
  const accepted = acceptedOrigins(appOrigin, dev)
  if (accepted.size === 0) return false

  const origin = request.headers.get('origin')
  if (origin !== null) return accepted.has(origin)

  const referer = request.headers.get('referer')
  if (referer === null) return false
  try {
    return accepted.has(new URL(referer).origin)
  } catch {
    return false
  }
}

/**
 * The response a route returns to a request from anywhere but the app's own
 * pages, or `null` to proceed. Call it before authenticating, so a refused
 * request never reaches a session lookup either.
 *
 * The middleware applies it to every write; a route calls it directly only
 * for what the middleware does not cover — the terminal stream's `GET` — or
 * as the defence in depth the three #429 routes keep.
 */
export function refuseCrossSite(request: Request): Response | null {
  const appOrigin = resolveAppOrigin()
  if (isSameOriginRequest(request, appOrigin)) return null
  const why =
    appOrigin === null
      ? `this server's public origin is not configured (set ${APP_ORIGIN_ENV})`
      : `this route accepts requests only from pages on ${appOrigin}`
  return new Response(`Cross-site request refused: ${why}`, {
    status: 403,
    headers: { 'Content-Type': 'text/plain' },
  })
}

/** Methods that must not change state (#429), and so need no provenance. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Middleware hook: refuse a state-changing request that did not come from the
 * app's own pages (#455).
 *
 * Runs in both routers' copies of the middleware, deliberately without a
 * router or path test: a write to an API route and a `'use server'` call are
 * the same threat. Every method but `GET`, `HEAD` and `OPTIONS` counts as a
 * write, so a method nobody listed is checked rather than waved through.
 * Requests with no browser provenance and no session cookie pass — the
 * machine-caller rule in the module header.
 */
export function refuseCrossOriginStateChange(
  event: Pick<FetchEvent, 'request'>,
): Response | undefined {
  const { request } = event
  if (SAFE_METHODS.has(request.method)) return undefined
  const fromABrowser =
    request.headers.has('origin') ||
    request.headers.has('referer') ||
    request.headers.has('sec-fetch-site')
  if (!fromABrowser && readCookie(request, SESSION_COOKIE) === null) return undefined
  return refuseCrossSite(request) ?? undefined
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
