/**
 * Global usage counters — the SQL the header polls, and the arithmetic on top
 * of it.
 *
 * Hermetic: `db/client.server` is mocked, so this pins the *statements* and the
 * fold rather than a live Postgres. That split is deliberate — the round-trip
 * behaviour of an upsert needs the real database (and the repo's DB tests skip
 * when it is unreachable, so they cannot gate a change), while the things that
 * have actually been wrong here are the fold and the day boundary, and those
 * are pure.
 *
 * What each case guards:
 *   - BIGINT arrives from `pg` as a STRING. A fold that trusted the type would
 *     concatenate today's totals instead of adding them.
 *   - "no calls yet" must not render as "0% ran on our box".
 *   - a zero delta must not cost a write per stray call.
 *   - `day` is UTC, so two users on one screen cannot disagree about today.
 *   - the active-users window is a constant in the SQL, never a caller's value.
 *   - the index that makes the active-users read cheap actually exists.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const query = vi.fn()
vi.mock('../../../lib/db/client.server', () => ({
  query: (...args: unknown[]) => query(...args),
}))

import {
  ACTIVE_WINDOW_MINUTES,
  addUsage,
  countActiveUsers,
  foldUsageRows,
  getUsageToday,
  utcDay,
} from '../../../lib/metrics/preview-counters.server'

beforeEach(() => {
  query.mockReset()
  query.mockResolvedValue({ rows: [] })
})

/** The statement of the last `query()` call that is not the schema bootstrap. */
function lastRealQuery(): { sql: string; params: unknown[] } {
  const calls = query.mock.calls.filter((c) => !String(c[0]).includes('CREATE TABLE IF NOT EXISTS'))
  const last = calls[calls.length - 1]
  return { sql: String(last?.[0] ?? ''), params: (last?.[1] as unknown[]) ?? [] }
}

describe('utcDay', () => {
  it('is the UTC calendar date, not the host’s', () => {
    expect(utcDay(Date.UTC(2026, 7, 25, 12, 0, 0))).toBe('2026-08-25')
  })

  it('rolls at UTC midnight, on both sides', () => {
    expect(utcDay(Date.UTC(2026, 7, 25, 23, 59, 59, 999))).toBe('2026-08-25')
    expect(utcDay(Date.UTC(2026, 7, 26, 0, 0, 0))).toBe('2026-08-26')
  })
})

describe('foldUsageRows', () => {
  it('sums input and output into one token total across tiers', () => {
    const folded = foldUsageRows([
      { tier: 'verda', llm_calls: 3, input_tokens: 100, output_tokens: 20, turns: 1 },
      { tier: 'anthropic', llm_calls: 1, input_tokens: 50, output_tokens: 5, turns: 1 },
    ])
    expect(folded.totalTokens).toBe(175)
    expect(folded.llmCalls).toBe(4)
    expect(folded.turns).toBe(2)
  })

  it('adds BIGINT columns rather than concatenating the strings pg returns', () => {
    // `pg` hands BIGINT back as a string. `'100' + '50'` is '10050', and a
    // header showing 10,050 tokens after two small turns is the bug.
    const folded = foldUsageRows([
      { tier: 'verda', llm_calls: '2', input_tokens: '100', output_tokens: '20', turns: '1' },
      { tier: 'anthropic', llm_calls: '2', input_tokens: '50', output_tokens: '5', turns: '1' },
    ])
    expect(folded.totalTokens).toBe(175)
    expect(folded.llmCalls).toBe(4)
  })

  it('computes the self-hosted share from calls that actually ran there', () => {
    const folded = foldUsageRows([
      { tier: 'verda', llm_calls: 3, input_tokens: 0, output_tokens: 0, turns: 0 },
      { tier: 'anthropic', llm_calls: 1, input_tokens: 0, output_tokens: 0, turns: 0 },
    ])
    expect(folded.verdaCallShare).toBe(0.75)
  })

  it('reports null, not 0, when nothing has run today', () => {
    // 0% is a measurement ("none of today's calls were ours"); null is the
    // absence of one. The UI renders them differently for that reason.
    expect(foldUsageRows([]).verdaCallShare).toBeNull()
    expect(foldUsageRows([]).totalTokens).toBe(0)
  })

  it('ignores a tier this build does not know rather than crediting it', () => {
    const folded = foldUsageRows([
      { tier: 'future-tier', llm_calls: 4, input_tokens: 10, output_tokens: 0, turns: 0 },
    ])
    expect(folded.llmCalls).toBe(4)
    expect(folded.verdaCallShare).toBe(0)
  })
})

describe('addUsage', () => {
  const delta = {
    tier: 'verda' as const,
    llmCalls: 2,
    inputTokens: 300,
    outputTokens: 40,
    turns: 1,
  }

  it('upserts into today’s row for the delta’s tier', async () => {
    await addUsage(delta, Date.UTC(2026, 7, 25, 9, 0, 0))
    const { sql, params } = lastRealQuery()

    expect(sql).toContain('INSERT INTO usage_counters')
    expect(sql).toContain('ON CONFLICT (day, tier) DO UPDATE')
    expect(params).toEqual(['2026-08-25', 'verda', 2, 300, 40, 1])
  })

  it('ADDS to the existing row rather than replacing it', async () => {
    // A `SET llm_calls = EXCLUDED.llm_calls` would reset the day's total on
    // every flush and the header would tick backwards.
    await addUsage(delta)
    const { sql } = lastRealQuery()
    expect(sql).toMatch(/llm_calls\s*=\s*usage_counters\.llm_calls\s*\+\s*EXCLUDED\.llm_calls/)
    expect(sql).toMatch(/input_tokens\s*=\s*usage_counters\.input_tokens\s*\+/)
    expect(sql).toMatch(/output_tokens\s*=\s*usage_counters\.output_tokens\s*\+/)
    expect(sql).toMatch(/turns\s*=\s*usage_counters\.turns\s*\+/)
  })

  it('writes nothing at all for an empty delta', async () => {
    await addUsage({ tier: 'anthropic', llmCalls: 0, inputTokens: 0, outputTokens: 0, turns: 0 })
    expect(query).not.toHaveBeenCalled()
  })
})

describe('getUsageToday', () => {
  it('reads only today’s rows, by day', async () => {
    query.mockResolvedValue({
      rows: [{ tier: 'verda', llm_calls: '1', input_tokens: '9', output_tokens: '1', turns: '1' }],
    })
    const usage = await getUsageToday(Date.UTC(2026, 7, 25, 3, 0, 0))
    const { sql, params } = lastRealQuery()

    expect(sql).toContain('FROM usage_counters WHERE day = $1')
    expect(params).toEqual(['2026-08-25'])
    expect(usage.totalTokens).toBe(10)
  })

  it('never opens a conversation blob — that is what makes it pollable', async () => {
    await getUsageToday()
    for (const [sql] of query.mock.calls) {
      expect(String(sql)).not.toMatch(/conversations|context|jsonb/i)
    }
  })
})

describe('countActiveUsers', () => {
  it('counts distinct owners of recently touched conversations', async () => {
    query.mockResolvedValue({ rows: [{ active: '3' }] })
    expect(await countActiveUsers()).toBe(3)

    const { sql, params } = lastRealQuery()
    expect(sql).toContain('COUNT(DISTINCT user_id)')
    expect(sql).toContain('FROM conversations')
    expect(sql).toContain(`INTERVAL '${ACTIVE_WINDOW_MINUTES} minutes'`)
    // The window is a constant, never a caller's value: this query interpolates
    // it, so it must not be reachable from an argument.
    expect(params).toEqual([])
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
