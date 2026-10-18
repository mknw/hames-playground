// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, beforeEach } from 'vitest'

// Exercise the real bearer parser/resolver against synthetic config, without
// reading an operator's gitignored credentials.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (path: string) => path.endsWith('/action-tokens.yaml') || actual.existsSync(path),
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) =>
      String(args[0]).endsWith('/action-tokens.yaml')
        ? 'tokens:\n  - secret: synthetic-a1\n    userId: user-a\n  - secret: synthetic-a2\n    userId: user-a\n  - secret: synthetic-b\n    userId: user-b\n'
        : actual.readFileSync(...args),
  }
})

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport() {} }))
const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock('~/lib/auth/session-store.server', () => ({ getSession }))
const { createRequestLimiter, enforceRequestRateLimit } =
  await import('~/lib/request-rate-limit.server')

function event(
  cookie?: string,
  extra: Record<string, string> = {},
  path = '/api/events',
  method = 'GET',
) {
  return {
    request: new Request(`https://app.example${path}`, {
      method,
      headers: { ...(cookie ? { cookie: `kg_session=${cookie}` } : {}), ...extra },
    }),
  }
}

beforeEach(() => {
  getSession.mockReset().mockResolvedValue(null)
})

describe('request admission (#432 row 6)', () => {
  it('allows 120 requests by one verified user, then returns a non-cacheable 429', async () => {
    getSession.mockResolvedValue({ userId: 'user-a' })
    const limit = createRequestLimiter(() => 0)
    for (let i = 0; i < 120; i++) expect(await limit(event('valid-a'))).toBeUndefined()
    const denied = await limit(event('valid-a'))
    expect(denied?.status).toBe(429)
    expect(denied?.headers.get('Retry-After')).toBe('1')
    expect(denied?.headers.get('Cache-Control')).toBe('no-store')
    expect(await denied?.text()).toBe('Too many requests')
  })

  it('shares a user allowance across sessions, methods, routes and spoofed identity headers', async () => {
    getSession.mockResolvedValue({ userId: 'user-a' })
    const limit = createRequestLimiter(() => 0)
    for (let i = 0; i < 120; i++) await limit(event(`session-${i}`))
    const request = new Request('https://other.example/_server', {
      method: 'POST',
      headers: {
        cookie: 'kg_session=new-session',
        'X-Forwarded-For': '192.0.2.10',
        'X-User-Id': 'user-b',
      },
    })
    expect((await limit({ request }))?.status).toBe(429)
    expect(getSession).toHaveBeenLastCalledWith('new-session')
  })

  it('does not throttle another verified principal when one is exhausted', async () => {
    getSession.mockImplementation(async (id) => ({ userId: id }))
    const limit = createRequestLimiter(() => 0)
    for (let i = 0; i < 120; i++) await limit(event('a'))
    expect((await limit(event('a')))?.status).toBe(429)
    expect(await limit(event('b'))).toBeUndefined()
  })

  it('refills at ten requests/second with no boundary reset or extra burst after idle', async () => {
    let time = 0
    getSession.mockResolvedValue({ userId: 'a' })
    const limit = createRequestLimiter(() => time)
    for (let i = 0; i < 120; i++) await limit(event('a'))
    time = 99.999
    expect((await limit(event('a')))?.status).toBe(429)
    time = 100
    expect(await limit(event('a'))).toBeUndefined()
    expect((await limit(event('a')))?.status).toBe(429)
    time = 120_000
    for (let i = 0; i < 120; i++) expect(await limit(event('a'))).toBeUndefined()
    expect((await limit(event('a')))?.status).toBe(429)
  })

  it('does not mint tokens if the clock goes backwards', async () => {
    let time = 1000
    getSession.mockResolvedValue({ userId: 'a' })
    const limit = createRequestLimiter(() => time)
    for (let i = 0; i < 120; i++) await limit(event('a'))
    time = 0
    expect((await limit(event('a')))?.status).toBe(429)
    time = 1000
    expect((await limit(event('a')))?.status).toBe(429)
  })

  it('caps parallel admissions after asynchronous session lookups', async () => {
    getSession.mockResolvedValue({ userId: 'a' })
    const limit = createRequestLimiter(() => 0)
    const results = await Promise.all(Array.from({ length: 150 }, () => limit(event('a'))))
    expect(results.filter((r) => r === undefined)).toHaveLength(120)
    expect(results.filter((r) => r?.status === 429)).toHaveLength(30)
  })

  it('limits anonymous traffic before body work without spending a verified user allowance', async () => {
    const limit = createRequestLimiter(() => 0)
    for (let i = 0; i < 1000; i++) {
      // Distributed addresses exercise the remaining anonymous global bound.
      expect(
        await limit(event(undefined, { 'X-Forwarded-For': `198.51.100.${i % 10}` })),
      ).toBeUndefined()
    }
    const req = {
      request: new Request('https://app.example/api/stash/upload', {
        method: 'POST',
        body: 'synthetic-upload',
        headers: { 'X-Forwarded-For': '198.51.100.200' },
      }),
    }
    const clone = vi.spyOn(req.request, 'clone')
    expect((await limit(req))?.status).toBe(429)
    expect(req.request.bodyUsed).toBe(false)
    expect(clone).not.toHaveBeenCalled()
    expect(getSession).not.toHaveBeenCalled()
    getSession.mockResolvedValue({ userId: 'victim' })
    expect(await limit(event('verified'))).toBeUndefined()
  })

  it('global refill is 100/second, with burst at most 1000', async () => {
    let time = 0
    const limit = createRequestLimiter(() => time)
    const anonymous = (i: number) => event(undefined, { 'X-Forwarded-For': `198.51.100.${i % 10}` })
    for (let i = 0; i < 1000; i++) expect(await limit(anonymous(i))).toBeUndefined()
    time = 9.999
    expect((await limit(anonymous(0)))?.status).toBe(429)
    time = 10
    expect(await limit(anonymous(0))).toBeUndefined()
    expect((await limit(anonymous(0)))?.status).toBe(429)
    time = 60_000
    for (let i = 0; i < 1000; i++) expect(await limit(anonymous(i))).toBeUndefined()
    expect((await limit(anonymous(0)))?.status).toBe(429)
  })

  it('unknown or expired cookies share their address allowance and never become principals', async () => {
    const limit = createRequestLimiter(() => 0)
    for (let i = 0; i < 120; i++) {
      expect(await limit(event(`forged-${i}`, { 'X-Forwarded-For': '192.0.2.1' }))).toBeUndefined()
    }
    expect((await limit(event('expired', { 'X-Forwarded-For': '192.0.2.1' })))?.status).toBe(429)
    expect(getSession).toHaveBeenCalledTimes(121)
    expect(await limit(event('unknown', { 'X-Forwarded-For': '192.0.2.2' }))).toBeUndefined()
  })

  it('one address cannot empty the anonymous pool for another address or verified users', async () => {
    let time = 0
    const limit = createRequestLimiter(() => time)
    for (let second = 0; second < 10; second++) {
      time = second * 1000
      for (let i = 0; i < 1000; i++)
        await limit(event(undefined, { 'X-Forwarded-For': '192.0.2.1' }))
      expect(await limit(event(undefined, { 'X-Forwarded-For': '192.0.2.2' }))).toBeUndefined()
      getSession.mockResolvedValue({ userId: 'victim' })
      expect(await limit(event('verified', { 'X-Forwarded-For': '192.0.2.1' }))).toBeUndefined()
    }
  })

  it('verified refusals do not drain the anonymous pool or another principal', async () => {
    getSession.mockImplementation(async (id) => ({ userId: id }))
    const limit = createRequestLimiter(() => 0)
    for (let i = 0; i < 1000; i++) {
      expect((await limit(event('a')))?.status).toBe(i < 120 ? undefined : 429)
    }
    expect(await limit(event('b'))).toBeUndefined()
    expect(await limit(event())).toBeUndefined()
  })

  it('does not put verified users behind a shared office address bucket', async () => {
    getSession.mockImplementation(async (id) => ({ userId: id }))
    const limit = createRequestLimiter(() => 0)
    for (let i = 0; i < 120; i++) await limit(event('a', { 'X-Forwarded-For': '192.0.2.1' }))
    expect(await limit(event('b', { 'X-Forwarded-For': '192.0.2.1' }))).toBeUndefined()
    expect(await limit(event(undefined, { 'X-Forwarded-For': '192.0.2.1' }))).toBeUndefined()
  })

  it('bounds address state, refuses overflow and reclaims only fully refilled addresses', async () => {
    let time = 0
    const limit = createRequestLimiter(() => time)
    const address = (i: number) =>
      event(undefined, { 'X-Forwarded-For': `192.0.${Math.floor(i / 256)}.${i % 256}` })
    for (let i = 0; i < 256; i++) expect(await limit(address(i))).toBeUndefined()
    expect((await limit(address(256)))?.status).toBe(429)
    time = 99 // entries have 119.99 tokens, so none may be evicted
    expect((await limit(address(256)))?.status).toBe(429)
    time = 100
    for (let i = 0; i < 120; i++) expect(await limit(address(255))).toBeUndefined()
    expect(await limit(address(256))).toBeUndefined()
    expect((await limit(address(255)))?.status).toBe(429)
  })

  it('refills an address at ten requests/second with burst at most 120', async () => {
    let time = 0
    const limit = createRequestLimiter(() => time)
    for (let i = 0; i < 120; i++) expect(await limit(event())).toBeUndefined()
    time = 99.999
    expect((await limit(event()))?.status).toBe(429)
    time = 100
    expect(await limit(event())).toBeUndefined()
    expect((await limit(event()))?.status).toBe(429)
    time = 60_000
    for (let i = 0; i < 120; i++) expect(await limit(event())).toBeUndefined()
    expect((await limit(event()))?.status).toBe(429)
  })

  it('missing, malformed and multiple forwarded values share one fallback address', async () => {
    const limit = createRequestLimiter(() => 0)
    for (let i = 0; i < 120; i++) {
      expect(await limit(event(undefined, { 'X-Forwarded-For': `untrusted-${i}` }))).toBeUndefined()
    }
    expect((await limit(event()))?.status).toBe(429)
    expect(
      (await limit(event(undefined, { 'X-Forwarded-For': '192.0.2.1, 192.0.2.2' })))?.status,
    ).toBe(429)
    expect(await limit(event(undefined, { 'X-Forwarded-For': '2001:db8::1' }))).toBeUndefined()
  })

  it.each(['127.0.0.1', '::1', '::ffff:127.0.0.1'])(
    'direct loopback RPCs from %s use the anonymous global allowance without an address bucket',
    async (remoteAddress) => {
      let time = 0
      const limit = createRequestLimiter(() => time)
      const direct = () => ({
        ...event(undefined, {}, '/_server', 'POST'),
        nativeEvent: { node: { req: { socket: { remoteAddress } } } },
      })
      for (let i = 0; i < 1000; i++) expect(await limit(direct())).toBeUndefined()
      expect((await limit(direct()))?.status).toBe(429)
      time = 9.999
      expect((await limit(direct()))?.status).toBe(429)
      time = 10
      expect(await limit(direct())).toBeUndefined()
      expect((await limit(direct()))?.status).toBe(429)
      expect(getSession).not.toHaveBeenCalled()
      getSession.mockResolvedValue({ userId: 'verified' })
      expect(await limit({ ...direct(), ...event('valid') })).toBeUndefined()
    },
  )

  it('direct loopback requests still share the global backstop with forwarded anonymous traffic', async () => {
    const limit = createRequestLimiter(() => 0)
    for (let i = 0; i < 900; i++) {
      await limit(event(undefined, { 'X-Forwarded-For': `192.0.2.${i % 10}` }))
    }
    const direct = {
      ...event(),
      nativeEvent: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } },
    }
    for (let i = 0; i < 100; i++) expect(await limit(direct)).toBeUndefined()
    expect((await limit(direct))?.status).toBe(429)
    expect((await limit(event(undefined, { 'X-Forwarded-For': '192.0.2.200' })))?.status).toBe(429)
  })

  it('missing forwarding data with a remote or unknown peer keeps the bounded fallback', async () => {
    for (const remoteAddress of ['192.0.2.1', undefined]) {
      const limit = createRequestLimiter(() => 0)
      const request = new Request('http://localhost/_server', {
        method: 'POST',
        headers: { 'X-Real-IP': '127.0.0.1', Forwarded: 'for=127.0.0.1' },
      })
      const direct = { request, nativeEvent: { node: { req: { socket: { remoteAddress } } } } }
      for (let i = 0; i < 120; i++) expect(await limit(direct)).toBeUndefined()
      expect((await limit(direct))?.status).toBe(429)
    }
  })

  it.each(['192.0.2.1', '', 'bad-address', '192.0.2.1, 192.0.2.2'])(
    'a loopback proxy peer does not bypass a supplied forwarding value: %j',
    async (forwarded) => {
      const limit = createRequestLimiter(() => 0)
      const proxied = {
        ...event(undefined, { 'X-Forwarded-For': forwarded }),
        nativeEvent: { node: { req: { socket: { remoteAddress: '127.0.0.1' } } } },
      }
      for (let i = 0; i < 120; i++) expect(await limit(proxied)).toBeUndefined()
      expect((await limit(proxied))?.status).toBe(429)
    },
  )

  it('bearer-only action requests exhaust the same verified owner quota', async () => {
    const limit = createRequestLimiter(() => 0)
    const action = () =>
      event(undefined, { authorization: 'Bearer synthetic-a1' }, '/api/agents/general', 'POST')
    for (let i = 0; i < 120; i++) expect(await limit(action())).toBeUndefined()
    expect((await limit(action()))?.status).toBe(429)
    expect(getSession).not.toHaveBeenCalled()
    expect(
      await limit(
        event(undefined, { authorization: 'Bearer synthetic-b' }, '/api/agents/general', 'POST'),
      ),
    ).toBeUndefined()
  })

  it('multiple device tokens and a browser session share one owner budget', async () => {
    getSession.mockResolvedValue({ userId: 'user-a' })
    const limit = createRequestLimiter(() => 0)
    for (let i = 0; i < 40; i++) {
      expect(await limit(event('browser'))).toBeUndefined()
      for (const secret of ['synthetic-a1', 'synthetic-a2']) {
        expect(
          await limit(
            event(undefined, { authorization: `Bearer ${secret}` }, '/api/agents/general', 'POST'),
          ),
        ).toBeUndefined()
      }
    }
    for (const secret of ['synthetic-a1', 'synthetic-a2']) {
      expect(
        (
          await limit(
            event(undefined, { authorization: `Bearer ${secret}` }, '/api/agents/general', 'POST'),
          )
        )?.status,
      ).toBe(429)
    }
    expect((await limit(event('browser')))?.status).toBe(429)
  })

  it('charges only the bearer owner on dual-credential action requests', async () => {
    getSession.mockResolvedValue({ userId: 'user-b' })
    const limit = createRequestLimiter(() => 0)
    for (let i = 0; i < 120; i++) {
      expect(
        await limit(
          event(
            'browser-b',
            { authorization: 'Bearer synthetic-a1' },
            '/api/agents/general',
            'POST',
          ),
        ),
      ).toBeUndefined()
    }
    expect(
      (
        await limit(
          event(
            'browser-b',
            { authorization: 'Bearer synthetic-a2' },
            '/api/agents/general',
            'POST',
          ),
        )
      )?.status,
    ).toBe(429)
    expect(getSession).not.toHaveBeenCalled()
    for (let i = 0; i < 120; i++) expect(await limit(event('browser-b'))).toBeUndefined()
    expect((await limit(event('browser-b')))?.status).toBe(429)
  })

  it('uses session identity on other routes, regardless of a supplied action token', async () => {
    getSession.mockResolvedValue({ userId: 'user-b' })
    const limit = createRequestLimiter(() => 0)
    for (let i = 0; i < 120; i++) expect(await limit(event('b'))).toBeUndefined()
    for (const [path, method] of [
      ['/api/events', 'POST'],
      ['/api/agents/general', 'GET'],
      ['/api/agents/general', 'PUT'],
      ['/api/agents/general/extra', 'POST'],
    ]) {
      expect(
        (await limit(event('b', { authorization: 'Bearer synthetic-a1' }, path, method)))?.status,
      ).toBe(429)
    }
    expect(
      await limit(
        event(undefined, { authorization: 'Bearer synthetic-a1' }, '/api/agents/general', 'POST'),
      ),
    ).toBeUndefined()
  })

  it('selects the bearer owner for encoded action paths and trailing slashes', async () => {
    getSession.mockResolvedValue({ userId: 'user-b' })
    const limit = createRequestLimiter(() => 0)
    for (let i = 0; i < 120; i++) {
      expect(
        await limit(
          event('b', { authorization: 'Bearer synthetic-a1' }, '/api/%61gents/general', 'POST'),
        ),
      ).toBeUndefined()
    }
    expect(
      (
        await limit(
          event('b', { authorization: 'Bearer synthetic-a1' }, '/api/agents/general/', 'POST'),
        )
      )?.status,
    ).toBe(429)
    expect(getSession).not.toHaveBeenCalled()
    expect(await limit(event('b', {}, '/malformed%ZZ'))).toBeUndefined()
    expect(getSession).toHaveBeenCalledTimes(1)
  })

  it('unknown or absent action tokens use the unresolved path even with a valid cookie', async () => {
    getSession.mockResolvedValue({ userId: 'user-b' })
    const limit = createRequestLimiter(() => 0)
    for (let i = 0; i < 120; i++) {
      expect(
        await limit(
          event('b', { authorization: `Bearer unknown-${i}` }, '/api/agents/general', 'POST'),
        ),
      ).toBeUndefined()
    }
    expect((await limit(event('b', {}, '/api/agents/general', 'POST')))?.status).toBe(429)
    expect(getSession).not.toHaveBeenCalled()
    expect(await limit(event('b'))).toBeUndefined()
  })

  it('returns 503 on session-store failure without leaking the error or bypassing the limiter', async () => {
    getSession.mockRejectedValue(new Error('synthetic-private-detail'))
    const denied = await createRequestLimiter(() => 0)(event('valid'))
    expect(denied?.status).toBe(503)
    expect(denied?.headers.get('Retry-After')).toBe('1')
    expect(await denied?.text()).toBe('Session service unavailable')
  })

  it('bounds principal state, refuses overflow, then reclaims idle users without resetting active users', async () => {
    let time = 0
    getSession.mockImplementation(async (id) => ({ userId: id }))
    const limit = createRequestLimiter(() => time)
    for (let i = 0; i < 256; i++) {
      expect(await limit(event(`user-${i}`))).toBeUndefined()
    }
    const full = await limit(event('overflow'))
    expect(full?.status).toBe(429)
    expect(full?.headers.get('Retry-After')).toBe('60')
    time += 60_000
    for (let i = 0; i < 120; i++) expect(await limit(event('user-255'))).toBeUndefined()
    expect(await limit(event('overflow'))).toBeUndefined()
    expect((await limit(event('user-255')))?.status).toBe(429)
  })

  it('shares the deployed allowance across independently loaded router modules', async () => {
    getSession.mockResolvedValue({ userId: 'shared-router-principal' })
    const clock = vi.spyOn(performance, 'now').mockReturnValue(0)
    try {
      vi.resetModules()
      const secondRouter = await import('~/lib/request-rate-limit.server')
      for (let i = 0; i < 60; i++) {
        expect(await enforceRequestRateLimit(event('router-one-session'))).toBeUndefined()
        expect(
          await secondRouter.enforceRequestRateLimit(event('router-two-session')),
        ).toBeUndefined()
      }
      expect((await enforceRequestRateLimit(event('router-one-session')))?.status).toBe(429)
      expect(
        (await secondRouter.enforceRequestRateLimit(event('router-two-session')))?.status,
      ).toBe(429)
    } finally {
      clock.mockRestore()
    }
  })
})

it('wires admission unconditionally after existing security hooks and before route work', () => {
  const source = readFileSync(new URL('../../middleware.ts', import.meta.url), 'utf8')
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  expect(code).toMatch(
    /import \{ enforceRequestRateLimit \} from '.\/lib\/request-rate-limit.server'/,
  )
  expect(code).toMatch(
    /onRequest:\s*\[\s*setSecurityHeaders,\s*refuseServerFunctionGet,\s*refuseCrossOriginStateChange,\s*enforceRequestRateLimit,/,
  )
})
