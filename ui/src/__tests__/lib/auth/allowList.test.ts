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
