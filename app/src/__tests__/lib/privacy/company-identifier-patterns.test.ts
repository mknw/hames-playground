/**
 * The pattern loader behind the company-domain source scan: a malformed line
 * in the secret is reported by line number only, and nothing of the line's
 * content reaches the error a CI log would print.
 */
import { describe, it, expect } from 'vitest'
import { loadIdentifierPatterns, PatternSecretError } from './company-identifier-patterns'

/** A distinctive value no real pattern would contain, so a leak is unambiguous. */
const SENTINEL = 'zq7sentinelvx'

function thrown(raw: string): unknown {
  try {
    loadIdentifierPatterns(raw)
  } catch (err) {
    return err
  }
  throw new Error('expected loadIdentifierPatterns to throw')
}

/** Everything a test runner could print about an error. */
function printable(err: unknown): string {
  const e = err as Error & { cause?: unknown }
  return [String(e), e.message, e.stack ?? '', String(e.cause ?? ''), JSON.stringify(e)].join('\n')
}

describe('loadIdentifierPatterns', () => {
  it('reads one case-insensitive pattern per non-blank line', () => {
    const patterns = loadIdentifierPatterns('alpha\\.test\n\n  beta-[0-9]+  \n')
    expect(patterns).toHaveLength(2)
    expect(patterns[0].test('x ALPHA.TEST y')).toBe(true)
    expect(patterns[1].test('beta-42')).toBe(true)
  })

  it('returns nothing for an unset or blank secret', () => {
    expect(loadIdentifierPatterns(undefined)).toEqual([])
    expect(loadIdentifierPatterns('\n  \n')).toEqual([])
  })

  it('reports a malformed line by its number and never echoes its content', () => {
    const err = thrown(`valid\\.example\n\n${SENTINEL}(unclosed\nalso[valid]`)

    expect(err).toBeInstanceOf(PatternSecretError)
    expect((err as PatternSecretError).lines).toEqual([3])
    expect((err as Error).message).toMatch(/pattern on line 3 is not a valid regular expression/)
    // The leak this pins: V8's SyntaxError quotes the whole source, and a CI
    // log on this repository is public.
    expect(printable(err)).not.toContain(SENTINEL)
    expect(printable(err)).not.toContain('unclosed')
    expect(printable(err)).not.toContain('valid\\.example')
  })

  it('names every malformed line in one error', () => {
    const err = thrown(`(${SENTINEL}\nok\n[${SENTINEL}`) as PatternSecretError
    expect(err.lines).toEqual([1, 3])
    expect(printable(err)).not.toContain(SENTINEL)
  })
})
