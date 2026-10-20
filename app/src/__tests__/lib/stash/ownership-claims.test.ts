/**
 * `claimSessionOwnership` against real claim and conversation rows.
 *
 * The write gate used to look the row up itself and then call `claimSession`,
 * which looks it up again; it is now the one call, so these cases run the whole
 * path on a real database and would show the two layers drifting apart.
 * Skipped where no database is reachable.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { skipWithoutDatabase } from '../../test-database'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import { claimSessionOwnership } from '../../../lib/stash/ownership.server'
import { claimSession, getSessionClaimOwner } from '../../../lib/db/session-claims.server'
import { closePool, query } from '../../../lib/db/client.server'

const SUFFIX = Math.random().toString(36).slice(2, 10)
const sid = (name: string) => `test-ownership-${name}-${SUFFIX}`

let dbAvailable = true

beforeAll(async () => {
  try {
    await query('SELECT 1')
  } catch (err) {
    dbAvailable = false
    console.warn('[ownership-claims.test] Postgres unreachable, skipping:', err)
  }
})

afterAll(async () => {
  if (!dbAvailable) return
  await query('DELETE FROM session_claims WHERE session_id LIKE $1', [`test-ownership-%-${SUFFIX}`])
  await query('DELETE FROM conversations WHERE id LIKE $1', [`test-ownership-%-${SUFFIX}`])
  await closePool()
})

beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

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

describe('claimSessionOwnership against real rows', () => {
  it("refuses a user who is not the row's owner once the previous claim has expired", async () => {
    await claimSession(sid('expired'), 'alice', 60)
    await expireClaim(sid('expired'))
    await seedRow(sid('expired'), 'bob')

    // MUTATION: drop the row guard in `claimSession` → red.
    expect(await claimSessionOwnership(sid('expired'), 'mallory')).toBe(false)
    expect(await getSessionClaimOwner(sid('expired'))).toBeNull()
  })

  it('refuses a foreign row with no claim at all, and records no claim for the caller', async () => {
    await seedRow(sid('bare'), 'bob')

    expect(await claimSessionOwnership(sid('bare'), 'mallory')).toBe(false)
    expect(await getSessionClaimOwner(sid('bare'))).toBeNull()
  })

  it("lets the row's owner claim over an expired claim of someone else", async () => {
    await claimSession(sid('owner'), 'alice', 60)
    await expireClaim(sid('owner'))
    await seedRow(sid('owner'), 'bob')

    expect(await claimSessionOwnership(sid('owner'), 'bob')).toBe(true)
    expect(await getSessionClaimOwner(sid('owner'))).toBe('bob')
  })

  it('does not take the session from a live holder on a foreign row', async () => {
    await claimSession(sid('live'), 'alice', 60)
    await seedRow(sid('live'), 'bob')

    expect(await claimSessionOwnership(sid('live'), 'mallory')).toBe(false)
    expect(await getSessionClaimOwner(sid('live'))).toBe('alice')
  })
})
