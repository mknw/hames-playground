/**
 * Routine store SQL, without Postgres (#131).
 *
 * `db/routines.test.ts` round-trips against the live container, but neither CI
 * nor a docker-less machine runs it — and the parts most worth pinning are
 * exactly the ones a round-trip can hide: which columns a partial patch
 * touches, that the run claim is a compare-and-set, that every user-facing
 * query carries a `user_id` predicate, and that an unreadable row is skipped
 * rather than fatal. Those are asserted here against a mocked `query`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const query = vi.fn<(text: string, params?: unknown[]) => Promise<unknown>>()
vi.mock('../../../lib/db/client.server', () => ({ query }))

const {
  claimRoutineRun,
  createRoutine,
  deleteRoutine,
  getRoutine,
  listEnabledRoutines,
  listEnabledRoutinesForUser,
  listRoutines,
  updateRoutine,
} = await import('../../../lib/db/routines.server')

const NOW = new Date('2026-08-16T00:00:00Z')

function dbRow(over: Record<string, unknown> = {}) {
  return {
    id: 'r1',
    user_id: 'u1',
    agent_id: 'default',
    trigger_kind: 'interval',
    trigger_config: { intervalSeconds: 3600 },
    input: 'go',
    label: null,
    enabled: true,
    last_run_at: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  }
}

/** The DDL bootstrap runs once per module; ignore it when inspecting calls. */
function sqlCalls(): Array<{ text: string; params: unknown[] }> {
  return query.mock.calls
    .map(([text, params]) => ({ text, params: params ?? [] }))
    .filter((c) => !c.text.includes('CREATE TABLE'))
}

function lastCall() {
  const calls = sqlCalls()
  return calls[calls.length - 1]
}

beforeEach(() => {
  query.mockReset()
  query.mockResolvedValue({ rows: [dbRow()], rowCount: 1 })
})

describe('createRoutine', () => {
  it('persists the kind in its own column and the params as JSON', async () => {
    await createRoutine({
      id: 'r1',
      userId: 'u1',
      agentId: 'default',
      trigger: { kind: 'interval', intervalSeconds: 3600 },
      input: 'go',
    })
    const { text, params } = lastCall()
    expect(text).toContain('INSERT INTO routines')
    expect(params.slice(0, 6)).toEqual([
      'r1',
      'u1',
      'default',
      'interval',
      JSON.stringify({ intervalSeconds: 3600 }),
      'go',
    ])
    // enabled defaults to true.
    expect(params[7]).toBe(true)
  })

  it('writes an empty config blob for event kinds', async () => {
    await createRoutine({
      id: 'r1',
      userId: 'u1',
      agentId: 'default',
      trigger: { kind: 'session_start' },
      input: 'go',
    })
    const { params } = lastCall()
    expect(params[3]).toBe('session_start')
    expect(params[4]).toBe('{}')
  })
})

describe('updateRoutine', () => {
  it('sets only the fields present in the patch', async () => {
    await updateRoutine('r1', 'u1', { enabled: false })
    const { text, params } = lastCall()
    expect(text).toContain('enabled = $3')
    expect(text).not.toContain('input =')
    expect(text).not.toContain('label =')
    expect(text).not.toContain('trigger_kind =')
    expect(params).toEqual(['r1', 'u1', false])
  })

  it('resets last_run_at when the schedule changes, so it does not fire retroactively', async () => {
    await updateRoutine('r1', 'u1', { trigger: { kind: 'interval', intervalSeconds: 120 } })
    const { text, params } = lastCall()
    expect(text).toContain('trigger_kind = $3')
    expect(text).toContain('trigger_config = $4::jsonb')
    expect(text).toContain('last_run_at = NULL')
    expect(params).toEqual(['r1', 'u1', 'interval', JSON.stringify({ intervalSeconds: 120 })])
  })

  it('an empty patch degrades to a read, not a write', async () => {
    await updateRoutine('r1', 'u1', {})
    expect(lastCall().text).toContain('SELECT')
  })

  it('returns null when the row is not the user’s', async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 })
    expect(await updateRoutine('r1', 'someone-else', { enabled: false })).toBeNull()
  })
})

describe('user scoping', () => {
  it('every user-facing query filters on user_id', async () => {
    query.mockResolvedValue({ rows: [dbRow()], rowCount: 1 })
    await getRoutine('r1', 'u1')
    expect(lastCall().text).toContain('user_id = $2')

    await listRoutines('u1')
    expect(lastCall().text).toContain('WHERE user_id = $1')

    await deleteRoutine('r1', 'u1')
    expect(lastCall().text).toContain('user_id = $2')

    await listEnabledRoutinesForUser('u1', 'session_end')
    expect(lastCall().text).toContain('user_id = $1')
    expect(lastCall().params).toEqual(['u1', 'session_end'])
  })

  it('the scheduler sweep is intentionally cross-user', async () => {
    await listEnabledRoutines()
    expect(lastCall().text).toContain('enabled = TRUE')
    expect(lastCall().text).not.toContain('user_id =')
  })
})

describe('claimRoutineRun', () => {
  it('is a compare-and-set on last_run_at, gated on enabled', async () => {
    const prev = new Date('2026-08-15T23:00:00Z')
    expect(await claimRoutineRun('r1', prev)).toBe(true)
    const { text, params } = lastCall()
    // NOT `= $2`: a never-run routine's NULL must compare equal.
    expect(text).toContain('last_run_at IS NOT DISTINCT FROM $2')
    expect(text).toContain('enabled = TRUE')
    expect(params).toEqual(['r1', prev])
  })

  it('stores a millisecond-precision, strictly advancing timestamp', async () => {
    // A raw NOW() writes microseconds, but `pg` reads TIMESTAMPTZ back into a
    // millisecond-only Date — so the next claim's $2 could never match the
    // stored value and every routine fired exactly once, then jammed. The
    // written value must therefore survive the Postgres -> JS -> Postgres
    // round trip, and must advance strictly so two claimants inside one
    // millisecond can't both win. `db/routines.test.ts` proves the behaviour
    // against a live container; this pins the SQL that delivers it.
    await claimRoutineRun('r1', new Date('2026-08-15T23:00:00Z'))
    const { text } = lastCall()
    expect(text).toContain("date_trunc('milliseconds', NOW())")
    expect(text).toContain("last_run_at + interval '1 millisecond'")
    expect(text).toContain('GREATEST')
    expect(text).not.toContain('SET last_run_at = NOW()')
  })

  it('reports a lost claim when no row was updated', async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 })
    expect(await claimRoutineRun('r1', null)).toBe(false)
  })
})

describe('unreadable rows', () => {
  it('skips a routine whose trigger kind this build does not know', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    query.mockResolvedValue({
      rows: [dbRow({ id: 'good' }), dbRow({ id: 'future', trigger_kind: 'webhook' })],
      rowCount: 2,
    })
    const rows = await listEnabledRoutines()
    expect(rows.map((r) => r.id)).toEqual(['good'])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('skips a routine whose config no longer validates', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    query.mockResolvedValue({
      rows: [dbRow({ id: 'bad', trigger_config: { intervalSeconds: 1 } })],
      rowCount: 1,
    })
    expect(await listRoutines('u1')).toEqual([])
    warn.mockRestore()
  })
})
