/**
 * Output redaction for the live scripts.
 *
 * `mask()` is the only thing standing between a live-tenant script's stdout and
 * a real name in a scrollback, a CI log or a pasted PR body. It is output
 * hygiene rather than a security control — the graph still holds the cleartext —
 * but it is the control that decides whether these transcripts can be shown to
 * anyone, so the property that matters is asserted directly: **nothing about an
 * alphanumeric run survives, not its characters and not its length.**
 *
 * The length half is the one that was missing. An initial-preserving,
 * length-preserving mask is a signature: on a directory of a few dozen people,
 * `J·· V·· D····` is one person, and the repo it gets pasted into is public.
 * (That is the `Jan Van Damme` fixture below, not a colleague — illustrating
 * this defect with a real name would commit it.) These tests now pin the
 * absence of that signature, so a future "let's keep the initial, it reads
 * better" fails here rather than shipping.
 */
import { describe, it, expect } from 'vitest'
import { formatCounts, mask, maskAll, maskGraphIds } from '../../../lib/org-graph/scripts/_redact'

describe('mask', () => {
  it('replaces every run with the same three characters and keeps the separators', () => {
    expect(mask('Jan Van Damme')).toBe('··· ··· ···')
    expect(mask('jan.van.damme@example.test')).toBe('···.···.···@···.···')
  })

  it('leaves no readable substring of any run', () => {
    // The property, not the format: whatever the shape of the input, no word
    // survives in any part.
    for (const input of [
      'Jan Van Damme',
      'José Núñez',
      'jean-pierre.dubois@example.test',
      'Müller, Ann-Sofie',
      'ABCDEFGHIJ',
    ]) {
      for (const run of input.match(/[\p{L}\p{N}]+/gu) ?? []) {
        expect(mask(input)).not.toContain(run)
      }
    }
  })

  it('leaks neither the initial nor the length of a run', () => {
    // The re-identification finding, as an assertion. Two names of different
    // lengths and different initials must mask to the same string, or the mask
    // is a fingerprint of the person rather than a redaction.
    expect(mask('Sofie')).toBe(mask('Wolfgang'))
    expect(mask('A')).toBe(mask('ABCDEFGHIJ'))
    // Not even the length of the whole literal: a short name and a long one
    // with the same word count are indistinguishable.
    expect(mask('Jo Ba')).toBe(mask('Alexandra Beaumont'))
    // What DOES still survive, stated rather than glossed: the separator
    // structure. A hyphenated surname is two runs and masks differently from
    // an unhyphenated one, so word/part count is a residual signal. It is the
    // coarse shape the mask exists to keep, and it is why a caller that needs
    // to distinguish people prints an index instead.
    expect(mask('Ann-Sofie')).toBe('···-···')
    expect(mask('Ann-Sofie')).not.toBe(mask('Annsofie'))
  })

  it('keeps the coarse shape — word count, and whether it is an address', () => {
    // What is left is the only thing a masked line is still good for: telling
    // an address from a name. Telling two *people* apart is what an index is
    // for; see the smoke script.
    expect(mask('Sofie Maes').split(' ')).toHaveLength(2)
    expect(mask('a@b.test')).toContain('@')
    expect(mask('a@b.test')).not.toContain(' ')
  })

  it('handles non-ASCII letters as single characters, not bytes', () => {
    // A byte-wise mask would split 'é' and emit mojibake into the transcript;
    // it would also make a name's byte length visible through the dot count.
    expect(mask('José')).toBe('···')
    expect(mask('Núñez Müller')).toBe('··· ···')
  })

  it('masks a single character too, and leaves an empty string alone', () => {
    // A one-letter run is itself a signature — a middle initial.
    expect(mask('A')).toBe('···')
    expect(mask('')).toBe('')
    expect(mask('A. B')).toBe('···. ···')
  })

  it('masks digits too', () => {
    // An employee number or a phone fragment is as identifying as a name.
    expect(mask('user12345')).toBe('···')
  })

  it('maskAll joins a list', () => {
    expect(maskAll(['Jan Van Damme', 'Sofie Maes'])).toBe('··· ··· ···, ··· ···')
    expect(maskAll([])).toBe('')
  })
})

describe('maskGraphIds', () => {
  it('removes an Entra object id from an error message and keeps the rest', () => {
    // The shape a Graph failure actually has: the request path is quoted, and
    // on the memberships loop that path names one employee.
    const message =
      '[graph] GET /users/6f1b3c2a-0d4e-4f77-9a13-2b8c5d0e91af/memberOf failed: 403 Forbidden'
    expect(maskGraphIds(message)).toBe('[graph] GET /users/⟨id⟩/memberOf failed: 403 Forbidden')
  })

  it('removes every id, not just the first, and is case-insensitive', () => {
    const message = '6F1B3C2A-0D4E-4F77-9A13-2B8C5D0E91AF and 00000000-1111-2222-3333-444444444444'
    expect(maskGraphIds(message)).toBe('⟨id⟩ and ⟨id⟩')
  })

  it('leaves a message with no id untouched', () => {
    expect(maskGraphIds('could not read the database clock')).toBe(
      'could not read the database clock',
    )
  })
})

describe('formatCounts', () => {
  it('sorts by key and renders key=count', () => {
    expect(formatCounts({ jobTitle: 29, department: 48 })).toBe('department=48 jobTitle=29')
  })

  it('says none for an empty tally rather than printing an empty line', () => {
    expect(formatCounts({})).toBe('none')
  })

  it('never carries a value — only property names and numbers', () => {
    const rendered = formatCounts({ mail: 1 })
    expect(rendered).toBe('mail=1')
  })
})
