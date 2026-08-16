/**
 * Routine definition store CRUD (#131).
 *
 * Hits the live Postgres container from docker-compose, mirroring
 * `conversations.test.ts` — and skips gracefully when Postgres isn't reachable
 * so this works on machines without docker.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

// Bypass server-only guard in jsdom test env
vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import {
  claimRoutineRun,
  createRoutine,
  deleteRoutine,
  getRoutine,
  listEnabledRoutines,
  listEnabledRoutinesForUser,
  listRoutines,
  updateRoutine,
} from '../../../lib/db/routines.server'
import { closePool, query } from '../../../lib/db/client.server'

const TEST_USER = `test-user-${Math.random().toString(36).slice(2, 10)}`
const OTHER_USER = `other-user-${Math.random().toString(36).slice(2, 10)}`

let dbAvailable = true

const rid = () => `routine-${Math.random().toString(36).slice(2, 10)}`

async function seed(overrides: Partial<Parameters<typeof createRoutine>[0]> = {}) {
  return createRoutine({
    id: rid(),
    userId: TEST_USER,
    agentId: 'default',
    trigger: { kind: 'interval', intervalSeconds: 3600 },
    input: 'summarise my graph',
    ...overrides,
  })
}

beforeAll(async () => {
  try {
    await query('SELECT 1')
  } catch (err) {
    dbAvailable = false
    console.warn('[routines.test] Postgres unreachable, skipping:', err)
  }
})

afterAll(async () => {
  if (!dbAvailable) return
  await query('DELETE FROM routines WHERE user_id = ANY($1)', [[TEST_USER, OTHER_USER]])
  await closePool()
})

describe('routines CRUD', () => {
  it('round-trips a routine, rehydrating the trigger union', async () => {
    if (!dbAvailable) return
    const created = await seed({ label: 'Hourly digest' })

    expect(created.trigger).toEqual({ kind: 'interval', intervalSeconds: 3600 })
    expect(created.enabled).toBe(true)
    expect(created.lastRunAt).toBeNull()

    const loaded = await getRoutine(created.id, TEST_USER)
    expect(loaded).not.toBeNull()
    expect(loaded!.trigger).toEqual({ kind: 'interval', intervalSeconds: 3600 })
    expect(loaded!.label).toBe('Hourly digest')
    expect(loaded!.input).toBe('summarise my graph')
    expect(loaded!.agentId).toBe('default')
  })

  it('stores event-kind triggers with an empty config', async () => {
    if (!dbAvailable) return
    const created = await seed({ trigger: { kind: 'session_start' } })
    const loaded = await getRoutine(created.id, TEST_USER)
    expect(loaded!.trigger).toEqual({ kind: 'session_start' })
  })

  it('scopes reads to the owner', async () => {
    if (!dbAvailable) return
    const created = await seed()
    expect(await getRoutine(created.id, OTHER_USER)).toBeNull()
  })

  it('lists a user’s routines newest-created first', async () => {
    if (!dbAvailable) return
    const ids: string[] = []
    for (let n = 0; n < 3; n++) {
      ids.push((await seed({ label: `r${n}` })).id)
      // created_at ordering must be deterministic; sub-ms inserts can tie.
      await new Promise((r) => setTimeout(r, 15))
    }
    const seen = (await listRoutines(TEST_USER)).map((r) => r.id).filter((id) => ids.includes(id))
    expect(seen).toEqual([...ids].reverse())
  })

  it('patches only the provided fields', async () => {
    if (!dbAvailable) return
    const created = await seed({ label: 'before', input: 'old input' })

    const disabled = await updateRoutine(created.id, TEST_USER, { enabled: false })
    expect(disabled!.enabled).toBe(false)
    expect(disabled!.label).toBe('before')
    expect(disabled!.input).toBe('old input')

    const relabelled = await updateRoutine(created.id, TEST_USER, { label: 'after' })
    expect(relabelled!.label).toBe('after')
    // Untouched by the label patch.
    expect(relabelled!.enabled).toBe(false)
  })

  it('resets last_run_at when the schedule changes', async () => {
    if (!dbAvailable) return
    const created = await seed()
    await claimRoutineRun(created.id, null)
    expect((await getRoutine(created.id, TEST_USER))!.lastRunAt).not.toBeNull()

    const rescheduled = await updateRoutine(created.id, TEST_USER, {
      trigger: { kind: 'interval', intervalSeconds: 120 },
    })
    expect(rescheduled!.trigger).toEqual({ kind: 'interval', intervalSeconds: 120 })
    expect(rescheduled!.lastRunAt).toBeNull()
  })

  it('refuses to patch or delete another user’s routine', async () => {
    if (!dbAvailable) return
    const created = await seed()
    expect(await updateRoutine(created.id, OTHER_USER, { enabled: false })).toBeNull()
    expect(await deleteRoutine(created.id, OTHER_USER)).toBe(false)
    // Still there, still enabled.
    expect((await getRoutine(created.id, TEST_USER))!.enabled).toBe(true)
  })

  it('deletes', async () => {
    if (!dbAvailable) return
    const created = await seed()
    expect(await deleteRoutine(created.id, TEST_USER)).toBe(true)
    expect(await getRoutine(created.id, TEST_USER)).toBeNull()
    expect(await deleteRoutine(created.id, TEST_USER)).toBe(false)
  })
})

describe('trigger-evaluation queries', () => {
  it('lists only enabled routines, optionally narrowed by kind', async () => {
    if (!dbAvailable) return
    const on = await seed({ trigger: { kind: 'session_start' } })
    const off = await seed({ trigger: { kind: 'session_start' }, enabled: false })
    const other = await seed({ trigger: { kind: 'session_end' } })

    const starts = (await listEnabledRoutines('session_start')).map((r) => r.id)
    expect(starts).toContain(on.id)
    expect(starts).not.toContain(off.id)
    expect(starts).not.toContain(other.id)

    const all = (await listEnabledRoutines()).map((r) => r.id)
    expect(all).toEqual(expect.arrayContaining([on.id, other.id]))
    expect(all).not.toContain(off.id)
  })

  it('narrows an event lookup to one user', async () => {
    if (!dbAvailable) return
    const mine = await seed({ trigger: { kind: 'session_end' } })
    const theirs = await seed({ userId: OTHER_USER, trigger: { kind: 'session_end' } })

    const ids = (await listEnabledRoutinesForUser(TEST_USER, 'session_end')).map((r) => r.id)
    expect(ids).toContain(mine.id)
    expect(ids).not.toContain(theirs.id)
  })
})

describe('claimRoutineRun', () => {
  it('claims once, then loses the compare-and-set', async () => {
    if (!dbAvailable) return
    const created = await seed()

    expect(await claimRoutineRun(created.id, null)).toBe(true)
    // Second claim with the same (now stale) expectation must lose — this is
    // what stops an overlapping tick or a second instance double-firing.
    expect(await claimRoutineRun(created.id, null)).toBe(false)

    const after = await getRoutine(created.id, TEST_USER)
    expect(after!.lastRunAt).toBeInstanceOf(Date)
    // A claim using the fresh value succeeds again (the next due window).
    expect(await claimRoutineRun(created.id, after!.lastRunAt)).toBe(true)
  })

  it('never claims a disabled routine', async () => {
    if (!dbAvailable) return
    const created = await seed({ enabled: false })
    expect(await claimRoutineRun(created.id, null)).toBe(false)
  })
})
