/**
 * The GPU switch against real Postgres — the SQL is the subject here.
 *
 * The hermetic twin (`gpu-state.test.ts`) pins the row mapping against a
 * mocked `query`; this file runs the actual upsert, because its load-bearing
 * clause is SQL, not JS: an idempotent ON must keep the ORIGINAL stamp
 * (`COALESCE`), and an OFF must clear it — the "running since" figure the
 * admin panel prices the demo from is only honest if those two hold against a
 * real planner. Runs on this suite's own `hames_test` (never a dev database),
 * skipped when no test Postgres is reachable, exactly like every other
 * DB-backed file in this directory.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { skipWithoutDatabase } from '../../test-database'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import { getGpuState, setGpuState } from '../../../lib/db/gpu-state.server'
import { closePool, query } from '../../../lib/db/client.server'

let dbAvailable = true

beforeAll(async () => {
  try {
    await query('SELECT 1')
    // CREATE TABLE IF NOT EXISTS runs on the first state read; force it now so
    // a failure to bootstrap is this file's own red rather than a mystery.
    await getGpuState()
  } catch (err) {
    dbAvailable = false
    console.warn('[gpu-state-db.test] Postgres unreachable, skipping:', err)
  }
})

afterAll(async () => {
  if (!dbAvailable) return
  await query('DELETE FROM gpu_state WHERE id = 1').catch(() => {})
  await closePool()
})

describe('the gpu_state row', () => {
  beforeEach(async (ctx) => {
    skipWithoutDatabase(ctx, dbAvailable)
    // Reset the one row before each case, so tests are order-independent.
    await query('DELETE FROM gpu_state WHERE id = 1')
  })

  it('starts off, with no running-since stamp', async () => {
    expect(await getGpuState()).toEqual({ keepRunning: false, switchedOnAt: null })
  })

  it('turns on with a stamp, and an idempotent re-on keeps the original stamp', async () => {
    await setGpuState(true)
    const first = await getGpuState()
    expect(first.keepRunning).toBe(true)
    expect(first.switchedOnAt).not.toBeNull()
    expect(first.switchedOnAt!).toBeLessThanOrEqual(Date.now())

    await setGpuState(true)
    const again = await getGpuState()
    expect(again.switchedOnAt).toBe(first.switchedOnAt)
  })

  it('turns off and clears the stamp', async () => {
    await setGpuState(true)
    await setGpuState(false)
    expect(await getGpuState()).toEqual({ keepRunning: false, switchedOnAt: null })
  })

  it('keeps exactly one row', async () => {
    await setGpuState(true)
    await setGpuState(false)
    const { rows } = await query<{ n: string }>('SELECT COUNT(*)::text AS n FROM gpu_state')
    expect(Number(rows[0].n)).toBe(1)
  })
})
