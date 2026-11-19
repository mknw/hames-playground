/**
 * The admin allow-list — the pure rules behind the 403 gate.
 *
 * `ADMIN_EMAILS` is the whole mechanism (the app had no admin concept to
 * build on), so the rules it implies are worth pinning: nobody is an admin
 * when the var is unset, matching is case- and space-insensitive, and the
 * `*@domain` wildcard behaves exactly as `allowList.ts`'s does — the two
 * lists share one syntax so an operator who learned one learned both.
 */
import { describe, it, expect } from 'vitest'
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
