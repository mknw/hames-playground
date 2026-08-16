/**
 * The server-side identity choke point (`auth/server.ts`).
 *
 * `getAuthenticatedUser` must throw for every way a caller can fail to be an
 * allow-listed, authenticated user; `getSessionUser` must turn each of those
 * into `null` instead, since the client AuthProvider treats a throw as a crash
 * rather than a sign-in redirect.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const getCurrentUser = vi.fn()

vi.mock('~/lib/auth/session', () => ({
  getCurrentUser: () => getCurrentUser(),
}))

import { getAuthenticatedUser, getSessionUser } from '../../../lib/auth/server'

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('VITE_ALLOWED_EMAILS', 'ann@corp.com')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('getAuthenticatedUser', () => {
  it('returns the allow-listed user', async () => {
    const user = { id: 'oid-1', email: 'ann@corp.com', displayName: 'Ann' }
    getCurrentUser.mockResolvedValue(user)

    await expect(getAuthenticatedUser()).resolves.toEqual(user)
  })

  it('throws when there is no session', async () => {
    getCurrentUser.mockResolvedValue(null)

    await expect(getAuthenticatedUser()).rejects.toThrow(/No user found in session/)
  })

  it('throws when the session carries no email', async () => {
    getCurrentUser.mockResolvedValue({ id: 'oid-1', email: '', displayName: null })

    await expect(getAuthenticatedUser()).rejects.toThrow(/no email address/i)
  })

  it('throws when the email is not allow-listed', async () => {
    getCurrentUser.mockResolvedValue({ id: 'oid-2', email: 'mallory@evil.com', displayName: null })

    await expect(getAuthenticatedUser()).rejects.toThrow(/not authorized/)
  })
})

describe('getSessionUser', () => {
  it('returns the user when the session is valid and allow-listed', async () => {
    const user = { id: 'oid-1', email: 'ann@corp.com', displayName: 'Ann' }
    getCurrentUser.mockResolvedValue(user)

    await expect(getSessionUser()).resolves.toEqual(user)
  })

  it('returns null instead of throwing for an unauthorized email', async () => {
    getCurrentUser.mockResolvedValue({ id: 'oid-2', email: 'mallory@evil.com', displayName: null })

    await expect(getSessionUser()).resolves.toBeNull()
  })

  it('returns null when there is no session', async () => {
    getCurrentUser.mockResolvedValue(null)

    await expect(getSessionUser()).resolves.toBeNull()
  })

  it('swallows a lookup failure and returns null', async () => {
    getCurrentUser.mockRejectedValue(new Error('postgres down'))

    await expect(getSessionUser()).resolves.toBeNull()
  })
})
