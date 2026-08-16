/**
 * HMAC cookie signing (#119). Keys are injectable so no env is touched.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import {
  signPayload,
  verifyPayload,
  newOpaqueId,
  SIGNED_PAYLOAD_MAX_AGE_MS,
} from '../../../lib/auth/cookie-signing.server'

const KEY = 'unit-test-secret'

afterEach(() => {
  vi.useRealTimers()
})

describe('signPayload / verifyPayload', () => {
  it('round-trips a JSON payload, stamping an issued-at', () => {
    const token = signPayload({ state: 's', verifier: 'v', nonce: 'n' }, KEY)
    const payload = verifyPayload<{ state: string; iat: number }>(token, KEY)
    expect(payload).toMatchObject({ state: 's', verifier: 'v', nonce: 'n' })
    expect(typeof payload!.iat).toBe('number')
  })

  it('rejects a tampered body (same signature)', () => {
    const token = signPayload({ state: 's' }, KEY)
    const sig = token.slice(token.lastIndexOf('.') + 1)
    const forgedBody = Buffer.from(JSON.stringify({ state: 'evil' })).toString('base64url')
    expect(verifyPayload(`${forgedBody}.${sig}`, KEY)).toBeNull()
  })

  it('rejects a wrong key', () => {
    const token = signPayload({ state: 's' }, KEY)
    expect(verifyPayload(token, 'different-key')).toBeNull()
  })

  it('rejects malformed / empty input', () => {
    expect(verifyPayload(null, KEY)).toBeNull()
    expect(verifyPayload(undefined, KEY)).toBeNull()
    expect(verifyPayload('', KEY)).toBeNull()
    expect(verifyPayload('no-dot', KEY)).toBeNull()
    expect(verifyPayload('.', KEY)).toBeNull()
    expect(verifyPayload('body.', KEY)).toBeNull()
  })

  it('rejects a validly-signed payload past the max age (#129)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-16T12:00:00Z'))
    const token = signPayload({ state: 's', verifier: 'v', nonce: 'n' }, KEY)

    // Inside the window it still verifies.
    vi.advanceTimersByTime(SIGNED_PAYLOAD_MAX_AGE_MS - 1_000)
    expect(verifyPayload(token, KEY)).toMatchObject({ state: 's' })

    // One tick past it, the same signature is no longer accepted.
    vi.advanceTimersByTime(2_000)
    expect(verifyPayload(token, KEY)).toBeNull()
  })

  it('honours an explicit max age and fails closed on a missing iat', () => {
    vi.useFakeTimers()
    const token = signPayload({ state: 's' }, KEY)
    vi.advanceTimersByTime(5_000)
    expect(verifyPayload(token, KEY, 1_000)).toBeNull()
    expect(verifyPayload(token, KEY, 10_000)).toMatchObject({ state: 's' })

    // A payload signed without an `iat` (pre-#129 shape) is not honoured.
    const body = Buffer.from(JSON.stringify({ state: 's' })).toString('base64url')
    const legacy = `${body}.${createHmac('sha256', KEY).update(body).digest('base64url')}`
    expect(verifyPayload(legacy, KEY)).toBeNull()
  })
})

describe('newOpaqueId', () => {
  it('is URL-safe and unique across calls', () => {
    const a = newOpaqueId()
    const b = newOpaqueId()
    expect(a).not.toBe(b)
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(a.length).toBeGreaterThanOrEqual(40)
  })
})
