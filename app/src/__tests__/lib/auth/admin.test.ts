/**
 * The admin allow-list — the pure rules behind the 403 gate.
 *
 * `ADMIN_EMAILS` is the whole mechanism (the app had no admin concept to
 * build on), so the rules it implies are worth pinning: nobody is an admin
 * when the var is unset, matching is case- and space-insensitive, and the
 * `*@domain` wildcard behaves exactly as `allowList.ts`'s does — the two
 * lists share one syntax so an operator who learned one learned both.
 *
 * The two sides of the comparison are pinned SEPARATELY, because they are
 * treated differently on purpose: the list is canonicalized (NFKC + trim +
 * lowercase — the operator's spelling), while the checked address is refused
 * unless it is already plain printable ASCII and NFKC-stable, then compared
 * lowercased. A look-alike must never fold into the address it imitates.
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

  it('NFKC-normalizes LIST entries, so one spelling typed with compatibility characters is one address', () => {
    // Fullwidth Latin — the NFKC class that stands in for plain ASCII. The
    // fold applies to the LIST side only, so an entry written with
    // compatibility characters is one address, not a second one to keep in
    // step by hand.
    const fullwidth = 'ａｄａ＠ｅｘａｍｐｌｅ．ｃｏｍ'
    expect(getAdminEmails(fullwidth)).toEqual(['ada@example.com'])
    expect(isAdminEmail('ada@example.com', [fullwidth])).toBe(true)
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

  it('refuses a CHECKED address that is not plain ASCII — a look-alike never folds into the address it imitates', () => {
    // A fullwidth spelling of the whole address, checked against the plain
    // entry: folding it would make it match, so it must NOT be folded — the
    // checked side is refused, not canonicalized.
    expect(isAdminEmail('ａｄａ＠ｅｘａｍｐｌｅ．ｃｏｍ', ['ada@example.com'])).toBe(false)
    // A mathematical-bold glyph reads as the word it imitates ("owner") and
    // must not reach the comparison at all.
    expect(isAdminEmail('ｏwner@example.com', ['owner@example.com'])).toBe(false)
    expect(isAdminEmail('\u{1D428}wner@example.com', ['owner@example.com'])).toBe(false)
    // A fullwidth letter inside an otherwise plain address is the same refusal:
    // the address is not plain ASCII, so it is not the plain address.
    expect(isAdminEmail('ada@ｅxample.com', ['ada@example.com'])).toBe(false)
    // The refusal is about folding, not case: a plain uppercase ASCII
    // address still matches the lowercased entry.
    expect(isAdminEmail('ADA@EXAMPLE.COM', ['ada@example.com'])).toBe(true)
  })

  it('refuses a Kelvin-sign look-alike whose lowercase folds into the listed address', () => {
    // U+212A (KELVIN SIGN) is the one homoglyph the fullwidth cases above do
    // not cover: it is outside printable ASCII (so the ASCII check refuses
    // it) and NFKC-unstable (it folds to "K", so the NFKC-unchanged check
    // refuses it) — but `toLowerCase` alone folds it to a plain "k", which
    // is exactly the comparison those two checks exist to keep from
    // matching. Remove BOTH and this reddens: the look-alike would match.
    expect(isAdminEmail('\u212Aate@example.com', ['kate@example.com'])).toBe(false)
  })
})
