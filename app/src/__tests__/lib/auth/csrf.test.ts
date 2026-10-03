/**
 * The CSRF defences (#429, #455): which origin counts as "the app's own
 * pages", who is exempt from the check, the middleware hook that applies it to
 * every state-changing request, and the hook that keeps SolidStart's server
 * functions off `GET`.
 *
 * The provenance matrix is pinned case by case because each header is a
 * fallback for a browser that lacks the one above it, and a fallback that
 * accepts too much is invisible until someone uses that browser.
 *
 * Every request below is built with a URL whose host is NOT the configured
 * origin wherever that matters. The configured origin is the identity; the
 * request's own `Host` is something its sender chose, and a test that let the
 * two coincide could not tell the difference.
 *
 * The middleware wiring is a source scan, for the reason
 * `security-headers.test.ts` gives: importing `src/middleware.ts` for real
 * would arm the routine scheduler inside a unit run.
 *
 * The server-function guard keys on the router that runs it, which a unit
 * test can only stub (`ROUTER_NAME`). Which paths h3 actually hands to that
 * router, and whether the hooks run in front of the API routes at all, is
 * visible only to a real nitro build, so CI's docker job probes the built
 * image too (`ci.yml`, "Assert no server function runs from a GET" and
 * "Assert a cross-origin write is refused").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const {
  isSameOriginRequest,
  refuseCrossSite,
  refuseCrossOriginStateChange,
  refuseServerFunctionGet,
  methodNotAllowed,
  resolveAppOrigin,
  warnIfAppOriginUnconfigured,
  DEV_APP_ORIGIN,
  APP_ORIGIN_ENV,
} = await import('~/lib/auth/csrf.server')
const { buildEntraConfig } = await import('~/lib/auth/entra-config.server')

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

/** The configured public origin the matrix below is judged against. */
const OWN = 'https://app.example'
const REDIRECT = `${OWN}/api/auth/callback`

function req(headers: Record<string, string>, url = 'http://internal:3444/api/auth/logout') {
  return new Request(url, { method: 'POST', headers })
}

const env = import.meta.env as Record<string, unknown>
let originalDev: unknown

beforeEach(() => {
  originalDev = env.DEV
})

afterEach(() => {
  env.DEV = originalDev
  vi.unstubAllEnvs()
})

describe('resolveAppOrigin — the identity every check compares against', () => {
  it('is the origin of AUTH_REDIRECT_URI, in a dev and a production build alike', () => {
    for (const dev of [true, false]) {
      expect(resolveAppOrigin({ AUTH_REDIRECT_URI: REDIRECT }, dev)).toBe(OWN)
    }
  })

  it('is the variable this module names in its messages', () => {
    expect(APP_ORIGIN_ENV).toBe('AUTH_REDIRECT_URI')
  })

  it('normalises the way a browser serialises Origin: default port dropped, host lower-cased', () => {
    expect(resolveAppOrigin({ AUTH_REDIRECT_URI: ' HTTPS://App.Example:443/x ' }, false)).toBe(OWN)
    expect(resolveAppOrigin({ AUTH_REDIRECT_URI: 'https://app.example:8443/x' }, false)).toBe(
      'https://app.example:8443',
    )
  })

  it('falls back to the documented dev default in a dev build only', () => {
    expect(resolveAppOrigin({}, true)).toBe('http://localhost:3444')
    expect(resolveAppOrigin({ AUTH_REDIRECT_URI: '  ' }, true)).toBe('http://localhost:3444')
  })

  it('is null in a production build with the variable unset — fail closed', () => {
    expect(resolveAppOrigin({}, false)).toBeNull()
    expect(resolveAppOrigin({ AUTH_REDIRECT_URI: '' }, false)).toBeNull()
  })

  it.each([
    ['not a URL', 'app.example/api/auth/callback'],
    ['a non-web scheme', 'javascript:alert(1)'],
    ['an opaque scheme', 'data:text/plain,x'],
  ])('is null for %s, in dev too — a typo does not fall back to the default', (_l, value) => {
    for (const dev of [true, false]) {
      expect(resolveAppOrigin({ AUTH_REDIRECT_URI: value }, dev)).toBeNull()
    }
  })

  it('has a dev default that agrees with the OIDC redirect’s own dev default', () => {
    // Two literals for one fact; this is what keeps them one fact.
    const redirect = buildEntraConfig({
      AZURE_TENANT_ID: 't',
      AZURE_CLIENT_ID: 'c',
      AZURE_CLIENT_SECRET: 's',
    }).redirectUri
    expect(DEV_APP_ORIGIN).toBe(new URL(redirect).origin)
  })

  it('reads the build mode and process.env when called with no arguments', () => {
    vi.stubEnv('AUTH_REDIRECT_URI', undefined)
    env.DEV = true
    expect(resolveAppOrigin()).toBe(DEV_APP_ORIGIN)
    env.DEV = false
    expect(resolveAppOrigin()).toBeNull()
    vi.stubEnv('AUTH_REDIRECT_URI', REDIRECT)
    expect(resolveAppOrigin()).toBe(OWN)
  })
})

describe('warnIfAppOriginUnconfigured', () => {
  it('says so at boot when a production build has no public origin', () => {
    const log = vi.fn()
    warnIfAppOriginUnconfigured({}, false, log)
    expect(log).toHaveBeenCalledOnce()
    expect(log.mock.calls[0][0]).toMatch(/AUTH_REDIRECT_URI/)
    expect(log.mock.calls[0][0]).toMatch(/refuses every state-changing request/)
  })

  it('is silent in dev and when the origin is configured', () => {
    const log = vi.fn()
    warnIfAppOriginUnconfigured({}, true, log)
    warnIfAppOriginUnconfigured({ AUTH_REDIRECT_URI: REDIRECT }, false, log)
    expect(log).not.toHaveBeenCalled()
  })
})

describe('isSameOriginRequest', () => {
  it.each([
    // A sibling subdomain is the "same site" SameSite=Lax lets through.
    ['same-site', 'https://evil.app.example'],
    ['cross-site', OWN],
    // A typed URL or a bookmark — never how the app's own pages call a route.
    ['none', OWN],
  ])('Sec-Fetch-Site: %s is a refusal whatever Origin says (%s)', (site, origin) => {
    expect(isSameOriginRequest(req({ 'sec-fetch-site': site, origin }), OWN)).toBe(false)
  })

  it('Sec-Fetch-Site: same-origin with this Origin is admitted', () => {
    const request = req({ 'sec-fetch-site': 'same-origin', origin: OWN })
    expect(isSameOriginRequest(request, OWN)).toBe(true)
  })

  it('Sec-Fetch-Site: same-origin ALONE is not enough (#455)', () => {
    // The browser computes it against the URL it targeted. Under DNS rebinding
    // that URL is the attacker's own name, so "same-origin" is the attacker's
    // page talking to itself; only Origin or Referer names WHICH origin.
    expect(isSameOriginRequest(req({ 'sec-fetch-site': 'same-origin' }), OWN)).toBe(false)
  })

  it.each([
    ['its own origin', OWN, true],
    ['another origin', 'https://attacker.example', false],
    ['a sibling subdomain', 'https://evil.app.example', false],
    ['the same host on another scheme', 'http://app.example', false],
    ['the same host on another port', 'https://app.example:8443', false],
    ['an opaque origin', 'null', false],
  ])('without Sec-Fetch-Site, Origin of %s → %s', (_label, origin, expected) => {
    expect(isSameOriginRequest(req({ origin }), OWN)).toBe(expected)
  })

  it.each([
    ['a page on this origin', `${OWN}/?c=1`, true],
    ['a page elsewhere', 'https://attacker.example/app.example/', false],
    ['a sibling page', 'https://evil.app.example/', false],
    ['garbage', 'not a url', false],
  ])('with no Origin, Referer from %s → %s', (_label, referer, expected) => {
    expect(isSameOriginRequest(req({ referer }), OWN)).toBe(expected)
  })

  it('lets Origin decide over a Referer that disagrees', () => {
    const request = req({ origin: 'https://attacker.example', referer: `${OWN}/` })
    expect(isSameOriginRequest(request, OWN)).toBe(false)
  })

  it('fails closed when the request carries no provenance at all', () => {
    expect(isSameOriginRequest(req({}), OWN)).toBe(false)
  })

  it('fails closed when no public origin is configured, however same-origin it looks', () => {
    const request = req({ 'sec-fetch-site': 'same-origin', origin: OWN, referer: `${OWN}/` })
    expect(isSameOriginRequest(request, null)).toBe(false)
  })

  describe('never compares against the request’s own Host (#455)', () => {
    it('refuses an Origin that matches the Host it arrived with but not the configured origin', () => {
      // What a DNS-rebound page, a catch-all proxy or any non-browser client
      // produces: the sender picked the Host, so Host and Origin agree.
      const request = req(
        { 'sec-fetch-site': 'same-origin', origin: 'https://rebound.example' },
        'https://rebound.example/api/events',
      )
      expect(isSameOriginRequest(request, OWN)).toBe(false)
    })

    it('admits the configured origin even when the Host the server sees is another name', () => {
      // A proxy that rewrites Host to the upstream's (`app:3444`) must not
      // turn every real request into a refusal.
      const request = req({ origin: OWN }, 'http://app:3444/api/events')
      expect(isSameOriginRequest(request, OWN)).toBe(true)
    })
  })

  it('reads the configured origin when none is passed', () => {
    vi.stubEnv('AUTH_REDIRECT_URI', REDIRECT)
    expect(isSameOriginRequest(req({ origin: OWN }))).toBe(true)
    expect(isSameOriginRequest(req({ origin: 'https://attacker.example' }))).toBe(false)
  })
})

describe('refuseCrossSite', () => {
  beforeEach(() => {
    vi.stubEnv('AUTH_REDIRECT_URI', REDIRECT)
  })

  it('answers 403 to a cross-site request, naming the origin it expected', async () => {
    const res = refuseCrossSite(
      req({ 'sec-fetch-site': 'cross-site', origin: 'https://a.example' }),
    )
    expect(res?.status).toBe(403)
    const body = await res?.text()
    expect(body).toMatch(/cross-site/i)
    expect(body).toContain(OWN)
  })

  it('lets a same-origin request through', () => {
    expect(refuseCrossSite(req({ 'sec-fetch-site': 'same-origin', origin: OWN }))).toBeNull()
  })

  it('names the missing variable when a production build has no public origin', async () => {
    vi.stubEnv('AUTH_REDIRECT_URI', undefined)
    env.DEV = false
    const res = refuseCrossSite(req({ origin: OWN }))
    expect(res?.status).toBe(403)
    expect(await res?.text()).toMatch(/AUTH_REDIRECT_URI/)
  })
})

describe('refuseCrossOriginStateChange — the one chokepoint for writes (#455)', () => {
  const COOKIE = { cookie: 'kg_session=abc123' }
  const SAME = { 'sec-fetch-site': 'same-origin', origin: OWN, ...COOKIE }

  function event(
    method: string,
    headers: Record<string, string>,
    url = 'http://internal:3444/api/events',
  ) {
    return { request: new Request(url, { method, headers }) }
  }

  beforeEach(() => {
    vi.stubEnv('AUTH_REDIRECT_URI', REDIRECT)
  })

  it('refuses a cross-site POST with a 403', async () => {
    const res = refuseCrossOriginStateChange(
      event('POST', {
        'sec-fetch-site': 'cross-site',
        origin: 'https://attacker.example',
        ...COOKIE,
      }),
    )
    expect(res?.status).toBe(403)
    expect(await res?.text()).toMatch(/cross-site/i)
  })

  it('refuses a POST from a sibling subdomain — the gap SameSite=Lax leaves', () => {
    // SameSite counts it as the same site, so the Lax cookie rides along.
    const sibling = { origin: 'https://evil.app.example', ...COOKIE }
    expect(
      refuseCrossOriginStateChange(event('POST', { 'sec-fetch-site': 'same-site', ...sibling }))
        ?.status,
    ).toBe(403)
    // …and from a browser too old to send Sec-Fetch-Site, where Origin alone decides.
    expect(refuseCrossOriginStateChange(event('POST', sibling))?.status).toBe(403)
  })

  it('lets a same-origin POST through', () => {
    expect(refuseCrossOriginStateChange(event('POST', SAME))).toBeUndefined()
  })

  it.each(['PUT', 'PATCH', 'DELETE'])('covers %s as well as POST', (method) => {
    const foreign = { 'sec-fetch-site': 'same-site', origin: 'https://evil.app.example', ...COOKIE }
    expect(refuseCrossOriginStateChange(event(method, foreign))?.status).toBe(403)
    expect(refuseCrossOriginStateChange(event(method, SAME))).toBeUndefined()
  })

  it('treats any method but GET, HEAD and OPTIONS as a write', () => {
    // Deny by default: a method nobody listed is not thereby a safe one.
    const foreign = { origin: 'https://attacker.example', ...COOKIE }
    expect(refuseCrossOriginStateChange(event('PROPFIND', foreign))?.status).toBe(403)
  })

  it.each(['GET', 'HEAD', 'OPTIONS'])(
    'leaves %s to the routes (no GET changes state, #429)',
    (m) => {
      const foreign = { 'sec-fetch-site': 'cross-site', origin: 'https://attacker.example' }
      expect(refuseCrossOriginStateChange(event(m, { ...foreign, ...COOKIE }))).toBeUndefined()
    },
  )

  describe('SolidStart server functions (`/_server`)', () => {
    const fn =
      'http://internal:3444/_server?id=src_lib_skills_actions_server_ts--deleteSkill_1&name=x'

    beforeEach(() => {
      vi.stubEnv('ROUTER_NAME', 'server-fns')
    })

    it('refuses a cross-origin call — the no-JS form POST needs no special header', () => {
      // `server-handler.js`: a form POST with no `X-Server-Instance` runs the
      // function with the form body as its argument.
      const sibling = { 'sec-fetch-site': 'same-site', origin: 'https://evil.app.example' }
      expect(
        refuseCrossOriginStateChange(event('POST', { ...sibling, ...COOKIE }, fn))?.status,
      ).toBe(403)
      expect(
        refuseCrossOriginStateChange(event('POST', { origin: 'https://attacker.example' }, fn))
          ?.status,
      ).toBe(403)
    })

    it('lets the app’s own client runtime through', () => {
      expect(refuseCrossOriginStateChange(event('POST', SAME, fn))).toBeUndefined()
    })
  })

  describe('machine callers: no browser provenance and no session cookie', () => {
    it('lets a bearer-token call through untouched — the route’s own auth decides', () => {
      const trigger = event(
        'POST',
        { authorization: 'Bearer device-secret', 'content-type': 'multipart/form-data' },
        'http://internal:3444/api/agents/general',
      )
      expect(refuseCrossOriginStateChange(trigger)).toBeUndefined()
    })

    it('lets through exactly what Node’s fetch sends (no Origin, no Sec-Fetch-Site)', () => {
      const node = { 'sec-fetch-mode': 'cors', 'user-agent': 'node', accept: '*/*' }
      expect(refuseCrossOriginStateChange(event('POST', node))).toBeUndefined()
    })

    it('does not exempt a token call that names a foreign Origin', () => {
      // The exemption is "nothing says a browser sent this", not "it has a token".
      const res = refuseCrossOriginStateChange(
        event('POST', { authorization: 'Bearer x', origin: 'https://attacker.example' }),
      )
      expect(res?.status).toBe(403)
    })

    it('does not exempt a request whose Referer names a foreign page', () => {
      const res = refuseCrossOriginStateChange(
        event('POST', { referer: 'https://attacker.example/form' }),
      )
      expect(res?.status).toBe(403)
    })

    it('does not exempt a DNS-rebound page on a dev server, which needs no cookie at all', () => {
      // Under the dev bypass every request is authenticated without a cookie,
      // so a page whose name was rebound to 127.0.0.1 would otherwise be a full
      // CSRF: its Host, its Origin and Sec-Fetch-Site all say "same origin".
      vi.stubEnv('AUTH_REDIRECT_URI', undefined)
      const rebound = event(
        'POST',
        { 'sec-fetch-site': 'same-origin', origin: 'http://rebound.example:3444' },
        'http://rebound.example:3444/api/events',
      )
      expect(refuseCrossOriginStateChange(rebound)?.status).toBe(403)
    })
  })

  describe('a cookie with no Origin and no Referer', () => {
    it('is refused (fail closed): a browser always sends Origin on a write', () => {
      expect(refuseCrossOriginStateChange(event('POST', COOKIE))?.status).toBe(403)
    })

    it('is refused even when it claims Sec-Fetch-Site: same-origin', () => {
      const res = refuseCrossOriginStateChange(
        event('POST', { 'sec-fetch-site': 'same-origin', ...COOKIE }),
      )
      expect(res?.status).toBe(403)
    })

    it('is admitted when a same-origin Referer stands in for Origin', () => {
      // An older browser, or a write that went through a redirect, may carry
      // only a Referer. The production Referrer-Policy keeps it on same-origin
      // requests.
      expect(refuseCrossOriginStateChange(event('POST', { referer: `${OWN}/`, ...COOKIE }))).toBe(
        undefined,
      )
    })
  })

  describe('the public origin', () => {
    it('defaults to the dev server in a dev build', () => {
      vi.stubEnv('AUTH_REDIRECT_URI', undefined)
      env.DEV = true
      const dev = { origin: DEV_APP_ORIGIN, ...COOKIE }
      expect(refuseCrossOriginStateChange(event('POST', dev))).toBeUndefined()
      // Another loopback name is another origin: set AUTH_REDIRECT_URI for it.
      const other = { origin: 'http://127.0.0.1:3444', ...COOKIE }
      expect(refuseCrossOriginStateChange(event('POST', other))?.status).toBe(403)
    })

    it('refuses every browser write when a production build has none configured', async () => {
      vi.stubEnv('AUTH_REDIRECT_URI', undefined)
      env.DEV = false
      const res = refuseCrossOriginStateChange(event('POST', SAME))
      expect(res?.status).toBe(403)
      expect(await res?.text()).toMatch(/AUTH_REDIRECT_URI/)
    })
  })
})

describe('methodNotAllowed', () => {
  it('is a 405 that names the allowed method', () => {
    const res = methodNotAllowed('POST')
    expect(res.status).toBe(405)
    expect(res.headers.get('Allow')).toBe('POST')
  })
})

describe('refuseServerFunctionGet', () => {
  const event = (method: string, url: string) => ({ request: new Request(url, { method }) })
  // The shape SolidStart's no-JS path accepts: function id, a name, and the
  // arguments as seroval JSON in the query string.
  const query = '?id=src_lib_skills_actions_server_ts--deleteSkill_1&name=x&args=%7B%7D'

  /**
   * Every path h3 hands to the server-function router: it percent-decodes the
   * path and then matches a bare `startsWith('/_server')`, no segment
   * boundary. The first version of the hook matched `/_server` and `/_server/…`
   * on the raw URL, and each of the rest below ran its function on a
   * production build (#451 review).
   */
  const routedToServerFns = [
    '/_server',
    '/_server/',
    '/_serverx',
    '/_serverless',
    '/_server.js',
    '/_server;a',
    '/_server-anything/x',
    '/%5Fserver', // `_` encoded
    '/%5fserver',
    '/_server%2F', // the slash encoded
    '/_server%2Fx',
    '/%5F%73erver', // more than one character encoded
  ]

  describe('in the server-fns router’s copy of the middleware', () => {
    beforeEach(() => {
      vi.stubEnv('ROUTER_NAME', 'server-fns')
    })

    it.each(routedToServerFns.flatMap((p) => ['GET', 'HEAD'].map((m) => [m, p])))(
      'refuses %s %s with a 405',
      (method, pathname) => {
        const res = refuseServerFunctionGet(event(method, `http://x${pathname}${query}`))
        expect(res?.status).toBe(405)
        expect(res?.headers.get('Allow')).toBe('POST')
      },
    )

    it.each(['PUT', 'PATCH', 'DELETE', 'OPTIONS'])('refuses %s too', (method) => {
      expect(refuseServerFunctionGet(event(method, `http://x/_server${query}`))?.status).toBe(405)
    })

    it.each(routedToServerFns)('lets the client runtime’s POST through: %s', (pathname) => {
      expect(refuseServerFunctionGet(event('POST', `http://x${pathname}`))).toBeUndefined()
    })
  })

  describe('in every other router’s copy', () => {
    it.each(['ssr', 'client', undefined])('ROUTER_NAME=%s refuses no GET', (router) => {
      if (router) vi.stubEnv('ROUTER_NAME', router)
      for (const url of ['http://x/', 'http://x/api/health', `http://x/_serverx${query}`]) {
        expect(refuseServerFunctionGet(event('GET', url)), url).toBeUndefined()
      }
    })
  })
})

describe('the server-boot hook runs both CSRF hooks in every build', () => {
  const source = readFileSync(path.join(APP, 'src/middleware.ts'), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('imports them from the module this test covers', () => {
    expect(code).toMatch(
      /^import \{\s*refuseCrossOriginStateChange,\s*refuseServerFunctionGet\s*\} from ['"]\.\/lib\/auth\/csrf\.server['"]/m,
    )
  })

  it('passes them as unconditional onRequest hooks, ahead of the dev-only one', () => {
    expect(code).toMatch(
      /onRequest:\s*\[\s*setSecurityHeaders\s*,\s*refuseServerFunctionGet\s*,\s*refuseCrossOriginStateChange\s*,/,
    )
  })
})
