/**
 * Round-trip test for session ownership claims.
 *
 * Hits the live Postgres container from docker-compose (same posture as
 * `conversations.test.ts`) and skips gracefully when it isn't reachable — the
 * point of these cases is the upsert's conflict behaviour, which only the real
 * database can demonstrate. The row-authority cases seed conversation rows
 * directly (only the owner column is read).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { skipWithoutDatabase } from '../../test-database'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import {
  claimSession,
  getSessionClaimOwner,
  releaseSessionClaim,
} from '../../../lib/db/session-claims.server'
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
  await query('DELETE FROM conversations WHERE id LIKE $1', [`test-session-%-${SUFFIX}`])
  await closePool()
})

describe('session claims', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it('records the first toucher and reports no owner for an untouched session', async () => {
    expect(await getSessionClaimOwner(sid('fresh'))).toBeNull()

    expect(await claimSession(sid('first'), 'alice', TTL)).toBe('alice')
    expect(await getSessionClaimOwner(sid('first'))).toBe('alice')
  })

  it('returns the holder to a second, different claimer', async () => {
    await claimSession(sid('contested'), 'alice', TTL)

    expect(await claimSession(sid('contested'), 'mallory', TTL)).toBe('alice')
    expect(await getSessionClaimOwner(sid('contested'))).toBe('alice')
  })

  it('refreshes the window when the holder claims again', async () => {
    await claimSession(sid('refresh'), 'alice', 1)
    const before = await expiryOf(sid('refresh'))

    expect(await claimSession(sid('refresh'), 'alice', 3600)).toBe('alice')
    expect((await expiryOf(sid('refresh')))!.getTime()).toBeGreaterThan(before!.getTime())
  })

  it('treats an expired claim as absent and lets it be taken over', async () => {
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

async function seedRow(sessionId: string, userId: string): Promise<void> {
  await query(
    `INSERT INTO conversations (id, user_id, agent_id, context) VALUES ($1, $2, 'general', '{}')`,
    [sessionId, userId],
  )
}

async function expireClaim(sessionId: string): Promise<void> {
  await query(
    `UPDATE session_claims SET expires_at = NOW() - INTERVAL '1 second' WHERE session_id = $1`,
    [sessionId],
  )
}

async function claimRow(sessionId: string): Promise<{ user_id: string; expires_at: Date } | null> {
  const { rows } = await query<{ user_id: string; expires_at: Date }>(
    'SELECT user_id, expires_at FROM session_claims WHERE session_id = $1',
    [sessionId],
  )
  return rows[0] ?? null
}

async function expiryOf(sessionId: string): Promise<Date | null> {
  const { rows } = await query<{ expires_at: Date }>(
    'SELECT expires_at FROM session_claims WHERE session_id = $1',
    [sessionId],
  )
  return rows.length > 0 ? rows[0].expires_at : null
}

describe('releasing a session claim', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it("removes the holder's claim row", async () => {
    await claimSession(sid('rel-1'), 'alice', TTL)
    await releaseSessionClaim(sid('rel-1'), 'alice')
    expect(await getSessionClaimOwner(sid('rel-1'))).toBeNull()
  })

  it("leaves another user's claim on the session untouched", async () => {
    await claimSession(sid('rel-2'), 'alice', TTL)
    await releaseSessionClaim(sid('rel-2'), 'bob')
    // MUTATION: drop the `user_id` predicate from the DELETE → red.
    expect(await getSessionClaimOwner(sid('rel-2'))).toBe('alice')
  })

  it('is idempotent and touches no other session', async () => {
    await claimSession(sid('rel-3'), 'alice', TTL)
    await claimSession(sid('rel-keep'), 'alice', TTL)
    await releaseSessionClaim(sid('rel-3'), 'alice')
    await expect(releaseSessionClaim(sid('rel-3'), 'alice')).resolves.toBeUndefined()
    expect(await getSessionClaimOwner(sid('rel-keep'))).toBe('alice')
  })
})

describe('the conversation row is the authority over a claim', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it("refuses to take over an expired claim when the row is another user's", async () => {
    await claimSession(sid('auth-1'), 'alice', TTL)
    await seedRow(sid('auth-1'), 'alice')
    await expireClaim(sid('auth-1'))
    const before = await claimRow(sid('auth-1'))

    // MUTATION: drop the `getConversationOwner` guard in `claimSession` → red.
    const holder = await claimSession(sid('auth-1'), 'mallory', TTL)
    expect(holder).not.toBe('mallory')
    expect(holder).toBe('alice')
    // Nothing was written: the expired row is exactly as it was.
    expect(await claimRow(sid('auth-1'))).toEqual(before)
  })

  it('records no claim at all for a foreign row with no claim', async () => {
    await seedRow(sid('auth-2'), 'alice')

    // MUTATION: guard only the conflict branch of the statement → red.
    expect(await claimSession(sid('auth-2'), 'mallory', TTL)).toBe('alice')
    expect(await claimRow(sid('auth-2'))).toBeNull()
  })

  it('answers with the live holder when someone else holds a live claim on a foreign row', async () => {
    await claimSession(sid('auth-3'), 'carol', TTL)
    await seedRow(sid('auth-3'), 'alice')

    expect(await claimSession(sid('auth-3'), 'mallory', TTL)).toBe('carol')
    expect((await claimRow(sid('auth-3')))?.user_id).toBe('carol')
  })

  it('still takes over an expired claim when no row exists', async () => {
    await claimSession(sid('auth-4'), 'alice', TTL)
    await expireClaim(sid('auth-4'))

    // MUTATION: refuse unless a row exists → red.
    expect(await claimSession(sid('auth-4'), 'bob', TTL)).toBe('bob')
    expect((await claimRow(sid('auth-4')))?.user_id).toBe('bob')
  })

  it("lets the row's own user re-claim an expired claim, refreshing the window", async () => {
    await claimSession(sid('auth-5'), 'alice', TTL)
    await seedRow(sid('auth-5'), 'bob')
    await expireClaim(sid('auth-5'))

    // MUTATION: refuse whenever a row exists, whoever owns it → red.
    expect(await claimSession(sid('auth-5'), 'bob', TTL)).toBe('bob')
    const claim = await claimRow(sid('auth-5'))
    expect(claim?.user_id).toBe('bob')
    expect(claim!.expires_at.getTime()).toBeGreaterThan(Date.now())
  })

  it("refreshes the holder's own live claim when the row is theirs", async () => {
    await claimSession(sid('auth-6'), 'alice', 1)
    await seedRow(sid('auth-6'), 'alice')
    const before = await claimRow(sid('auth-6'))

    expect(await claimSession(sid('auth-6'), 'alice', 3600)).toBe('alice')
    expect((await claimRow(sid('auth-6')))!.expires_at.getTime()).toBeGreaterThan(
      before!.expires_at.getTime(),
    )
  })
})
