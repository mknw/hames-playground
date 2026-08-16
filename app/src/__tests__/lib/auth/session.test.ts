/**
 * `getCurrentUser` (`auth/session.ts`) — cookie → Postgres session row → the
 * `{ id, email, displayName }` shape every downstream consumer depends on.
 *
 * The request event, the cookie reader and the session store are all stubbed;
 * what is asserted is the mapping and the three "no user" exits.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const getRequestEvent = vi.fn()
const getSession = vi.fn()

vi.mock('solid-js/web', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('solid-js/web')
  return { ...actual, getRequestEvent: () => getRequestEvent() }
})
vi.mock('../../../lib/auth/session-store.server', () => ({
  getSession: (id: string | null) => getSession(id),
}))

import { getCurrentUser } from '../../../lib/auth/session'
import { SESSION_COOKIE } from '../../../lib/auth/cookies.server'

function eventWithCookie(cookie: string | null) {
  return {
    request: new Request('https://app.example/chat', {
      headers: cookie ? { cookie } : {},
    }),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getCurrentUser', () => {
  it('maps a live session row to the auth user shape', async () => {
    getRequestEvent.mockReturnValue(eventWithCookie(`${SESSION_COOKIE}=sid-1`))
    getSession.mockResolvedValue({
      userId: 'oid-1',
      email: 'ann@corp.com',
      displayName: 'Ann',
    })

    await expect(getCurrentUser()).resolves.toEqual({
      id: 'oid-1',
      email: 'ann@corp.com',
      displayName: 'Ann',
    })
    expect(getSession).toHaveBeenCalledWith('sid-1')
  })

  it('returns null when the session id is unknown or expired', async () => {
    getRequestEvent.mockReturnValue(eventWithCookie(`${SESSION_COOKIE}=stale`))
    getSession.mockResolvedValue(null)

    await expect(getCurrentUser()).resolves.toBeNull()
  })

  it('returns null when the request carries no session cookie', async () => {
    getRequestEvent.mockReturnValue(eventWithCookie(null))
    getSession.mockResolvedValue(null)

    await expect(getCurrentUser()).resolves.toBeNull()
    expect(getSession).toHaveBeenCalledWith(null)
  })

  it('returns null outside a server request context', async () => {
    getRequestEvent.mockReturnValue(undefined)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})

    await expect(getCurrentUser()).resolves.toBeNull()
    expect(getSession).not.toHaveBeenCalled()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})
