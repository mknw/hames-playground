/**
 * Profile server action — the browser-reachable half.
 *
 * Every export of a `'use server'` module is an RPC a client can call, so what
 * matters here is the gate and who the owner is:
 *
 *   - the export authenticates BEFORE it opens any resource, so an
 *     unauthenticated call reads nobody's name, mail address or preference;
 *   - it takes NO ARGUMENTS, so a caller cannot name whose profile to load —
 *     the id comes from the session and is passed down to `auth/users.server.ts`
 *     and `db/user-prefs.server.ts`, both of which are deliberately not
 *     `'use server'` modules for exactly that reason;
 *   - the encrypted `users` columns are read through the repository module that
 *     owns them (this file therefore mocks `getUser`, not `query`);
 *   - a caller with no `users` row — the dev bypass writes none — falls back to
 *     the session's own snapshot instead of rendering a blank identity.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const getAuthenticatedUser =
  vi.fn<() => Promise<{ id: string; email: string; displayName: string | null }>>()
vi.mock('../../../lib/auth/server', () => ({
  getAuthenticatedUser: () => getAuthenticatedUser(),
}))

const isBypassEnabled = vi.fn(() => false)
vi.mock('../../../lib/auth/dev-bypass', () => ({
  isBypassEnabled: () => isBypassEnabled(),
  BYPASS_USER: { id: 'bypass-user', email: 'dev@local' },
}))

type UserRow = {
  id: string
  email: string
  displayName: string | null
  tenantId: string | null
  firstLogin: Date
  lastLogin: Date
}
const getUser = vi.fn<(id: string) => Promise<UserRow | null>>()
vi.mock('../../../lib/auth/users.server', () => ({
  getUser: (id: string) => getUser(id),
}))

const resolveInferenceTier = vi.fn<(id: string) => Promise<'verda' | 'anthropic'>>()
vi.mock('../../../lib/db/user-prefs.server', () => ({
  resolveInferenceTier: (id: string) => resolveInferenceTier(id),
}))

const { getProfile } = await import('../../../lib/auth/profile.server')

const row = (over: Partial<UserRow> = {}): UserRow => ({
  id: 'user-1',
  email: 'stored@example.invalid',
  displayName: 'Stored Name',
  tenantId: 'tenant-1',
  firstLogin: new Date('2026-01-02T03:04:05.000Z'),
  lastLogin: new Date('2026-08-26T09:00:00.000Z'),
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  isBypassEnabled.mockReturnValue(false)
  getAuthenticatedUser.mockResolvedValue({
    id: 'user-1',
    email: 'session@example.invalid',
    displayName: 'Session Name',
  })
  getUser.mockResolvedValue(row())
  resolveInferenceTier.mockResolvedValue('verda')
})

describe('getProfile', () => {
  it('takes no owner id — the id comes from the session', async () => {
    // A parameter here would let the caller choose whose profile to read, which
    // is the whole reason the two repository modules below are not RPCs.
    expect(getProfile.length).toBe(0)

    await getProfile()

    expect(getUser).toHaveBeenCalledWith('user-1')
    expect(resolveInferenceTier).toHaveBeenCalledWith('user-1')
  })

  it('returns the stored row and the resolved tier', async () => {
    await expect(getProfile()).resolves.toEqual({
      email: 'stored@example.invalid',
      displayName: 'Stored Name',
      firstLogin: Date.UTC(2026, 0, 2, 3, 4, 5),
      lastLogin: Date.UTC(2026, 7, 26, 9, 0, 0),
      tier: 'verda',
    })
  })

  it('reads the tier through the shared resolver, not a rule of its own', async () => {
    // `resolveInferenceTier` is what the turn runner and the header switch both
    // call. Re-deriving "stored choice, else default" here is how a page ends up
    // naming a tier the next turn will not take.
    resolveInferenceTier.mockResolvedValue('anthropic')
    await expect(getProfile()).resolves.toMatchObject({ tier: 'anthropic' })
  })

  it('falls back to the session snapshot when there is no users row', async () => {
    getUser.mockResolvedValue(null)

    await expect(getProfile()).resolves.toEqual({
      email: 'session@example.invalid',
      displayName: 'Session Name',
      firstLogin: null,
      lastLogin: null,
      tier: 'verda',
    })
  })

  it('opens no resource when the caller is not authenticated', async () => {
    getAuthenticatedUser.mockRejectedValue(new Error('Authentication required'))

    await expect(getProfile()).rejects.toThrow('Authentication required')
    expect(getUser).not.toHaveBeenCalled()
    expect(resolveInferenceTier).not.toHaveBeenCalled()
  })

  it('serves the shared bypass identity when the dev bypass is on', async () => {
    isBypassEnabled.mockReturnValue(true)
    getUser.mockResolvedValue(null)

    await expect(getProfile()).resolves.toMatchObject({ email: 'dev@local' })
    expect(getAuthenticatedUser).not.toHaveBeenCalled()
    expect(getUser).toHaveBeenCalledWith('bypass-user')
  })
})
