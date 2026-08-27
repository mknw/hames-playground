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

import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  reapStuckConversations,
  STUCK_RUN_TIMEOUT_MINUTES,
  PER_CALL_TIMEOUT_MINUTES,
  CHAIN_OVERHEAD_CALLS,
} from '../../../lib/db/conversations.server'
import { SETTINGS_BOUNDS } from '../../../lib/settings'
import { DEFAULT_VERDA_WAKE_TIMEOUT_MS } from '../../../lib/inference/wake.server'

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

  it('exceeds the longest turn a browser can ask for, with margin', () => {
    // The threshold's whole job, re-derived here rather than restated (F3 on
    // #278). The previous pin was `>= 11` — one call at the per-call ceiling —
    // which held nothing: the shipped value of 20 minutes passed it, and so did
    // 11, and 20 minutes is exactly 2 × the 600s ceiling that CLAUDE.md
    // measures being hit TWICE in one turn during a burst into a sleeping box.
    // A 21-minute turn was duly reaped out from under itself in review.
    //
    // A running row gets no write between the pre-seed and the final save, so
    // the only protection a live turn has is that this number outlasts it. That
    // makes it a bound, and a bound has to be computed from the same ceilings
    // the app enforces — so every term is IMPORTED here rather than restated,
    // and widening a slider fails HERE if the threshold did not move with it.
    //
    // The imports are the fix for N1 on #278: this test used to keep its own
    // copies of the two private constants, so when #279 took the per-call
    // ceiling to 3 minutes and the threshold correctly followed to 90, the
    // assertion — still holding a stale 250 — accused the right answer of being
    // able to reap a live turn. A pin that goes red for the wrong reason costs
    // more than one that does not exist.
    const worstTurnMinutes =
      (Math.max(SETTINGS_BOUNDS.maxToolTurns[1], 2 * SETTINGS_BOUNDS.maxRetries[1]) +
        CHAIN_OVERHEAD_CALLS) *
      PER_CALL_TIMEOUT_MINUTES

    expect(
      STUCK_RUN_TIMEOUT_MINUTES,
      'the reaper can now claim a turn that is still legitimately running',
    ).toBeGreaterThan(worstTurnMinutes)

    // …and not by an arbitrary amount. The margin exists so a turn sitting at
    // the bound is not racing the sweep, not as slack for an unaccounted term:
    // an abandoned row that is reconciled far later than it needs to be is a
    // cost too, just a smaller one than a row that lies about a live turn.
    expect(STUCK_RUN_TIMEOUT_MINUTES).toBeLessThanOrEqual(Math.ceil(worstTurnMinutes * 1.5))
  })

  it('mirrors the per-call ceiling declared on VerdaQwen', () => {
    // `PER_CALL_TIMEOUT_MINUTES` is the term that dominates the derivation, and
    // it is a COPY: `request_timeout_ms` lives in BAML, which exports nothing a
    // module can read it from (same situation as `VERDA_MODEL_ID`, pinned the
    // same way in `verda-wake.test.ts`). This scan is what makes the copy safe —
    // without it, the one number that moves the threshold could drift from its
    // declaration with every other test still green.
    const declared = readFileSync(path.resolve(process.cwd(), 'baml_src/verda-client.baml'), 'utf8')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n')
    const match = /request_timeout_ms\s+(\d+)/.exec(declared)
    expect(match, 'VerdaQwen no longer declares a request_timeout_ms').not.toBeNull()
    expect(
      PER_CALL_TIMEOUT_MINUTES * 60_000,
      'the reaper threshold is derived from a per-call ceiling the client no longer has',
    ).toBe(Number(match![1]))
  })

  it('leaves room for the wake ping in front of the turn', () => {
    // The one term outside the product (#279): a turn is parked on a wake ping
    // BEFORE its first LLM call, and the row is pre-seeded before that wait, so
    // the wake is spent against this budget. It is absorbed by the margin rather
    // than added as a term — bounded, once per turn, and two orders of magnitude
    // below the chain — which is only defensible while the inequality holds.
    // Pinned against the real constant so a longer wake fails here instead of
    // quietly shortening how long a live turn is protected for — which it has
    // already caught once: the wake doubled to 600s on 2026-08-27 when it became
    // a poll, taking the worst legitimate turn from 80 to 85 minutes against this
    // 90-minute threshold. Against the SHIPPED default rather than
    // `verdaWakeTimeoutMs()`, because a host that raises the env var past the
    // margin is making its own call and this is a claim about what we ship.
    const worstTurnMinutes =
      (Math.max(SETTINGS_BOUNDS.maxToolTurns[1], 2 * SETTINGS_BOUNDS.maxRetries[1]) +
        CHAIN_OVERHEAD_CALLS) *
      PER_CALL_TIMEOUT_MINUTES
    const wakeMinutes = DEFAULT_VERDA_WAKE_TIMEOUT_MS / 60_000

    expect(
      STUCK_RUN_TIMEOUT_MINUTES,
      'a turn that waited out the wake and then ran the longest legal chain can be reaped mid-flight',
    ).toBeGreaterThan(worstTurnMinutes + wakeMinutes)
  })

  it('is a whole number of minutes, because it is interpolated into an INTERVAL', () => {
    // `INTERVAL '90.0000001 minutes'` would still parse, but the derivation
    // multiplies by a fractional margin and a rounding change here would show
    // up as a puzzling SQL literal rather than as a failing test.
    expect(Number.isInteger(STUCK_RUN_TIMEOUT_MINUTES)).toBe(true)
  })
})
