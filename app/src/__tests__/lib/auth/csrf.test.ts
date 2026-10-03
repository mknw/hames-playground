/**
 * The CSRF defences (#429): who counts as "the app's own pages", and the
 * middleware hook that keeps SolidStart's server functions off `GET`.
 *
 * The provenance matrix is pinned case by case because each header is a
 * fallback for a browser that lacks the one above it, and a fallback that
 * accepts too much is invisible until someone uses that browser.
 *
 * The middleware wiring is a source scan, for the reason
 * `security-headers.test.ts` gives: importing `src/middleware.ts` for real
 * would arm the routine scheduler inside a unit run.
 */
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const { isSameOriginRequest, refuseCrossSite, refuseServerFunctionGet, methodNotAllowed } =
  await import('~/lib/auth/csrf.server')

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')

function req(headers: Record<string, string>, url = 'https://app.example/api/auth/logout') {
  return new Request(url, { method: 'POST', headers })
}

describe('isSameOriginRequest', () => {
  it.each([
    ['Sec-Fetch-Site: same-origin', { 'sec-fetch-site': 'same-origin' }, true],
    // A sibling subdomain is the "same site" SameSite=Lax lets through.
    ['Sec-Fetch-Site: same-site', { 'sec-fetch-site': 'same-site' }, false],
    ['Sec-Fetch-Site: cross-site', { 'sec-fetch-site': 'cross-site' }, false],
    // A typed URL or a bookmark — never how the app's own pages call a route.
    ['Sec-Fetch-Site: none', { 'sec-fetch-site': 'none' }, false],
  ])('%s → %s', (_label, headers, expected) => {
    expect(isSameOriginRequest(req(headers))).toBe(expected)
  })

  it('lets Sec-Fetch-Site decide over a matching Origin', () => {
    // The browser sets Sec-Fetch-Site and a page cannot; it is the authority.
    const request = req({ 'sec-fetch-site': 'cross-site', origin: 'https://app.example' })
    expect(isSameOriginRequest(request)).toBe(false)
  })

  it.each([
    ['its own origin', 'https://app.example', true],
    ['another origin', 'https://attacker.example', false],
    ['a sibling subdomain', 'https://evil.app.example', false],
    ['the same host on another scheme', 'http://app.example', false],
    ['the same host on another port', 'https://app.example:8443', false],
    ['an opaque origin', 'null', false],
  ])('without Sec-Fetch-Site, Origin of %s → %s', (_label, origin, expected) => {
    expect(isSameOriginRequest(req({ origin }))).toBe(expected)
  })

  it.each([
    ['a page on this origin', 'https://app.example/?c=1', true],
    ['a page elsewhere', 'https://attacker.example/app.example/', false],
    ['garbage', 'not a url', false],
  ])('with neither, Referer from %s → %s', (_label, referer, expected) => {
    expect(isSameOriginRequest(req({ referer }))).toBe(expected)
  })

  it('fails closed when the request carries no provenance at all', () => {
    expect(isSameOriginRequest(req({}))).toBe(false)
  })
})

describe('refuseCrossSite', () => {
  it('answers 403 to a cross-site request', async () => {
    const res = refuseCrossSite(req({ 'sec-fetch-site': 'cross-site' }))
    expect(res?.status).toBe(403)
    expect(await res?.text()).toMatch(/cross-site/i)
  })

  it('lets a same-origin request through', () => {
    expect(refuseCrossSite(req({ 'sec-fetch-site': 'same-origin' }))).toBeNull()
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
  const call = 'http://x/_server?id=src_lib_x_server_ts--deleteSkill_1&name=x&args=%7B%7D'

  it.each([
    ['GET', call],
    ['GET', 'http://x/_server/?id=a&name=b'],
    ['HEAD', call],
    ['PUT', call],
  ])('refuses %s %s with a 405', (method, url) => {
    const res = refuseServerFunctionGet(event(method, url))
    expect(res?.status).toBe(405)
    expect(res?.headers.get('Allow')).toBe('POST')
  })

  it('lets the client runtime’s POST through', () => {
    expect(refuseServerFunctionGet(event('POST', 'http://x/_server'))).toBeUndefined()
  })

  it.each(['http://x/', 'http://x/api/health', 'http://x/_serverless', 'http://x/s/_server'])(
    'leaves every other GET alone: %s',
    (url) => {
      expect(refuseServerFunctionGet(event('GET', url))).toBeUndefined()
    },
  )
})

describe('the server-boot hook runs refuseServerFunctionGet in every build', () => {
  const source = readFileSync(path.join(APP, 'src/middleware.ts'), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

  it('imports it from the module this test covers', () => {
    expect(code).toMatch(
      /^import \{ refuseServerFunctionGet \} from ['"]\.\/lib\/auth\/csrf\.server['"]/m,
    )
  })

  it('passes it as an unconditional onRequest hook, ahead of the dev-only one', () => {
    expect(code).toMatch(/onRequest:\s*\[\s*setSecurityHeaders\s*,\s*refuseServerFunctionGet\s*,/)
  })
})
