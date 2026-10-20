/**
 * Deleting a conversation releases its session (hermetic): the stash is
 * cleared first, and the claim is dropped only once that fully succeeded.
 * Every pin names the mutation that reddens it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const order: string[] = []
const deleteSessionStash = vi.fn<(sessionId: string) => Promise<void>>(async (id) => {
  order.push(`purge:${id}`)
})
vi.mock('@hames-ai/harness-patterns/stash/document-ingest.server', () => ({ deleteSessionStash }))

const conversationRows = new Map<string, string>()
const getConversationOwner = vi.fn<(id: string) => Promise<string | null>>(
  async (id) => conversationRows.get(id) ?? null,
)
vi.mock('../../../lib/db/conversations.server', () => ({ getConversationOwner }))

const releaseSessionClaim = vi.fn<(sessionId: string, userId: string) => Promise<void>>(
  async (id) => {
    order.push(`claim:${id}`)
  },
)
vi.mock('../../../lib/db/session-claims.server', () => ({
  releaseSessionClaim,
}))

const { releaseDeletedSessions, RELEASE_CONCURRENCY } =
  await import('../../../lib/stash/release.server')

let errorSpy: ReturnType<typeof vi.spyOn>
beforeEach(() => {
  order.length = 0
  deleteSessionStash.mockClear()
  releaseSessionClaim.mockClear()
  deleteSessionStash.mockImplementation(async (id) => {
    order.push(`purge:${id}`)
  })
  releaseSessionClaim.mockImplementation(async (id) => {
    order.push(`claim:${id}`)
  })
  conversationRows.clear()
  getConversationOwner.mockReset()
  getConversationOwner.mockImplementation(async (id) => conversationRows.get(id) ?? null)
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  errorSpy.mockRestore()
  vi.useRealTimers()
})

describe('releaseDeletedSessions', () => {
  it("clears each session's stash, then drops the deleting user's claim on it", async () => {
    await releaseDeletedSessions(['s-1', 's-2'], 'alice')
    // MUTATION: remove the `deleteSessionStash` call → red.
    expect(deleteSessionStash.mock.calls.map(([id]) => id).sort()).toEqual(['s-1', 's-2'])
    // MUTATION: remove the `releaseSessionClaim` call → red; pass another user id → red.
    expect(releaseSessionClaim.mock.calls.sort()).toEqual([
      ['s-1', 'alice'],
      ['s-2', 'alice'],
    ])
  })

  it('never drops the claim before the clear has finished', async () => {
    let finishPurge!: () => void
    deleteSessionStash.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishPurge = () => {
            order.push('purge:done')
            resolve()
          }
        }),
    )
    const released = releaseDeletedSessions(['s-1'], 'alice')
    await vi.waitFor(() => expect(deleteSessionStash).toHaveBeenCalled())
    // MUTATION: drop the claim before awaiting the purge → red.
    expect(releaseSessionClaim).not.toHaveBeenCalled()
    finishPurge()
    await released
    expect(order).toEqual(['purge:done', 'claim:s-1'])
  })

  it('keeps the claim and logs visibly when the clear fails', async () => {
    deleteSessionStash.mockRejectedValueOnce(new Error('redis down'))
    await expect(releaseDeletedSessions(['s-1'], 'alice')).resolves.toBeUndefined()
    // MUTATION: drop the claim in the `catch` (or in a `finally`) → red.
    expect(releaseSessionClaim).not.toHaveBeenCalled()
    // MUTATION: swallow the error silently (empty catch) → red.
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0][0])).toContain('s-1')
    expect(String(errorSpy.mock.calls[0][1])).toContain('redis down')
  })

  it('a failed session does not stop the others', async () => {
    deleteSessionStash.mockRejectedValueOnce(new Error('partial'))
    await releaseDeletedSessions(['s-1', 's-2'], 'alice')
    expect(releaseSessionClaim.mock.calls).toEqual([['s-2', 'alice']])
  })

  it('never throws, even when the claim release itself fails', async () => {
    releaseSessionClaim.mockRejectedValueOnce(new Error('db down'))
    // MUTATION: drop the `try/catch` in `releaseOne` → red.
    await expect(releaseDeletedSessions(['s-1'], 'alice')).resolves.toBeUndefined()
    expect(String(errorSpy.mock.calls[0][1])).toContain('db down')
  })

  it("clears the stash and releases only the deleter's claim, whoever else holds one", async () => {
    // The claim repository scopes the DELETE to the deleter (`release-claims.test.ts`
    // shows a foreign claim surviving on a real database); here the caller must
    // ask under the deleter's id for every session, held or not.
    await releaseDeletedSessions(['s-held', 's-own'], 'alice')
    // MUTATION: skip a session another user holds a claim on → red.
    expect(deleteSessionStash.mock.calls.map(([id]) => id).sort()).toEqual(['s-held', 's-own'])
    // MUTATION: release under any user other than the deleter → red; skip the release → red.
    expect(releaseSessionClaim.mock.calls.sort()).toEqual([
      ['s-held', 'alice'],
      ['s-own', 'alice'],
    ])
  })

  it("keeps the deleter's claim when the clear of a held session fails", async () => {
    deleteSessionStash.mockRejectedValueOnce(new Error('redis down'))
    await releaseDeletedSessions(['s-held'], 'alice')
    // MUTATION: drop the claim regardless of the clear's outcome → red.
    expect(releaseSessionClaim).not.toHaveBeenCalled()
  })

  it('clears nothing and keeps the claim when a conversation row exists for the id', async () => {
    conversationRows.set('s-back', 'bob')
    await releaseDeletedSessions(['s-back', 's-gone'], 'alice')
    // MUTATION: drop the row re-check before the purge → red.
    expect(deleteSessionStash.mock.calls.map(([id]) => id)).toEqual(['s-gone'])
    expect(releaseSessionClaim.mock.calls).toEqual([['s-gone', 'alice']])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0][0])).toContain('s-back')
  })

  it('clears nothing, keeps the claim and logs the message when the row check fails', async () => {
    getConversationOwner.mockRejectedValueOnce(new Error('db down'))
    await expect(releaseDeletedSessions(['s-1'], 'alice')).resolves.toBeUndefined()
    // MUTATION: treat a failed row check as "no row" (swallow it and go on) → red.
    expect(deleteSessionStash).not.toHaveBeenCalled()
    expect(releaseSessionClaim).not.toHaveBeenCalled()
    // MUTATION: swallow the read error without logging it → red.
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(String(errorSpy.mock.calls[0][0])).toContain('s-1')
    expect(String(errorSpy.mock.calls[0][1])).toContain('db down')
  })

  it('does nothing for an empty list', async () => {
    await releaseDeletedSessions([], 'alice')
    expect(deleteSessionStash).not.toHaveBeenCalled()
    expect(releaseSessionClaim).not.toHaveBeenCalled()
  })

  it('runs a bounded number of sessions at once', async () => {
    let active = 0
    let peak = 0
    deleteSessionStash.mockImplementation(async () => {
      active++
      peak = Math.max(peak, active)
      await new Promise((r) => setTimeout(r, 5))
      active--
    })
    const ids = Array.from({ length: RELEASE_CONCURRENCY * 3 }, (_, i) => `s-${i}`)
    await releaseDeletedSessions(ids, 'alice')
    // MUTATION: start every session at once (no worker pool) → red.
    expect(peak).toBe(RELEASE_CONCURRENCY)
    expect(deleteSessionStash).toHaveBeenCalledTimes(ids.length)
  })

  it('stops starting sessions after the deadline and keeps their claims', async () => {
    vi.useFakeTimers()
    deleteSessionStash.mockImplementation(async (id) => {
      order.push(`purge:${id}`)
      vi.setSystemTime(Date.now() + 61_000)
    })
    const ids = Array.from({ length: 12 }, (_, i) => `s-${i}`)
    await releaseDeletedSessions(ids, 'alice')
    // MUTATION: remove the deadline check → red.
    expect(deleteSessionStash.mock.calls.length).toBeLessThan(ids.length)
    expect(releaseSessionClaim.mock.calls.length).toBe(deleteSessionStash.mock.calls.length)
    expect(String(errorSpy.mock.calls.at(-1)?.[0])).toContain('deadline')
  })
})
