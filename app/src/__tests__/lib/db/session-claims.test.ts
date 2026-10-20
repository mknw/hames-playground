/**
 * Round-trip test for session ownership claims.
 *
 * Hits the live Postgres container from docker-compose (same posture as
 * `conversations.test.ts`) and skips gracefully when it isn't reachable — the
 * point of these cases is the upsert's conflict behaviour, which only the real
 * database can demonstrate.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { skipWithoutDatabase } from '../../test-database'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import { claimSession, getSessionClaimOwner } from '../../../lib/db/session-claims.server'
import { closePool, query } from '../../../lib/db/client.server'
import {
  createConversation,
  deleteConversation,
  deleteConversations,
  getConversationOwner,
} from '../../../lib/db/conversations.server'

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

async function expiryOf(sessionId: string): Promise<Date | null> {
  const { rows } = await query<{ expires_at: Date }>(
    'SELECT expires_at FROM session_claims WHERE session_id = $1',
    [sessionId],
  )
  return rows.length > 0 ? rows[0].expires_at : null
}

describe('deleting a conversation releases its session claim', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  async function conversationWithClaim(name: string, owner: string) {
    await createConversation({
      id: sid(name),
      userId: owner,
      agentId: 'general',
      title: null,
      serializedContext: '{"events":[]}',
    })
    await claimSession(sid(name), owner, TTL)
  }
  const claimRows = async (name: string) =>
    (await query('SELECT 1 FROM session_claims WHERE session_id = $1', [sid(name)])).rows.length

  it("removes the owner's claim row with the conversation", async () => {
    await conversationWithClaim('own-1', 'alice')
    await deleteConversation(sid('own-1'), 'alice')
    // MUTATION: remove the `releaseSessionClaims` call → red.
    expect(await getConversationOwner(sid('own-1'))).toBeNull()
    expect(await claimRows('own-1')).toBe(0)
  })

  it('removes every claim in a bulk delete, and only those', async () => {
    await conversationWithClaim('bulk-a', 'alice')
    await conversationWithClaim('bulk-b', 'alice')
    await conversationWithClaim('bulk-keep', 'alice')
    expect(await deleteConversations([sid('bulk-a'), sid('bulk-b')], 'alice')).toHaveLength(2)
    expect(await claimRows('bulk-a')).toBe(0)
    expect(await claimRows('bulk-b')).toBe(0)
    expect(await claimRows('bulk-keep')).toBe(1)
  })

  it('releases nothing when another user asks for the delete', async () => {
    await conversationWithClaim('other-1', 'alice')
    expect(await deleteConversations([sid('other-1')], 'mallory')).toEqual([])
    // MUTATION: scope the claim delete by session id alone (drop `user_id`),
    // or run it for the requested ids instead of the deleted ones → red.
    expect(await getConversationOwner(sid('other-1'))).toBe('alice')
    expect(await getSessionClaimOwner(sid('other-1'))).toBe('alice')
  })

  it('leaves a claim another user holds on the session alone', async () => {
    await claimSession(sid('foreign'), 'bob', TTL)
    await createConversation({
      id: sid('foreign'),
      userId: 'alice',
      agentId: 'general',
      title: null,
      serializedContext: '{"events":[]}',
    })
    await deleteConversations([sid('foreign')], 'alice')
    expect(await getConversationOwner(sid('foreign'))).toBeNull()
    expect(await getSessionClaimOwner(sid('foreign'))).toBe('bob')
  })

  it('is idempotent: deleting again releases nothing and does not fail', async () => {
    await conversationWithClaim('again', 'alice')
    expect(await deleteConversations([sid('again')], 'alice')).toEqual([sid('again')])
    expect(await deleteConversations([sid('again')], 'alice')).toEqual([])
    expect(await claimRows('again')).toBe(0)
  })
})
