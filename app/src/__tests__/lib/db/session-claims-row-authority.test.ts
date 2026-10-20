/**
 * What `claimSession` does around the conversation row (hermetic).
 *
 * `session-claims.test.ts` shows the behaviour against a real database but is
 * skipped where none is reachable, so the ordering and the fail-closed paths are
 * pinned here: the row is read before anything is written, a foreign row means
 * no write is issued, and a store that cannot answer rejects.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const query = vi.fn(async (_sql: string, _params?: unknown[]): Promise<{ rows: unknown[] }> => ({
  rows: [],
}))
vi.mock('../../../lib/db/client.server', () => ({ query }))

const getConversationOwner = vi.fn<(id: string) => Promise<string | null>>(async () => null)
vi.mock('../../../lib/db/conversations.server', () => ({ getConversationOwner }))

const { claimSession } = await import('../../../lib/db/session-claims.server')

const writes = () => query.mock.calls.filter(([sql]) => /INSERT\s+INTO\s+session_claims/i.test(sql))

beforeEach(() => {
  query.mockReset()
  query.mockResolvedValue({ rows: [] })
  getConversationOwner.mockReset()
  getConversationOwner.mockResolvedValue(null)
})

describe('claimSession and the conversation row', () => {
  it("issues no write for a session whose row is another user's, and names that user", async () => {
    getConversationOwner.mockResolvedValue('alice')
    // MUTATION: drop the early return on a foreign row → red.
    expect(await claimSession('s-1', 'mallory', 60)).toBe('alice')
    expect(writes()).toHaveLength(0)
  })

  it('prefers the live holder over the row owner when answering a refused claim', async () => {
    getConversationOwner.mockResolvedValue('alice')
    query.mockResolvedValueOnce({ rows: [{ user_id: 'carol' }] })
    expect(await claimSession('s-1', 'mallory', 60)).toBe('carol')
    expect(writes()).toHaveLength(0)
  })

  it.each([
    ['no row', null],
    ['the claimer’s own row', 'bob'],
  ])('goes on to the upsert with %s', async (_name, owner) => {
    getConversationOwner.mockResolvedValue(owner)
    query.mockResolvedValueOnce({ rows: [{ user_id: 'bob' }] })
    expect(await claimSession('s-1', 'bob', 60)).toBe('bob')
    // MUTATION: refuse on any row, or on none → red.
    expect(writes()).toHaveLength(1)
  })

  it('rejects, and writes nothing, when the row lookup fails', async () => {
    getConversationOwner.mockRejectedValue(new Error('db down'))
    // MUTATION: wrap the lookup in a `catch` that falls through to the upsert → red.
    await expect(claimSession('s-1', 'mallory', 60)).rejects.toThrow('db down')
    expect(query).not.toHaveBeenCalled()
  })

  it('rejects when the live-holder read of a refused claim fails', async () => {
    getConversationOwner.mockResolvedValue('alice')
    query.mockRejectedValueOnce(new Error('db down'))
    // MUTATION: swallow the read error and answer with the caller → red.
    await expect(claimSession('s-1', 'mallory', 60)).rejects.toThrow('db down')
  })
})
