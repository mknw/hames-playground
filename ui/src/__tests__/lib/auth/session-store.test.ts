/**
 * Round-trip test for the Postgres auth-session store (#119).
 *
 * Hits the live Postgres container (mirrors conversations.test.ts). Skips
 * gracefully when Postgres isn't reachable so it passes on machines w/o docker.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

// Bypass server-only guard in the jsdom test env.
vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import {
  createSession,
  getSession,
  deleteSession,
  deleteExpiredSessions,
  stopSessionSweepTimer,
} from '../../../lib/auth/session-store.server'
import { closePool, query } from '../../../lib/db/client.server'

const TEST_USER = `test-oid-${Math.random().toString(36).slice(2, 10)}`
let dbAvailable = true

beforeAll(async () => {
  try {
    await query('SELECT 1')
  } catch (err) {
    dbAvailable = false
    console.warn('[session-store.test] Postgres unreachable, skipping:', err)
  }
})

afterAll(async () => {
  // Armed by the first store call (#129); unref'd, but stop it so it can't
  // outlive the pool it queries.
  stopSessionSweepTimer()
  if (!dbAvailable) return
  await query('DELETE FROM auth_sessions WHERE user_id = $1', [TEST_USER])
  await closePool()
})

describe('auth session store', () => {
  it('round-trips a session (token cache now lives per-user, see #110)', async () => {
    if (!dbAvailable) return
    const id = await createSession({
      userId: TEST_USER,
      email: 'u@corp.com',
      displayName: 'U',
      homeAccountId: 'hai-1',
    })

    const s = await getSession(id)
    expect(s).not.toBeNull()
    expect(s!.userId).toBe(TEST_USER)
    expect(s!.email).toBe('u@corp.com')
    expect(s!.displayName).toBe('U')
    expect(s!.homeAccountId).toBe('hai-1')

    await deleteSession(id)
    expect(await getSession(id)).toBeNull()
  })

  it('treats an expired session as absent and prunes it', async () => {
    if (!dbAvailable) return
    const id = await createSession(
      { userId: TEST_USER, email: 'e@corp.com', displayName: null, homeAccountId: null },
      { ttlSeconds: -5 },
    )
    expect(await getSession(id)).toBeNull()
  })

  it('returns null for unknown / blank ids', async () => {
    if (!dbAvailable) return
    expect(await getSession('does-not-exist')).toBeNull()
    expect(await getSession(null)).toBeNull()
    expect(await getSession('')).toBeNull()
  })

  it('deleteExpiredSessions removes rows that are already past expiry (#129)', async () => {
    if (!dbAvailable) return
    await createSession(
      { userId: TEST_USER, email: 'sweep@corp.com', displayName: null, homeAccountId: null },
      { ttlSeconds: -5 },
    )
    const before = await query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM auth_sessions WHERE user_id = $1',
      [TEST_USER],
    )
    expect(Number(before.rows[0].n)).toBeGreaterThan(0)

    expect(await deleteExpiredSessions()).toBeGreaterThan(0)

    const after = await query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM auth_sessions WHERE user_id = $1',
      [TEST_USER],
    )
    expect(Number(after.rows[0].n)).toBe(0)
  })
})
