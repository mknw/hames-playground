/**
 * #531, hermetic: both conversation-delete paths run the memory erase on the
 * SAME transaction as the row delete, erase first, and never delete a
 * conversation outside that transaction. The DB-backed half (what the SQL
 * actually removes, and the rollback) is `memories-db-store.test.ts`; this half
 * is what CI's no-database `check` job sees.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const calls: string[] = []
const tx = {
  query: vi.fn(async (sql: string) => {
    calls.push(`tx:${sql.trim().split(/\s+/).slice(0, 3).join(' ')}`)
    return { rows: [{ id: 'conv-a' }] }
  }),
}
const query = vi.fn(async (sql: string) => {
  calls.push(`main:${sql.trim().split(/\s+/).slice(0, 3).join(' ')}`)
  return { rows: [] }
})
let txOpen = false
vi.mock('../../../lib/db/client.server', () => ({
  query: (...a: unknown[]) => query(...(a as [string])),
  withTransaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
    txOpen = true
    calls.push('BEGIN')
    try {
      const out = await fn(tx)
      calls.push('COMMIT')
      return out
    } catch (e) {
      calls.push('ROLLBACK')
      throw e
    } finally {
      txOpen = false
    }
  },
}))
const erase = vi.fn(async (_ids: readonly string[], _user: string, t: unknown) => {
  calls.push(`erase(inTx=${txOpen},sameTx=${t === tx})`)
  return 1
})
vi.mock('../../../lib/db/memories.server', () => ({
  deleteMemoriesForConversations: (...a: [readonly string[], string, unknown]) => erase(...a),
}))

const { deleteConversation, deleteConversations } =
  await import('../../../lib/db/conversations.server')

beforeEach(() => {
  calls.length = 0
  erase.mockClear()
})

describe('conversation delete → memory erase (#531)', () => {
  it.each([
    ['deleteConversation', () => deleteConversation('conv-a', 'user-a')],
    ['deleteConversations', () => deleteConversations(['conv-a'], 'user-a')],
  ])(
    '%s: erase first, on the same open transaction, then the row delete, then COMMIT',
    async (_n, run) => {
      await run()
      expect(erase).toHaveBeenCalledWith(['conv-a'], 'user-a', tx)
      expect(calls).toEqual([
        'BEGIN',
        'erase(inTx=true,sameTx=true)',
        'tx:DELETE FROM conversations',
        'COMMIT',
      ])
      // The row delete never ran outside the transaction.
      expect(calls.some((c) => c.startsWith('main:DELETE'))).toBe(false)
    },
  )

  it('a failing row delete rolls the transaction back after the erase ran in it', async () => {
    tx.query.mockRejectedValueOnce(new Error('delete failed'))
    await expect(deleteConversations(['conv-a'], 'user-a')).rejects.toThrow('delete failed')
    expect(calls).toEqual(['BEGIN', 'erase(inTx=true,sameTx=true)', 'ROLLBACK'])
  })

  it('an empty batch opens no transaction and erases nothing', async () => {
    expect(await deleteConversations([], 'user-a')).toEqual([])
    expect(calls).toEqual([])
  })
})
