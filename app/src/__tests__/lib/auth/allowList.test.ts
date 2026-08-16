/**
 * Email allow-list (`allowList.ts`) — the authorization gate every server
 * action funnels through via `getAuthenticatedUser`.
 *
 * `VITE_ALLOWED_EMAILS` is stubbed per test; the assertions are about who gets
 * in and who is refused, including the fail-closed behaviour when the var is
 * absent.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'

import {
  getAllowedEmails,
  isEmailAllowed,
  requireAllowedEmail,
  getUnauthorizedMessage,
} from '../../../lib/auth/allowList'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('getAllowedEmails', () => {
  it('splits, trims and lowercases the configured list', () => {
    vi.stubEnv('VITE_ALLOWED_EMAILS', ' Ann@Corp.com , bob@corp.com ,, ')

    expect(getAllowedEmails()).toEqual(['ann@corp.com', 'bob@corp.com'])
  })

  it('prefers the runtime process.env value over the build-time inlined one', () => {
    // The container is built without app/.env, so the inlined value is absent
    // or stale; compose supplies the real list as a plain env var (#197).
    // Under Vitest, import.meta.env proxies process.env, so the two sources
    // are indistinguishable via vi.stubEnv/process.env alone — inject both
    // values directly through the function's seam to pin precedence for real.
    expect(getAllowedEmails('runtime@corp.com', 'baked-in@corp.com')).toEqual(['runtime@corp.com'])
  })

  it('falls back to the inlined value when the runtime one is absent', () => {
    // '' rather than `undefined` — an explicit `undefined` argument would
    // trigger the parameter's own default-value expression instead of
    // testing the fallback branch.
    expect(getAllowedEmails('', 'baked-in@corp.com')).toEqual(['baked-in@corp.com'])
  })

  it('returns an empty list and warns when the var is unset', () => {
    vi.stubEnv('VITE_ALLOWED_EMAILS', '')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(getAllowedEmails()).toEqual([])
    expect(warn).toHaveBeenCalled()
  })
})

describe('isEmailAllowed', () => {
  it('accepts an exact match regardless of case or padding', () => {
    vi.stubEnv('VITE_ALLOWED_EMAILS', 'ann@corp.com')

    expect(isEmailAllowed('  ANN@corp.com ')).toBe(true)
  })

  it('rejects an address that is not listed', () => {
    vi.stubEnv('VITE_ALLOWED_EMAILS', 'ann@corp.com')

    expect(isEmailAllowed('mallory@evil.com')).toBe(false)
  })

  it('accepts any address under a wildcard domain', () => {
    vi.stubEnv('VITE_ALLOWED_EMAILS', '*@corp.com')

    expect(isEmailAllowed('anyone@corp.com')).toBe(true)
    expect(isEmailAllowed('anyone@other.com')).toBe(false)
  })

  it('rejects a missing address', () => {
    vi.stubEnv('VITE_ALLOWED_EMAILS', '*@corp.com')

    expect(isEmailAllowed(null)).toBe(false)
    expect(isEmailAllowed(undefined)).toBe(false)
    expect(isEmailAllowed('')).toBe(false)
  })

  it('fails closed when nothing is configured', () => {
    vi.stubEnv('VITE_ALLOWED_EMAILS', '')
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(isEmailAllowed('ann@corp.com')).toBe(false)
  })
})

describe('requireAllowedEmail', () => {
  it('passes silently for an allowed address', () => {
    vi.stubEnv('VITE_ALLOWED_EMAILS', 'ann@corp.com')

    expect(() => requireAllowedEmail('ann@corp.com')).not.toThrow()
  })

  it('names the rejected address in the error', () => {
    vi.stubEnv('VITE_ALLOWED_EMAILS', 'ann@corp.com')

    expect(() => requireAllowedEmail('mallory@evil.com')).toThrow(
      /mallory@evil\.com is not authorized/,
    )
  })

  it('reports a missing address distinctly', () => {
    vi.stubEnv('VITE_ALLOWED_EMAILS', 'ann@corp.com')

    expect(() => requireAllowedEmail(null)).toThrow(/No email address provided/)
  })
})

describe('getUnauthorizedMessage', () => {
  it('points the user at the administrator without leaking the list', () => {
    const msg = getUnauthorizedMessage()

    expect(msg).toMatch(/contact the administrator/)
    expect(msg).not.toMatch(/@/)
  })
})
