/**
 * The admin allow-list — the pure rules behind the 403 gate.
 *
 * `ADMIN_EMAILS` is the whole mechanism (the app had no admin concept to
 * build on), so the rules it implies are worth pinning: nobody is an admin
 * when the var is unset, matching is case- and space-insensitive, and the
 * `*@domain` wildcard behaves exactly as `allowList.ts`'s does — the two
 * lists share one syntax so an operator who learned one learned both.
 */
import { describe, it, expect, vi } from 'vitest'
import { getAdminEmails, isAdminEmail } from '../../../lib/auth/admin'

describe('getAdminEmails', () => {
  it('is empty when ADMIN_EMAILS is unset — nobody is an admin', () => {
    expect(getAdminEmails(undefined)).toEqual([])
  })

  it('splits, trims and lowercases a list', () => {
    expect(getAdminEmails(' Ada@Example.com , bob@example.com ,, ')).toEqual([
      'ada@example.com',
      'bob@example.com',
    ])
  })

  it('refuses a bare "*@" entry — a wildcard that names no domain — ignoring it and logging once', () => {
    // "*@" can never match anything (no address ends in a bare "@"), so an
    // operator who wrote it meant a domain. The parser drops it rather than
    // keeping a dead entry, and says so ONCE per process — this parse runs on
    // every admin check, so a per-call log would bury everything else.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(getAdminEmails('*@, ada@example.com')).toEqual(['ada@example.com'])
    expect(getAdminEmails('*@')).toEqual([])
    expect(warn).toHaveBeenCalledTimes(1) // once, not once per parse
    expect(warn.mock.calls[0][0]).toContain('*@')
    warn.mockRestore()
  })

  it('NFKC-normalizes entries, so compatibility characters fold before the comparison', () => {
    // Fullwidth Latin — the NFKC class that stands in for plain ASCII. On the
    // LIST side and on the CHECKED side the same fold applies, so one
    // spelling written with compatibility characters is one address, not a
    // second one to keep in step by hand.
    const fullwidth = 'ａｄａ＠ｅｘａｍｐｌｅ．ｃｏｍ'
    expect(getAdminEmails(fullwidth)).toEqual(['ada@example.com'])
    expect(isAdminEmail('ada@example.com', [fullwidth])).toBe(true)
    expect(isAdminEmail(fullwidth, ['ada@example.com'])).toBe(true)
    // The fold is form, not identity: a different address still does not match.
    expect(isAdminEmail('mallory@example.com', [fullwidth])).toBe(false)
  })
})

describe('isAdminEmail', () => {
  it('matches exactly, ignoring case and surrounding space', () => {
    expect(isAdminEmail('ada@example.com', ['ada@example.com'])).toBe(true)
    expect(isAdminEmail('  ADA@Example.COM ', ['ada@example.com'])).toBe(true)
    expect(isAdminEmail('mallory@example.com', ['ada@example.com'])).toBe(false)
  })

  it('covers a domain through the same *@domain wildcard the sign-in list accepts', () => {
    expect(isAdminEmail('ada@tenant.example', ['*@tenant.example'])).toBe(true)
    // Only the domain the wildcard names — not a suffix trick:
    expect(isAdminEmail('ada@nottenant.example', ['*@tenant.example'])).toBe(false)
  })

  it('is false for missing addresses and an empty list', () => {
    expect(isAdminEmail(null, [])).toBe(false)
    expect(isAdminEmail(undefined, [])).toBe(false)
    expect(isAdminEmail('ada@example.com', [])).toBe(false)
  })
})
