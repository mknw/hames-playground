/**
 * `cookie-signing.server.ts` residuals: the env-derived default HMAC key and
 * the malformed-body exit of `verifyPayload`.
 *
 * A missing `AUTH_SESSION_SECRET` must be a loud failure rather than an
 * implicit empty key — an empty key would make every forged handshake cookie
 * verify.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHmac } from 'node:crypto'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

import { signPayload, verifyPayload } from '../../../lib/auth/cookie-signing.server'

// `process.env` is typed with required keys, so deletions go through this
// widened alias.
const env = process.env as Record<string, string | undefined>

const saved = env.AUTH_SESSION_SECRET

beforeEach(() => {
  delete env.AUTH_SESSION_SECRET
})

afterEach(() => {
  if (saved === undefined) delete env.AUTH_SESSION_SECRET
  else env.AUTH_SESSION_SECRET = saved
})

describe('default signing key', () => {
  it('signs and verifies with the configured session secret', () => {
    env.AUTH_SESSION_SECRET = 'env-secret'

    expect(verifyPayload(signPayload({ state: 'st' }))).toMatchObject({ state: 'st' })
  })

  it('throws when AUTH_SESSION_SECRET is unset', () => {
    expect(() => signPayload({ state: 'st' })).toThrow(/AUTH_SESSION_SECRET is not set/)
    expect(() => verifyPayload('anything.sig')).toThrow(/AUTH_SESSION_SECRET is not set/)
  })

  it('throws when AUTH_SESSION_SECRET is whitespace only', () => {
    env.AUTH_SESSION_SECRET = '   '

    expect(() => signPayload({ state: 'st' })).toThrow(/AUTH_SESSION_SECRET is not set/)
  })
})

describe('verifyPayload on a well-signed but non-JSON body', () => {
  it('returns null rather than throwing', () => {
    const key = 'k'
    const body = Buffer.from('not-json').toString('base64url')
    const sig = createHmac('sha256', key).update(body).digest('base64url')

    expect(verifyPayload(`${body}.${sig}`, key)).toBeNull()
  })
})
