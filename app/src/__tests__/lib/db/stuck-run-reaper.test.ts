/**
 * `reapStuckConversations` — the stuck-run reaper (#273 D-a).
 *
 * Two halves, because they can fail independently:
 *
 *   1. A **statement pin** over a mocked `query()`. It is the half that can
 *      gate a change: it runs everywhere, and it holds the properties that are
 *      invisible at runtime — the threshold is a constant rather than a
 *      caller's value, `paused` is excluded, `updated_at` is not bumped, and no
 *      encrypted column is read.
 *   2. A **round trip** against the test database with seeded rows, which is
 *      the only way to check the parts Postgres decides: that `NOW()` is the
 *      database's clock, that `RETURNING` reports a row to exactly one of two
 *      concurrent sweepers, and that a second sweep is a no-op. It lives with
 *      the module's other round trips in `conversations.test.ts` — this file
 *      mocks `query()`, and the two cannot share a file — and it skips when the
 *      container is not up, so it cannot gate anything on its own; hence half 1.
 *
 * The rows it is written against are the shape the dev database actually had:
 * conversations left at `status='running'` by a process that died mid-turn, so
 * the `catch` in `turn.server.ts#runAndSave` that normally flips them
 * (sf-M2/sf-M3) never ran.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

const query = vi.fn()
vi.mock('../../../lib/db/client.server', () => ({
  query: (...args: unknown[]) => query(...args),
}))

import {
  reapStuckConversations,
  STUCK_RUN_TIMEOUT_MINUTES,
} from '../../../lib/db/conversations.server'

beforeEach(() => {
  query.mockReset()
  query.mockResolvedValue({ rows: [] })
})

describe('the reap statement', () => {
  it('claims only running rows that are past the threshold, and reports their ids', async () => {
    query.mockResolvedValue({ rows: [{ id: 'conv-1' }, { id: 'conv-2' }] })

    expect(await reapStuckConversations()).toEqual(['conv-1', 'conv-2'])

    const [sql, params] = query.mock.calls[0] as [string, unknown[] | undefined]
    expect(sql).toContain('UPDATE conversations')
    expect(sql).toContain("SET status = 'error'")
    expect(sql).toContain("WHERE status = 'running'")
    expect(sql).toContain(`INTERVAL '${STUCK_RUN_TIMEOUT_MINUTES} minutes'`)
    expect(sql).toContain('RETURNING id')
    // The threshold is a constant interpolated into the SQL, so it must not be
    // reachable from an argument — a caller-supplied one would be an injection
    // point on a statement that writes every user's rows.
    expect(params).toBeUndefined()
  })

  it('measures staleness against the DATABASE clock, not this process', async () => {
    await reapStuckConversations()
    const [sql] = query.mock.calls[0] as [string]
    // The multi-instance property: two app instances with skewed host clocks
    // still agree on the deadline, and an instance that just booted judges
    // another instance's rows correctly because it consults no local memory of
    // which turns are live. A JS-computed timestamp bound as a parameter would
    // quietly reintroduce both problems.
    expect(sql).toContain('NOW() - INTERVAL')
    expect(sql).not.toMatch(/\$\d/)
  })

  it('never touches a paused row', async () => {
    await reapStuckConversations()
    const [sql] = query.mock.calls[0] as [string]
    // An approval gate waits for a person for as long as that takes; reaping
    // one would discard resumable work.
    expect(sql).not.toContain('paused')
    expect(sql).toContain("status = 'running'")
  })

  it('leaves updated_at alone', async () => {
    await reapStuckConversations()
    const [sql] = query.mock.calls[0] as [string]
    // `updated_at` is the app's record of "this user did something" —
    // `countActiveUsers` reads exactly that column, per poll, per tab. A reap
    // is not something the user did, so bumping it would report every reaped
    // conversation's owner as active, and would replace the honest "abandoned
    // 40 minutes ago" in the sidebar with the sweep's own clock.
    expect(sql).not.toContain('updated_at =')
  })

  it('reads no encrypted column', async () => {
    await reapStuckConversations()
    const [sql] = query.mock.calls[0] as [string]
    // `title` and `context` are the encrypted columns on this table (#260); a
    // cross-user sweep must not need a key, and must not carry content.
    expect(sql).not.toMatch(/\btitle\b|\bcontext\b/i)
  })

  it('exceeds the longest legitimate turn', async () => {
    // The threshold's whole job. A running row is not written to between the
    // pre-seed and the final save, so "no state change" cannot tell a slow turn
    // from a dead process — the only protection for an in-flight turn is that
    // the threshold is longer than it can possibly be. The measured worst case
    // is the self-hosted cold start (146s, #273) inside a 600s per-call
    // timeout; anything under that reaps live turns.
    expect(STUCK_RUN_TIMEOUT_MINUTES).toBeGreaterThanOrEqual(11)
  })
})
