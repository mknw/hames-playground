/**
 * newSessionId — collision regression for #52.
 *
 * Solid's `createUniqueId()` minted `cl-${counter++}` on the client and reset
 * the counter on every page load, so fresh ids collided with previously-
 * persisted `cl-*` rows in Postgres. We replaced it with `crypto.randomUUID()`.
 * These tests guard the two properties that matter:
 *   1. Fresh ids never collide with one another within a session.
 *   2. Fresh ids never collide with the legacy `cl-{n}` id space that may
 *      still exist as opaque strings in the DB.
 */

import { afterEach, describe, it, expect, vi } from 'vitest'
import { newSessionId } from '../../lib/session-id'

const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

describe('newSessionId', () => {
  afterEach(() => vi.restoreAllMocks())

  it('produces no duplicates across 1000 calls', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 1000; i++) ids.add(newSessionId())
    expect(ids.size).toBe(1000)
  })

  it('never collides with legacy cl-{0..100} ids', () => {
    const legacy = new Set<string>()
    for (let i = 0; i <= 100; i++) legacy.add(`cl-${i}`)
    for (let i = 0; i < 1000; i++) {
      expect(legacy.has(newSessionId())).toBe(false)
    }
  })

  it('returns RFC 4122 v4-shaped strings (not cl-{n})', () => {
    const id = newSessionId()
    expect(id).toMatch(UUID_V4_REGEX)
    expect(id.startsWith('cl-')).toBe(false)
  })

  // Regression: in non-secure browser contexts (e.g. http://<lan-ip>:3444)
  // `crypto.randomUUID` is undefined and we must fall back to a manual
  // RFC 4122 v4 build from `crypto.getRandomValues`.
  it('falls back to getRandomValues when randomUUID is unavailable', () => {
    vi.spyOn(crypto, 'randomUUID').mockImplementation(
      () => { throw new TypeError('crypto.randomUUID is not a function') },
    )
    // Re-shape the spy so the `typeof === 'function'` guard rejects it.
    Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true })

    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) ids.add(newSessionId())
    expect(ids.size).toBe(100)
    for (const id of ids) expect(id).toMatch(UUID_V4_REGEX)
  })
})
