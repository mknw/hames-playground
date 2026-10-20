/**
 * Deleting a conversation releases its session's stash (hermetic).
 *
 * The claim half runs inside the delete's transaction (pinned in
 * `db/conversation-delete-erase.test.ts` and, against a real database, in
 * `db/session-claims.test.ts`); this file pins the half that runs after the
 * commit. Every pin names the mutation that reddens it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const deleteSessionStash = vi.fn<(sessionId: string) => Promise<void>>(async () => {})
vi.mock('@hames-ai/harness-patterns/stash/document-ingest.server', () => ({ deleteSessionStash }))

const claimOwners = new Map<string, string>()
vi.mock('../../../lib/db/session-claims.server', () => ({
  getSessionClaimOwner: async (id: string) => claimOwners.get(id) ?? null,
}))

const { releaseDeletedSessions } = await import('../../../lib/stash/release.server')

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  deleteSessionStash.mockClear()
  deleteSessionStash.mockImplementation(async () => {})
  claimOwners.clear()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => errorSpy.mockRestore())

describe('releaseDeletedSessions', () => {
  it('purges the stash of each deleted session by its id', async () => {
    await releaseDeletedSessions(['s-1', 's-2'])
    // MUTATION: remove the `deleteSessionStash` call → red.
    expect(deleteSessionStash.mock.calls).toEqual([['s-1'], ['s-2']])
  })

  it('logs a failed purge visibly and still resolves, purging the rest', async () => {
    deleteSessionStash.mockRejectedValueOnce(new Error('redis down'))
    await expect(releaseDeletedSessions(['s-1', 's-2'])).resolves.toBeUndefined()
    // MUTATION: swallow the error silently (empty catch) → red on the log line;
    // let it propagate (drop the try/catch) → red on `resolves`.
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0][0])).toContain('s-1')
    expect(String(errorSpy.mock.calls[0][1])).toContain('redis down')
    expect(deleteSessionStash).toHaveBeenCalledWith('s-2')
  })

  it('leaves a session alone while someone else still holds a live claim on it', async () => {
    claimOwners.set('s-held', 'someone-else')
    await releaseDeletedSessions(['s-held', 's-free'])
    // MUTATION: drop the `getSessionClaimOwner` check → red.
    expect(deleteSessionStash.mock.calls).toEqual([['s-free']])
  })

  it('does nothing for an empty list (a delete that removed no row)', async () => {
    await releaseDeletedSessions([])
    expect(deleteSessionStash).not.toHaveBeenCalled()
  })
})
