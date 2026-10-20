/**
 * Releasing a deleted conversation's session against real claim rows.
 *
 * `release.test.ts` pins the order and the error paths with the claim repository
 * mocked; this one runs the real `session_claims` statements, because "another
 * user's claim is untouched" is a property of the DELETE, not of the caller.
 * Skipped where no database is reachable. The stash purge is the only mock.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { skipWithoutDatabase } from '../../test-database'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

const { deleteSessionStash } = vi.hoisted(() => ({
  deleteSessionStash: vi.fn<(sessionId: string) => Promise<void>>(async () => {}),
}))
vi.mock('@hames-ai/harness-patterns/stash/document-ingest.server', () => ({ deleteSessionStash }))

import { claimSession, getSessionClaimOwner } from '../../../lib/db/session-claims.server'
import { releaseDeletedSessions } from '../../../lib/stash/release.server'
import { closePool, query } from '../../../lib/db/client.server'

const SUFFIX = Math.random().toString(36).slice(2, 10)
const sid = (name: string) => `test-release-${name}-${SUFFIX}`
const TTL = 60

let dbAvailable = true

beforeAll(async () => {
  try {
    await query('SELECT 1')
  } catch (err) {
    dbAvailable = false
    console.warn('[release-claims.test] Postgres unreachable, skipping:', err)
  }
})

afterAll(async () => {
  if (!dbAvailable) return
  await query('DELETE FROM session_claims WHERE session_id LIKE $1', [`test-release-%-${SUFFIX}`])
  await closePool()
})

beforeEach((ctx) => {
  deleteSessionStash.mockReset()
  deleteSessionStash.mockResolvedValue(undefined)
  skipWithoutDatabase(ctx, dbAvailable)
})

describe('releaseDeletedSessions against real claims', () => {
  it("purges the session and leaves another user's live claim in place", async () => {
    await claimSession(sid('held'), 'bob', TTL)

    await releaseDeletedSessions([sid('held')], 'alice')

    // MUTATION: skip the purge while another user holds a claim → red.
    expect(deleteSessionStash).toHaveBeenCalledWith(sid('held'))
    // MUTATION: drop the `user_id` predicate from the claim DELETE → red.
    expect(await getSessionClaimOwner(sid('held'))).toBe('bob')
  })

  it("drops the deleter's own claim once the purge has succeeded", async () => {
    await claimSession(sid('own'), 'alice', TTL)

    await releaseDeletedSessions([sid('own')], 'alice')

    expect(deleteSessionStash).toHaveBeenCalledWith(sid('own'))
    expect(await getSessionClaimOwner(sid('own'))).toBeNull()
  })

  it("keeps the deleter's own claim when the purge fails", async () => {
    await claimSession(sid('failed'), 'alice', TTL)
    deleteSessionStash.mockRejectedValue(new Error('redis down'))
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    await releaseDeletedSessions([sid('failed')], 'alice')
    errorSpy.mockRestore()

    // MUTATION: drop the claim before or regardless of the purge → red.
    expect(await getSessionClaimOwner(sid('failed'))).toBe('alice')
  })
})
