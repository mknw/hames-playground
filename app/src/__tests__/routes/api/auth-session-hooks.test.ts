/**
 * The session-lifecycle hook points (#131).
 *
 * `session_end` is asserted through the real logout route, which is where the
 * ordering actually matters: the owner has to be resolved from the opaque
 * cookie BEFORE the session row is deleted, or there is nothing left to map it
 * back to a user. Sign-out must also survive a routine or lookup failure.
 *
 * (`session_start` lives in `/api/auth/callback`, behind a full MSAL code
 * redemption; its hook is covered at the dispatcher level in
 * `lib/routines/dispatch.test.ts`.)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const calls: string[] = []

const getSession = vi.fn<(id: string) => Promise<{ userId: string } | null>>(async () => {
  calls.push('getSession')
  return { userId: 'user-1' }
})
const deleteSession = vi.fn<(id: string) => Promise<void>>(async () => {
  calls.push('deleteSession')
})
vi.mock('~/lib/auth/session-store.server', () => ({ getSession, deleteSession }))

const onSessionEnd = vi.fn<(userId: string) => void>(() => {
  calls.push('onSessionEnd')
})
vi.mock('~/lib/routines/dispatch.server', () => ({ onSessionEnd }))

vi.mock('~/lib/auth/entra.server', () => ({ buildLogoutUrl: () => 'https://idp/logout' }))
vi.mock('~/lib/auth/entra-config.server', () => ({
  isEntraConfigured: () => false,
  buildEntraConfig: () => ({}),
}))

const { GET } = await import('../../../routes/api/auth/logout')

function evt(cookie?: string) {
  return {
    params: {},
    request: new Request('http://x/api/auth/logout', {
      headers: cookie ? { cookie } : {},
    }),
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  calls.length = 0
  getSession.mockImplementation(async () => {
    calls.push('getSession')
    return { userId: 'user-1' }
  })
  deleteSession.mockImplementation(async () => {
    calls.push('deleteSession')
  })
})

describe('GET /api/auth/logout', () => {
  it('resolves the owner before deleting the session, then fires session_end', async () => {
    const res = await GET(evt('kg_session=abc123'))

    expect(res.status).toBe(302)
    expect(calls).toEqual(['getSession', 'deleteSession', 'onSessionEnd'])
    expect(onSessionEnd).toHaveBeenCalledWith('user-1')
  })

  it('fires nothing when there is no session cookie', async () => {
    await GET(evt())
    expect(getSession).not.toHaveBeenCalled()
    expect(onSessionEnd).not.toHaveBeenCalled()
  })

  it('still signs out when the owner cannot be resolved', async () => {
    getSession.mockResolvedValue(null)
    const res = await GET(evt('kg_session=expired'))
    expect(res.status).toBe(302)
    expect(deleteSession).toHaveBeenCalled()
    expect(onSessionEnd).not.toHaveBeenCalled()
  })

  it('still signs out when the session lookup throws', async () => {
    getSession.mockRejectedValue(new Error('postgres down'))
    const res = await GET(evt('kg_session=abc123'))
    expect(res.status).toBe(302)
    expect(deleteSession).toHaveBeenCalled()
    expect(onSessionEnd).not.toHaveBeenCalled()
  })
})
