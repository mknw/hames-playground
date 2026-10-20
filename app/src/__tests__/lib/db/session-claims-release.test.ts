/**
 * The SQL a claim release sends (hermetic).
 *
 * `session-claims.test.ts` shows the same behaviour against a real database,
 * but it is skipped where none is reachable, so the statement itself is pinned
 * here.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [] }))
vi.mock('../../../lib/db/client.server', () => ({ query }))

const { releaseSessionClaim } = await import('../../../lib/db/session-claims.server')

describe('releaseSessionClaim', () => {
  it("deletes only the holder's row for the one session", async () => {
    await releaseSessionClaim('s-1', 'alice')
    const [sql, params] = query.mock.calls[0]
    // MUTATION: drop `AND user_id = $2` from the statement (keeping the params) → red.
    expect(sql).toMatch(/DELETE\s+FROM\s+session_claims/i)
    expect(sql).toMatch(/session_id\s*=\s*\$1/)
    expect(sql).toMatch(/user_id\s*=\s*\$2/)
    expect(params).toEqual(['s-1', 'alice'])
  })
})
