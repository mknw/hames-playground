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

import {
  parseActionTokens,
  bearerSecret,
} from '../../../lib/auth/action-tokens.server'

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
    expect(parseActionTokens('').size).toBe(0)
    expect(parseActionTokens('tokens: []').size).toBe(0)
    expect(parseActionTokens('not: a token file').size).toBe(0)
    expect(parseActionTokens(': : : not yaml').size).toBe(0)
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
