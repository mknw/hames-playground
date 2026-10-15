/**
 * `reapStuckConversations` — the stuck-run reaper (#273 D-a), reaping on a dead
 * turn lease with an age backstop (#507 P2, G12 A1).
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

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
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
  HUNG_TURN_BACKSTOP_MINUTES,
  PER_CALL_TIMEOUT_MINUTES,
  CHAIN_OVERHEAD_CALLS,
  DECISION_LOOP_MAX_ITERATIONS,
  DECISION_LOOP_WORST_CALLS,
  TOOL_CALL_TIMEOUT_MINUTES,
  WAKE_ALLOWANCE_MINUTES,
  TURN_CLAIM_TTL_SECONDS,
  TURN_CLAIM_RENEW_MS,
} from '../../../lib/db/conversations.server'
import { SETTINGS_BOUNDS } from '../../../lib/settings'
import {
  DEFAULT_VERDA_WAKE_TIMEOUT_MS,
  DEFAULT_SMALL_LLM_WAKE_TIMEOUT_MS,
} from '../../../lib/inference/wake.server'
import { DEFAULT_SANDBOX_SETTINGS } from '@hames-ai/sandbox/settings'

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
    expect(sql).toContain(`INTERVAL '${HUNG_TURN_BACKSTOP_MINUTES} minutes'`)
    expect(sql).toContain('RETURNING id')
    // The threshold is a constant interpolated into the SQL, so it must not be
    // reachable from an argument — a caller-supplied one would be an injection
    // point on a statement that writes every user's rows.
    expect(params).toBeUndefined()
  })

  it('reaps on a dead turn lease OR the age backstop, as one parenthesised disjunction', async () => {
    await reapStuckConversations()
    const [sql] = query.mock.calls[0] as [string]
    const flat = sql.replace(/\s+/g, ' ')
    // The lease half is the SAME predicate `claimConversation` takes a row over
    // with, so the reaper and a taking-over turn cannot disagree about "dead".
    // The parentheses are the property: `status = 'running' AND lease OR age`
    // would reap every row past the backstop whatever its status.
    expect(flat).toContain(
      `AND ((turn_claimed_at IS NULL OR turn_claimed_at < NOW() - INTERVAL '${TURN_CLAIM_TTL_SECONDS} seconds') ` +
        `OR updated_at < NOW() - INTERVAL '${HUNG_TURN_BACKSTOP_MINUTES} minutes')`,
    )
  })

  it('does not write the claim, the version or the context — a stalled-but-alive turn still saves', async () => {
    await reapStuckConversations()
    const [sql] = query.mock.calls[0] as [string]
    // The reap writes `status` and nothing else (#507 P2): a turn that was only
    // stalled past its lease renews and saves at the version it holds, and a
    // reap that bumped `context_version` or cleared the claim would refuse that
    // save and lose the turn's result.
    const set = /SET([\s\S]*?)WHERE/.exec(sql)![1]
    expect(set.trim()).toBe("status = 'error'")
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

  /**
   * The worst legitimate turn, re-derived from the IMPORTED terms rather than
   * from the module's own product, so a term dropped from the module's formula
   * goes red here (#446's lesson: a pin that re-derives the formula it checks
   * passes whatever the formula is).
   */
  const worstTurnMinutes = () => {
    const worstChild = Math.max(SETTINGS_BOUNDS.maxToolTurns[1], 2 * SETTINGS_BOUNDS.maxRetries[1])
    const calls = DECISION_LOOP_MAX_ITERATIONS * (1 + worstChild) + 1 + CHAIN_OVERHEAD_CALLS
    const llm = calls * PER_CALL_TIMEOUT_MINUTES
    const tools =
      DECISION_LOOP_MAX_ITERATIONS * SETTINGS_BOUNDS.maxToolTurns[1] * TOOL_CALL_TIMEOUT_MINUTES
    return llm + tools + WAKE_ALLOWANCE_MINUTES
  }

  it('exceeds the longest turn a browser can ask for, with margin', () => {
    // The exact derivation, from imported terms. An inequality alone lets the 1.2
    // margin absorb a dropped term (the wake's 12 minutes vanished inside it).
    expect(HUNG_TURN_BACKSTOP_MINUTES).toBe(Math.ceil(worstTurnMinutes() * 1.2))

    // The backstop's whole job: a live, renewing turn must not be reaped before
    // it could legitimately end. Every term is imported, none restated.
    expect(
      HUNG_TURN_BACKSTOP_MINUTES,
      'the backstop can now claim a turn that is still legitimately running',
    ).toBeGreaterThan(worstTurnMinutes())

    // …and not by an arbitrary amount: the margin is for a turn at the bound not
    // racing the sweep, not slack for an unaccounted term.
    expect(HUNG_TURN_BACKSTOP_MINUTES).toBeLessThanOrEqual(Math.ceil(worstTurnMinutes() * 1.5))
  })

  it("holds the design doc's 97-call arithmetic as a floor", () => {
    // G12 A1 / the doc's P2: 6 iterations × 15-call children + 6 decisions + 1
    // synthesis = 97 calls. The module deliberately derives a LARGER figure
    // (a 20-call actorCritic child, five chain-overhead calls: 132) and says so
    // beside the constant; this pins that the doc's own number can never be the
    // one that is under-counted.
    const docCalls = 6 * 15 + 6 + 1
    expect(docCalls).toBe(97)
    expect(DECISION_LOOP_MAX_ITERATIONS).toBe(6)
    expect(DECISION_LOOP_WORST_CALLS).toBeGreaterThanOrEqual(docCalls)
    expect(HUNG_TURN_BACKSTOP_MINUTES).toBeGreaterThan(docCalls * PER_CALL_TIMEOUT_MINUTES)
  })

  it('is far past the old single-loop 90-minute bound', () => {
    // The old value assumed one loop per turn (25 calls). Pinned by its number so
    // that putting the old formula back is red whatever the new one says.
    expect(HUNG_TURN_BACKSTOP_MINUTES).toBeGreaterThan(90 * 4)
  })

  it('counts non-LLM time: tool calls and the wake are inside the backstop', () => {
    const llmOnly = DECISION_LOOP_WORST_CALLS * PER_CALL_TIMEOUT_MINUTES
    const nonLlm =
      DECISION_LOOP_MAX_ITERATIONS * SETTINGS_BOUNDS.maxToolTurns[1] * TOOL_CALL_TIMEOUT_MINUTES +
      WAKE_ALLOWANCE_MINUTES
    expect(nonLlm).toBeGreaterThan(0)
    expect(HUNG_TURN_BACKSTOP_MINUTES).toBeGreaterThan(llmOnly + nonLlm)
  })

  it('mirrors the tool-call cap and the wake allowance it cannot import', () => {
    // Both are copies (the wake module pulls in the transport stack): pinned
    // against their declarations so the drift goes red here, naming the number.
    expect(TOOL_CALL_TIMEOUT_MINUTES * 60).toBe(DEFAULT_SANDBOX_SETTINGS.defaultTimeoutSec)
    expect(WAKE_ALLOWANCE_MINUTES * 60_000).toBe(
      Math.max(DEFAULT_VERDA_WAKE_TIMEOUT_MS, DEFAULT_SMALL_LLM_WAKE_TIMEOUT_MS),
    )
  })

  it('reaps a dead lease far sooner than the backstop, and the lease outlives a missed renewal', () => {
    // The point of the lease: a dead turn is reaped in about two minutes, not
    // hours. And the lease must tolerate at least one missed renewal, or a live
    // turn with one slow round trip is reaped.
    expect(TURN_CLAIM_TTL_SECONDS).toBeGreaterThanOrEqual((TURN_CLAIM_RENEW_MS / 1000) * 2)
    expect(TURN_CLAIM_TTL_SECONDS / 60).toBeLessThan(HUNG_TURN_BACKSTOP_MINUTES / 10)
  })

  it('mirrors the per-call ceiling declared on VerdaQwen', () => {
    // `PER_CALL_TIMEOUT_MINUTES` is the term that dominates the derivation, and
    // it is a COPY: `request_timeout_ms` lives in BAML, which exports nothing a
    // module can read it from (same situation as `VERDA_MODEL_ID`, pinned the
    // same way in `verda-wake.test.ts`). This scan is what makes the copy safe —
    // without it, the one number that moves the threshold could drift from its
    // declaration with every other test still green.
    const declared = readFileSync(
      path.resolve(process.cwd(), '../packages/harness-baml/baml_src/verda-client.baml'),
      'utf8',
    )
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

  it('is a whole number of minutes, because it is interpolated into an INTERVAL', () => {
    // `INTERVAL '598.0000001 minutes'` would still parse, but the derivation
    // multiplies by a fractional margin and a rounding change here would show
    // up as a puzzling SQL literal rather than as a failing test.
    expect(Number.isInteger(HUNG_TURN_BACKSTOP_MINUTES)).toBe(true)
  })
})
