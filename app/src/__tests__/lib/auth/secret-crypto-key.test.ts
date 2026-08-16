/**
 * Key resolution for `secret-crypto.server.ts` (the envelope format itself is
 * covered in `secret-crypto.test.ts`).
 *
 * The store must fail CLOSED when no key is configured — silently falling back
 * to plaintext would put MSAL refresh tokens on disk in the clear — and must
 * accept either the dedicated key or the session secret, keeping the two
 * key-spaces distinct.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

import { encryptSecret, decryptSecret } from '../../../lib/auth/secret-crypto.server'

// `process.env` is typed with required keys, so deletions go through this
// widened alias.
const env = process.env as Record<string, string | undefined>

const saved = {
  token: env.TOKEN_ENCRYPTION_KEY,
  session: env.AUTH_SESSION_SECRET,
}

beforeEach(() => {
  delete env.TOKEN_ENCRYPTION_KEY
  delete env.AUTH_SESSION_SECRET
})

afterEach(() => {
  if (saved.token === undefined) delete env.TOKEN_ENCRYPTION_KEY
  else env.TOKEN_ENCRYPTION_KEY = saved.token
  if (saved.session === undefined) delete env.AUTH_SESSION_SECRET
  else env.AUTH_SESSION_SECRET = saved.session
})

describe('encryption key resolution', () => {
  it('round-trips using the dedicated TOKEN_ENCRYPTION_KEY', () => {
    env.TOKEN_ENCRYPTION_KEY = 'dedicated-key'

    expect(decryptSecret(encryptSecret('refresh-token'))).toBe('refresh-token')
  })

  it('accepts a short key by stretching it to 32 bytes', () => {
    env.TOKEN_ENCRYPTION_KEY = 'x'

    expect(decryptSecret(encryptSecret('tiny-key-ok'))).toBe('tiny-key-ok')
  })

  it('falls back to AUTH_SESSION_SECRET when no dedicated key is set', () => {
    env.AUTH_SESSION_SECRET = 'session-secret'

    expect(decryptSecret(encryptSecret('via-fallback'))).toBe('via-fallback')
  })

  it('prefers the dedicated key over the session secret', () => {
    env.TOKEN_ENCRYPTION_KEY = 'dedicated-key'
    env.AUTH_SESSION_SECRET = 'session-secret'
    const envelope = encryptSecret('pinned')

    delete env.TOKEN_ENCRYPTION_KEY
    // Now only the session secret is available — a different key-space, so the
    // envelope must not decrypt.
    expect(decryptSecret(envelope)).toBeNull()
  })

  it('ignores whitespace-only key values', () => {
    env.TOKEN_ENCRYPTION_KEY = '   '
    env.AUTH_SESSION_SECRET = '   '

    expect(() => encryptSecret('anything')).toThrow(/no encryption key/)
  })

  it('refuses to encrypt when nothing is configured', () => {
    expect(() => encryptSecret('anything')).toThrow(/Refusing to store secrets unencrypted/)
  })

  it('refuses to decrypt when nothing is configured', () => {
    expect(() => decryptSecret('v1.a.b.c')).toThrow(/no encryption key/)
  })
})
