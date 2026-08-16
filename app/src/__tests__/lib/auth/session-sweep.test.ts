/**
 * Scheduled expired-session sweep (#129 item 2).
 *
 * Postgres is mocked here — the assertions are about the timer, not about SQL
 * (the live round-trip lives in `session-store.test.ts`). Each test re-imports
 * the module so the process-wide sweep-timer state starts clean.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }))

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

vi.mock('../../../lib/db/client.server', () => ({
  query: queryMock,
  closePool: vi.fn(),
}))

type SessionStore = typeof import('../../../lib/auth/session-store.server')

let store: SessionStore | null = null

/** Fresh module instance → fresh `sweepTimer` / `_schemaReady`. */
async function loadStore(): Promise<SessionStore> {
  vi.resetModules()
  store = await import('../../../lib/auth/session-store.server')
  return store
}

/** How many of the mocked queries were the sweep's DELETE (vs schema DDL). */
function sweepCount(): number {
  return queryMock.mock.calls.filter((call) =>
    String(call[0]).includes('DELETE FROM auth_sessions WHERE expires_at'),
  ).length
}

beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 })
  vi.useFakeTimers()
})

afterEach(() => {
  store?.stopSessionSweepTimer()
  store = null
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('startSessionSweepTimer (#129)', () => {
  it('sweeps once on arm, then on every interval', async () => {
    const s = await loadStore()
    s.startSessionSweepTimer(s.SESSION_SWEEP_INTERVAL_MS)

    // The immediate sweep — a restart clears the backlog without waiting an hour.
    await vi.advanceTimersByTimeAsync(0)
    expect(sweepCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(s.SESSION_SWEEP_INTERVAL_MS)
    expect(sweepCount()).toBe(2)

    await vi.advanceTimersByTimeAsync(s.SESSION_SWEEP_INTERVAL_MS)
    expect(sweepCount()).toBe(3)
  })

  it('is idempotent — a second call does not stack timers', async () => {
    const s = await loadStore()
    s.startSessionSweepTimer(30_000)
    s.startSessionSweepTimer(30_000) // no-op: dev HMR re-running this module
    await vi.advanceTimersByTimeAsync(30_000)

    expect(sweepCount()).toBe(2) // one immediate + one tick, not four
  })

  it('stopSessionSweepTimer halts the sweep', async () => {
    const s = await loadStore()
    s.startSessionSweepTimer(30_000)
    await vi.advanceTimersByTimeAsync(0)
    s.stopSessionSweepTimer()
    await vi.advanceTimersByTimeAsync(90_000)

    expect(sweepCount()).toBe(1) // only the immediate one
  })

  it('arms automatically on the first session-store use', async () => {
    const s = await loadStore()
    expect(sweepCount()).toBe(0)

    await s.getSession('no-such-session')
    await vi.advanceTimersByTimeAsync(0)

    expect(sweepCount()).toBe(1)
  })

  it('logs a one-line count only when rows were removed', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    queryMock.mockResolvedValue({ rows: [], rowCount: 21 })

    const s = await loadStore()
    s.startSessionSweepTimer(30_000)
    await vi.advanceTimersByTimeAsync(0)

    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toContain('21')

    queryMock.mockResolvedValue({ rows: [], rowCount: 0 })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(log).toHaveBeenCalledTimes(1) // a no-op sweep stays quiet
  })

  it('survives a failing sweep and keeps the interval running', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    queryMock.mockRejectedValue(new Error('connection refused'))

    const s = await loadStore()
    s.startSessionSweepTimer(30_000)
    await vi.advanceTimersByTimeAsync(0)
    expect(warn).toHaveBeenCalled()

    queryMock.mockResolvedValue({ rows: [], rowCount: 0 })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(sweepCount()).toBeGreaterThanOrEqual(1)
  })
})
