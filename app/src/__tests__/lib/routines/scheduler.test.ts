/**
 * Interval trigger evaluation (#131) — due-ness, the sweep, and the armed
 * timer, all under fake timers with the store and dispatcher mocked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const listEnabledRoutines = vi.fn<() => Promise<unknown[]>>(async () => [])
vi.mock('../../../lib/db/routines.server', () => ({ listEnabledRoutines }))

const fireRoutine = vi.fn<(r: { id: string }) => Promise<string | null>>(async (r) => `run-${r.id}`)
vi.mock('../../../lib/routines/dispatch.server', () => ({ fireRoutine }))

// The tick's other half (#273 D-a). Mocked for the same reason the store is:
// this file drives the timer under fake timers, and the real reaper would run
// SQL against the test database on every advance.
const reapStuckConversations = vi.fn<() => Promise<string[]>>(async () => [])
vi.mock('../../../lib/db/conversations.server', () => ({
  reapStuckConversations,
  STUCK_RUN_TIMEOUT_MINUTES: 20,
}))

const {
  ROUTINE_TICK_INTERVAL_MS,
  isDue,
  isRoutineSchedulerArmed,
  runRoutineTick,
  startRoutineScheduler,
  stopRoutineScheduler,
  sweepStuckRuns,
} = await import('../../../lib/routines/scheduler.server')

const T0 = new Date('2026-08-16T12:00:00Z')
const MINUTE = 60_000

type Routine = Parameters<typeof isDue>[0]

function routine(over: Partial<Routine> = {}): Routine {
  return {
    id: 'r1',
    userId: 'u1',
    agentId: 'search',
    trigger: { kind: 'interval', intervalSeconds: 300 },
    input: 'go',
    label: null,
    enabled: true,
    lastRunAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  } as Routine
}

beforeEach(() => {
  vi.clearAllMocks()
  listEnabledRoutines.mockResolvedValue([])
  fireRoutine.mockImplementation(async (r) => `run-${r.id}`)
  reapStuckConversations.mockResolvedValue([])
})

afterEach(() => {
  stopRoutineScheduler()
  vi.useRealTimers()
})

describe('isDue', () => {
  it('counts from creation for a routine that has never run', () => {
    const r = routine({ trigger: { kind: 'interval', intervalSeconds: 300 } })
    // A fresh routine waits out a full interval rather than firing at once.
    expect(isDue(r, T0.getTime() + 1)).toBe(false)
    expect(isDue(r, T0.getTime() + 4 * MINUTE)).toBe(false)
    expect(isDue(r, T0.getTime() + 5 * MINUTE)).toBe(true)
  })

  it('counts from the last run once there is one', () => {
    const r = routine({
      createdAt: new Date(T0.getTime() - 10 * MINUTE),
      lastRunAt: T0,
      trigger: { kind: 'interval', intervalSeconds: 600 },
    })
    expect(isDue(r, T0.getTime() + 9 * MINUTE)).toBe(false)
    expect(isDue(r, T0.getTime() + 10 * MINUTE)).toBe(true)
  })

  it('is never true for an event-driven trigger', () => {
    const r = routine({ trigger: { kind: 'session_start' } })
    expect(isDue(r, T0.getTime() + 365 * 24 * 3600_000)).toBe(false)
  })
})

describe('runRoutineTick', () => {
  it('fires only the due routines', async () => {
    const due = routine({ id: 'due', trigger: { kind: 'interval', intervalSeconds: 60 } })
    const notYet = routine({ id: 'not-yet', trigger: { kind: 'interval', intervalSeconds: 3600 } })
    const evented = routine({ id: 'evented', trigger: { kind: 'session_start' } })
    listEnabledRoutines.mockResolvedValue([due, notYet, evented])

    const runs = await runRoutineTick(T0.getTime() + 2 * MINUTE)

    expect(fireRoutine).toHaveBeenCalledTimes(1)
    expect(fireRoutine.mock.calls[0][0]).toMatchObject({ id: 'due' })
    expect(runs).toEqual(['run-due'])
  })

  it('omits routines whose claim was lost (fireRoutine returned null)', async () => {
    listEnabledRoutines.mockResolvedValue([
      routine({ id: 'a', trigger: { kind: 'interval', intervalSeconds: 60 } }),
    ])
    fireRoutine.mockResolvedValue(null)
    expect(await runRoutineTick(T0.getTime() + 2 * MINUTE)).toEqual([])
  })

  it('one failing routine does not stop the sweep', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    listEnabledRoutines.mockResolvedValue([
      routine({ id: 'boom', trigger: { kind: 'interval', intervalSeconds: 60 } }),
      routine({ id: 'ok', trigger: { kind: 'interval', intervalSeconds: 60 } }),
    ])
    fireRoutine.mockImplementation(async (r) => {
      if (r.id === 'boom') throw new Error('agent exploded')
      return `run-${r.id}`
    })

    expect(await runRoutineTick(T0.getTime() + 2 * MINUTE)).toEqual(['run-ok'])
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('survives the store being unreachable', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    listEnabledRoutines.mockRejectedValue(new Error('postgres down'))
    expect(await runRoutineTick(T0.getTime())).toEqual([])
    expect(fireRoutine).not.toHaveBeenCalled()
    err.mockRestore()
  })
})

describe('the armed timer', () => {
  // Arming sweeps ONCE immediately as well as on every interval (#273 D-a), so
  // every count below is `ticks + 1`. That boot sweep is the whole point of the
  // stuck-run half: the rows to reconcile are usually the ones the previous
  // process abandoned when it died, and they should not wait out a tick.
  it('sweeps on each tick, plus once at arming', async () => {
    vi.useFakeTimers()
    startRoutineScheduler(1000)
    expect(isRoutineSchedulerArmed()).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(listEnabledRoutines).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(3000)
    expect(listEnabledRoutines).toHaveBeenCalledTimes(4)
  })

  it('is idempotent — a second arm (HMR reload, second import) adds no timer', async () => {
    vi.useFakeTimers()
    startRoutineScheduler(1000)
    startRoutineScheduler(1000)

    await vi.advanceTimersByTimeAsync(2000)
    // One boot sweep, not two: the second arm returns before sweeping.
    expect(listEnabledRoutines).toHaveBeenCalledTimes(3)
  })

  it('stops cleanly and can be re-armed', async () => {
    vi.useFakeTimers()
    startRoutineScheduler(1000)
    await vi.advanceTimersByTimeAsync(1000)
    stopRoutineScheduler()
    expect(isRoutineSchedulerArmed()).toBe(false)

    await vi.advanceTimersByTimeAsync(5000)
    expect(listEnabledRoutines).toHaveBeenCalledTimes(2)

    startRoutineScheduler(1000)
    await vi.advanceTimersByTimeAsync(1000)
    // Re-arming boots-sweeps again, then ticks once.
    expect(listEnabledRoutines).toHaveBeenCalledTimes(4)
  })

  it('reconciles stuck runs on the same wake-ups', async () => {
    vi.useFakeTimers()
    startRoutineScheduler(1000)
    await vi.advanceTimersByTimeAsync(2000)
    expect(reapStuckConversations).toHaveBeenCalledTimes(3)
  })

  it('still fires routines when the reap throws', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    reapStuckConversations.mockRejectedValue(new Error('database is starting up'))
    vi.useFakeTimers()
    startRoutineScheduler(1000)
    await vi.advanceTimersByTimeAsync(1000)
    // The two halves are independent: a boot before the database is up must not
    // cost the routines their tick.
    expect(listEnabledRoutines).toHaveBeenCalledTimes(2)
    err.mockRestore()
  })

  it('unrefs the timer so it never holds the process open', () => {
    vi.useFakeTimers()
    const unref = vi.fn()
    const spy = vi
      .spyOn(globalThis, 'setInterval')
      .mockReturnValue({ unref } as unknown as ReturnType<typeof setInterval>)
    startRoutineScheduler(1000)
    expect(unref).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('ticks well under the minimum interval, so a per-minute routine barely drifts', () => {
    expect(ROUTINE_TICK_INTERVAL_MS).toBeLessThan(60_000)
  })
})

describe('sweepStuckRuns', () => {
  it('passes the reaped ids back and names them in one warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    reapStuckConversations.mockResolvedValue(['conv-a', 'conv-b'])

    expect(await sweepStuckRuns()).toEqual(['conv-a', 'conv-b'])

    // The reap is the only writer of an `error` status with no turn behind it,
    // so the log has to be able to attribute one.
    expect(warn).toHaveBeenCalledTimes(1)
    const line = warn.mock.calls[0].join(' ')
    expect(line).toContain('conv-a')
    expect(line).toContain('conv-b')
    warn.mockRestore()
  })

  it('says nothing on an idle sweep', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await sweepStuckRuns()).toEqual([])
    // Every 30s, forever — a "reaped 0" line would bury the rest of the log.
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('swallows a database failure rather than throwing into the timer', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    reapStuckConversations.mockRejectedValue(new Error('connection refused'))

    await expect(sweepStuckRuns()).resolves.toEqual([])

    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})
