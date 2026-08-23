/**
 * Action token parsing + Bearer extraction.
 *
 * Covers the pure helpers behind `POST /api/agents/:id` auth: parsing the
 * YAML token map and pulling the credential out of an Authorization header.
 * The file-loading/caching path is exercised indirectly (it delegates to
 * `parseActionTokens`).
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

import { parseActionTokens, bearerSecret } from '../../../lib/auth/action-tokens.server'

describe('parseActionTokens', () => {
  it('maps secret → userId for well-formed entries', () => {
    const map = parseActionTokens(`
tokens:
  - label: phone
    secret: s3cr3t-A
    userId: user-1
  - secret: s3cr3t-B
    userId: user-2
`)
    expect(map.get('s3cr3t-A')).toBe('user-1')
    expect(map.get('s3cr3t-B')).toBe('user-2')
    expect(map.size).toBe(2)
  })

  it('trims whitespace around secret + userId', () => {
    const map = parseActionTokens(`
tokens:
  - secret: "  spaced  "
    userId: "  user-x  "
`)
    expect(map.get('spaced')).toBe('user-x')
  })

  it('skips entries missing a secret or userId', () => {
    const map = parseActionTokens(`
tokens:
  - secret: only-secret
  - userId: only-user
  - secret: ""
    userId: blank
  - secret: good
    userId: u
`)
    expect(map.size).toBe(1)
    expect(map.get('good')).toBe('u')
  })

  it('returns an empty map for missing/empty/invalid yaml', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(parseActionTokens('').size).toBe(0)
    expect(parseActionTokens('tokens: []').size).toBe(0)
    expect(parseActionTokens('not: a token file').size).toBe(0)
    expect(parseActionTokens(': : : not yaml').size).toBe(0)
    err.mockRestore()
  })

  // sf-M5. An empty map means every trigger gets a 401 — the same symptom as a
  // wrong token — so a broken file used to be indistinguishable from a bad
  // credential, with nothing in the log to tell them apart.
  describe('degradations are logged (sf-M5)', () => {
    it('reports a YAML parse failure, not just an empty map', () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(parseActionTokens(': : : not yaml').size).toBe(0)
      expect(err).toHaveBeenCalledWith(expect.stringContaining('not valid YAML'), expect.anything())
      err.mockRestore()
    })

    it('reports a `tokens` key that is not a list', () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(parseActionTokens('tokens: a-string').size).toBe(0)
      expect(err).toHaveBeenCalledWith(expect.stringContaining('not a list'))
      err.mockRestore()
    })

    it('stays quiet when `tokens` is simply absent (a legitimate empty file)', () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(parseActionTokens('# nothing here yet\n').size).toBe(0)
      expect(err).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
      err.mockRestore()
      warn.mockRestore()
    })

    it('counts skipped entries without ever logging a secret', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      parseActionTokens(`
tokens:
  - secret: only-secret
  - userId: only-user
  - secret: good
    userId: u
`)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipped 2 of 3'))
      // The whole point of the file is that these do not get logged.
      expect(warn.mock.calls[0][0]).not.toContain('only-secret')
      expect(warn.mock.calls[0][0]).not.toContain('good')
      warn.mockRestore()
    })
  })
})

describe('bearerSecret', () => {
  it('extracts the credential from a Bearer header', () => {
    expect(bearerSecret('Bearer abc123')).toBe('abc123')
    expect(bearerSecret('bearer abc123')).toBe('abc123') // case-insensitive scheme
    expect(bearerSecret('Bearer   padded  ')).toBe('padded')
  })

  it('returns null for missing or non-Bearer headers', () => {
    expect(bearerSecret(null)).toBeNull()
    expect(bearerSecret('')).toBeNull()
    expect(bearerSecret('Basic abc')).toBeNull()
    expect(bearerSecret('abc123')).toBeNull()
  })
})
