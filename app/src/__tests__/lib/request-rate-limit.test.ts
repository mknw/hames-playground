// @vitest-environment node
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport() {} }))
const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock('~/lib/auth/session-store.server', () => ({ getSession }))
const { createRequestLimiter, enforceRequestRateLimit } =
  await import('~/lib/request-rate-limit.server')

function event(cookie?: string, extra: Record<string, string> = {}) {
  return {
    request: new Request('https://app.example/api/events', {
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

  it('limits anonymous traffic before any session lookup or request-body read', async () => {
    const limit = createRequestLimiter(() => 0)
    for (let i = 0; i < 1000; i++) expect(await limit(event())).toBeUndefined()
    const req = {
      request: new Request('https://app.example/api/stash/upload', {
        method: 'POST',
        body: 'synthetic-upload',
        headers: { cookie: 'kg_session=cookie-after-flood' },
      }),
    }
    expect((await limit(req))?.status).toBe(429)
    expect(req.request.bodyUsed).toBe(false)
    expect(getSession).not.toHaveBeenCalled()
  })

  it('global refill is 100/second, with burst at most 1000', async () => {
    let time = 0
    const limit = createRequestLimiter(() => time)
    for (let i = 0; i < 1000; i++) await limit(event())
    time = 9.999
    expect((await limit(event()))?.status).toBe(429)
    time = 10
    expect(await limit(event())).toBeUndefined()
    expect((await limit(event()))?.status).toBe(429)
    time = 60_000
    for (let i = 0; i < 1000; i++) expect(await limit(event())).toBeUndefined()
    expect((await limit(event()))?.status).toBe(429)
  })

  it('arbitrary/expired cookies and forwarded addresses cannot bypass the flood backstop', async () => {
    const limit = createRequestLimiter(() => 0)
    for (let i = 0; i < 1000; i++) {
      expect(
        await limit(event(`forged-${i}`, { 'X-Forwarded-For': `192.0.2.${i}` })),
      ).toBeUndefined()
    }
    expect((await limit(event('another-cookie')))?.status).toBe(429)
    expect(getSession).toHaveBeenCalledTimes(1000)
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
