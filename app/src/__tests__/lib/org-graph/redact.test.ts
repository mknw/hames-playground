/**
 * Output redaction for the live scripts.
 *
 * `mask()` is the only thing standing between a live-tenant script's stdout and
 * a real name in a scrollback, a CI log or a pasted PR body. It is output
 * hygiene rather than a security control — the graph still holds the cleartext —
 * but it is the control that decides whether these transcripts can be shown to
 * anyone, so the property that matters is asserted directly: **no alphanumeric
 * run survives past its first character.**
 */
import { describe, it, expect } from 'vitest'
import { formatCounts, mask, maskAll } from '../../../lib/org-graph/scripts/_redact'

describe('mask', () => {
  it('keeps the first character of each run and the separators', () => {
    expect(mask('Jan Van Damme')).toBe('J·· V·· D····')
    expect(mask('jan.van.damme@dtsc.test')).toBe('j··.v··.d····@d···.t···')
  })

  it('leaves no readable substring of any run', () => {
    // The property, not the format: whatever the shape of the input, nothing
    // longer than one character of any word survives.
    for (const input of [
      'Jan Van Damme',
      'José Núñez',
      'jean-pierre.dubois@example.test',
      'Müller, Ann-Sofie',
      'ABCDEFGHIJ',
    ]) {
      for (const run of input.match(/[\p{L}\p{N}]+/gu) ?? []) {
        if (run.length > 1) expect(mask(input)).not.toContain(run)
      }
    }
  })

  it('preserves shape — length, word count and whether it is an address', () => {
    // Shape is what makes a masked line useful: you can still see that two
    // printed literals are the same length, or that one is an email.
    const value = 'Sofie Maes'
    expect(mask(value)).toHaveLength(value.length)
    expect(mask(value).split(' ')).toHaveLength(2)
    expect(mask('a@b.test')).toContain('@')
  })

  it('handles non-ASCII letters as single characters, not bytes', () => {
    // A byte-wise mask would split 'é' and emit mojibake into the transcript.
    expect(mask('José')).toBe('J···')
    expect(mask('Núñez')).toBe('N····')
  })

  it('leaves a single character and an empty string alone', () => {
    expect(mask('A')).toBe('A')
    expect(mask('')).toBe('')
    expect(mask('A. B')).toBe('A. B')
  })

  it('masks digits too', () => {
    // An employee number or a phone fragment is as identifying as a name.
    expect(mask('user12345')).toBe('u········')
  })

  it('maskAll joins a list', () => {
    expect(maskAll(['Jan Van Damme', 'Sofie Maes'])).toBe('J·· V·· D····, S···· M···')
    expect(maskAll([])).toBe('')
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
