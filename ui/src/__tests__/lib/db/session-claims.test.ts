/**
 * Round-trip test for session ownership claims.
 *
 * Hits the live Postgres container from docker-compose (same posture as
 * `conversations.test.ts`) and skips gracefully when it isn't reachable — the
 * point of these cases is the upsert's conflict behaviour, which only the real
 * database can demonstrate.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import { claimSession, getSessionClaimOwner } from '../../../lib/db/session-claims.server'
import { closePool, query } from '../../../lib/db/client.server'

const SUFFIX = Math.random().toString(36).slice(2, 10)
const sid = (name: string) => `test-session-${name}-${SUFFIX}`
const TTL = 60

let dbAvailable = true

beforeAll(async () => {
  try {
    await query('SELECT 1')
  } catch (err) {
    dbAvailable = false
    console.warn('[session-claims.test] Postgres unreachable, skipping:', err)
  }
})

afterAll(async () => {
  if (!dbAvailable) return
  await query('DELETE FROM session_claims WHERE session_id LIKE $1', [`test-session-%-${SUFFIX}`])
  await closePool()
})

describe('session claims', () => {
  it('records the first toucher and reports no owner for an untouched session', async () => {
    if (!dbAvailable) return
    expect(await getSessionClaimOwner(sid('fresh'))).toBeNull()

    expect(await claimSession(sid('first'), 'alice', TTL)).toBe('alice')
    expect(await getSessionClaimOwner(sid('first'))).toBe('alice')
  })

  it('returns the holder to a second, different claimer', async () => {
    if (!dbAvailable) return
    await claimSession(sid('contested'), 'alice', TTL)

    expect(await claimSession(sid('contested'), 'mallory', TTL)).toBe('alice')
    expect(await getSessionClaimOwner(sid('contested'))).toBe('alice')
  })

  it('refreshes the window when the holder claims again', async () => {
    if (!dbAvailable) return
    await claimSession(sid('refresh'), 'alice', 1)
    const before = await expiryOf(sid('refresh'))

    expect(await claimSession(sid('refresh'), 'alice', 3600)).toBe('alice')
    expect((await expiryOf(sid('refresh')))!.getTime()).toBeGreaterThan(before!.getTime())
  })

  it('treats an expired claim as absent and lets it be taken over', async () => {
    if (!dbAvailable) return
    await claimSession(sid('stale'), 'alice', TTL)
    await query(
      `UPDATE session_claims SET expires_at = NOW() - INTERVAL '1 second' WHERE session_id = $1`,
      [sid('stale')],
    )

    expect(await getSessionClaimOwner(sid('stale'))).toBeNull()
    expect(await claimSession(sid('stale'), 'bob', TTL)).toBe('bob')
    expect(await getSessionClaimOwner(sid('stale'))).toBe('bob')
  })
})

async function expiryOf(sessionId: string): Promise<Date | null> {
  const { rows } = await query<{ expires_at: Date }>(
    'SELECT expires_at FROM session_claims WHERE session_id = $1',
    [sessionId],
  )
  return rows.length > 0 ? rows[0].expires_at : null
}
