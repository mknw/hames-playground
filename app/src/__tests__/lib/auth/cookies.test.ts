/**
 * Auth cookie parse/serialize (#119).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import {
  parseCookies,
  readCookie,
  serializeCookie,
  sessionCookie,
  clearCookie,
  SESSION_COOKIE,
} from '../../../lib/auth/cookies.server'

describe('parseCookies', () => {
  it('parses multiple cookies and URL-decodes values', () => {
    expect(parseCookies('a=1; b=hello%20world')).toEqual({ a: '1', b: 'hello world' })
  })
  it('tolerates null / empty / junk', () => {
    expect(parseCookies(null)).toEqual({})
    expect(parseCookies('')).toEqual({})
    expect(parseCookies('novalue; =noname')).toEqual({})
  })
})

describe('readCookie', () => {
  it('reads a named cookie from a Request', () => {
    const req = new Request('http://x/', {
      headers: { cookie: `${SESSION_COOKIE}=sid123; other=y` },
    })
    expect(readCookie(req, SESSION_COOKIE)).toBe('sid123')
    expect(readCookie(req, 'missing')).toBeNull()
  })
})

describe('serializeCookie', () => {
  it('defaults to HttpOnly + SameSite=Lax + Path=/', () => {
    const c = serializeCookie('k', 'v')
    expect(c).toContain('k=v')
    expect(c).toContain('Path=/')
    expect(c).toContain('SameSite=Lax')
    expect(c).toContain('HttpOnly')
  })
  it('URL-encodes the value and includes Max-Age when set', () => {
    const c = serializeCookie('k', 'a b', { maxAgeSeconds: 60 })
    expect(c).toContain('k=a%20b')
    expect(c).toContain('Max-Age=60')
  })
  // `Secure` keys off the BUILD (`import.meta.env.DEV`), not `NODE_ENV`: the
  // deployed `vinxi start` never sets NODE_ENV, so keying off it shipped the
  // session cookie unprotected behind TLS. Same idiom as `dev-bypass.test.ts`.
  describe('Secure', () => {
    const env = import.meta.env as Record<string, unknown>
    let originalDev: unknown
    beforeEach(() => {
      originalDev = env.DEV
    })
    afterEach(() => {
      env.DEV = originalDev
    })

    it('is set in a production build even with NODE_ENV unset (the load-bearing case)', () => {
      env.DEV = false
      const prev = process.env.NODE_ENV
      try {
        delete process.env.NODE_ENV
        expect(serializeCookie('k', 'v')).toContain('Secure')
      } finally {
        process.env.NODE_ENV = prev
      }
    })

    it('is omitted on the dev server, which serves http://localhost', () => {
      env.DEV = true
      expect(serializeCookie('k', 'v')).not.toContain('Secure')
    })

    it('honours an explicit override in both directions', () => {
      env.DEV = true
      expect(serializeCookie('k', 'v', { secure: true })).toContain('Secure')
      env.DEV = false
      expect(serializeCookie('k', 'v', { secure: false })).not.toContain('Secure')
    })
  })
})

describe('sessionCookie / clearCookie', () => {
  it('sessionCookie carries the id + Max-Age + HttpOnly', () => {
    const c = sessionCookie('sid', 100)
    expect(c).toContain(`${SESSION_COOKIE}=sid`)
    expect(c).toContain('Max-Age=100')
    expect(c).toContain('HttpOnly')
  })
  it('clearCookie zeroes Max-Age', () => {
    expect(clearCookie(SESSION_COOKIE)).toContain('Max-Age=0')
  })
})
