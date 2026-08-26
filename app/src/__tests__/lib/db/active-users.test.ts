/**
 * `countActiveUsers` — the one cross-user aggregate over `conversations`.
 *
 * Hermetic: `db/client.server` is mocked, so this pins the *statement* rather
 * than a live Postgres (the round-trip half lives in `conversations.test.ts`,
 * which skips when the container is not up and so cannot gate a change).
 *
 * What each case guards:
 *   - the window is a constant in the SQL, never a caller's value.
 *   - `COUNT` arrives from `pg` as a STRING, and an empty table must read 0
 *     rather than NaN.
 *   - the query reads only the two plaintext columns — no title, no `context`
 *     blob — which is what keeps this aggregate out of #260's encryption seam
 *     while still living in the module that owns the table.
 *   - the index that makes it cheap actually exists.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

const query = vi.fn()
vi.mock('../../../lib/db/client.server', () => ({
  query: (...args: unknown[]) => query(...args),
}))

import { ACTIVE_WINDOW_MINUTES, countActiveUsers } from '../../../lib/db/conversations.server'

beforeEach(() => {
  query.mockReset()
  query.mockResolvedValue({ rows: [] })
})

describe('countActiveUsers', () => {
  it('counts distinct owners of recently touched conversations', async () => {
    query.mockResolvedValue({ rows: [{ active: '3' }] })
    expect(await countActiveUsers()).toBe(3)

    const [sql, params] = query.mock.calls[0] as [string, unknown[] | undefined]
    expect(sql).toContain('COUNT(DISTINCT user_id)')
    expect(sql).toContain('FROM conversations')
    expect(sql).toContain(`INTERVAL '${ACTIVE_WINDOW_MINUTES} minutes'`)
    // The window is a constant, never a caller's value: this query interpolates
    // it, so it must not be reachable from an argument.
    expect(params).toBeUndefined()
  })

  it('reads nothing but the two plaintext columns', async () => {
    await countActiveUsers()
    const [sql] = query.mock.calls[0] as [string]
    // `title` and `context` are the encrypted columns on this table (#260).
    // This aggregate touching either would make the header's cheapest number a
    // decrypt-per-row, and would put personal content on a polled surface.
    expect(sql).not.toMatch(/\btitle\b|\bcontext\b/i)
  })

  it('parses the string COUNT returns', async () => {
    query.mockResolvedValue({ rows: [{ active: '12' }] })
    expect(await countActiveUsers()).toBe(12)
  })

  it('reads 0 when the table is empty rather than NaN', async () => {
    query.mockResolvedValue({ rows: [] })
    expect(await countActiveUsers()).toBe(0)
  })

  it('has an index it can actually seek on', () => {
    // The query filters `conversations` on `updated_at` ALONE. Both composite
    // indexes on that table lead on `user_id`, so neither can seek it: as
    // shipped this was an index-only scan of every conversation ever (measured
    // on 200k rows: 808 buffers / cost 4824, against 4 / 9 with the index
    // below), running per 15s poll, per tab, per user, on every route — under
    // three docstrings calling it "two small indexed reads".
    //
    // A source scan because the schema is a SQL string, not a value: a unit
    // test of `countActiveUsers` passes whether or not the index exists, which
    // is exactly how this shipped.
    const schema = readFileSync(join(process.cwd(), 'src/lib/db/client.server.ts'), 'utf8')
    const indexes = [...schema.matchAll(/CREATE INDEX[^;]*?ON conversations \(([^)]*)\)/gi)].map(
      (m) => m[1].trim(),
    )
    const leadsOnUpdatedAt = indexes.some((cols) => /^updated_at\b/i.test(cols))
    expect(leadsOnUpdatedAt, `indexes on conversations: ${indexes.join(' | ')}`).toBe(true)
  })
})
