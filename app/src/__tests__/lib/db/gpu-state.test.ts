/**
 * The deployment-global GPU switch — the store.
 *
 * Hermetic (`db/client.server` mocked): what is pinned is the SQL, the
 * single-row shape, and the stamp rule — the part carrying a product decision
 * ("running since" must not reset on an idempotent re-flip, and must vanish
 * when the switch goes off) rather than a mechanism.
 *
 * The SQL itself runs for real in `gpu-state-db.test.ts`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const query = vi.fn()
vi.mock('../../../lib/db/client.server', () => ({
  query: (...args: unknown[]) => query(...args),
}))

import { getGpuState, setGpuState } from '../../../lib/db/gpu-state.server'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('getGpuState', () => {
  it('is off when the row does not exist, after bootstrapping its table exactly once', async () => {
    query.mockResolvedValue({ rows: [] })
    expect(await getGpuState()).toEqual({ keepRunning: false, switchedOnAt: null })
    // The bootstrap is memoised per process — a module-state property, so it
    // is pinned here, in this file's FIRST state read (later reads would see
    // the memoised promise and prove nothing).
    const creates = query.mock.calls.filter(([sql]) => String(sql).includes('CREATE TABLE'))
    expect(creates).toHaveLength(1)
    expect(String(creates[0][0])).toContain('CREATE TABLE IF NOT EXISTS gpu_state')
  })

  it('reads the single row and converts the stamp to epoch ms', async () => {
    const at = new Date('2026-11-19T10:30:00Z')
    query.mockResolvedValue({ rows: [{ keep_running: true, switched_on_at: at }] })
    expect(await getGpuState()).toEqual({ keepRunning: true, switchedOnAt: at.getTime() })
  })
})

describe('setGpuState', () => {
  it('writes ON through an upsert that stamps now only on the flip', async () => {
    const at = new Date('2026-11-19T11:00:00Z')
    query.mockResolvedValue({ rows: [{ keep_running: true, switched_on_at: at }] })
    const state = await setGpuState(true)
    expect(state).toEqual({ keepRunning: true, switchedOnAt: at.getTime() })
    const [sql, params] = query.mock.calls.at(-1)!
    expect(String(sql)).toContain('ON CONFLICT (id) DO UPDATE')
    expect(String(sql)).toContain('COALESCE(gpu_state.switched_on_at, NOW())')
    expect(params).toEqual([true])
  })

  it('clears the stamp when the switch goes off', async () => {
    query.mockResolvedValue({ rows: [{ keep_running: false, switched_on_at: null }] })
    const state = await setGpuState(false)
    expect(state).toEqual({ keepRunning: false, switchedOnAt: null })
    const [sql, params] = query.mock.calls.at(-1)!
    expect(String(sql)).toContain('ELSE NULL')
    expect(params).toEqual([false])
  })
})
