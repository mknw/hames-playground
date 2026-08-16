/**
 * Routine dispatch (#131): the claim-before-run contract, the agent guard, and
 * the session-lifecycle hooks. The agent-trigger path itself is mocked here —
 * `routine-action-row.test.ts` exercises the real one.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const claimRoutineRun = vi.fn<(id: string, last: Date | null) => Promise<boolean>>(async () => true)
const listEnabledRoutinesForUser = vi.fn<() => Promise<unknown[]>>(async () => [])
vi.mock('../../../lib/db/routines.server', () => ({
  claimRoutineRun,
  listEnabledRoutinesForUser,
}))

const getAgent = vi.fn<(id: string) => { id: string } | undefined>(() => ({ id: 'default' }))
vi.mock('../../../lib/harness-client/registry.server', () => ({ getAgent }))

type Trigger = {
  transcribedCommand: string
  shortDescription: string
  routine?: { id: string; trigger: string }
}
const seedActionRow = vi.fn<
  (
    runId: string,
    userId: string,
    agentId: string,
    trigger: Trigger,
    source?: string,
  ) => Promise<void>
>(async () => {})
const runAgentInBackground = vi.fn<() => Promise<void>>(async () => {})
vi.mock('../../../lib/harness-client/action-runner.server', () => ({
  seedActionRow,
  runAgentInBackground,
}))

let idCounter = 0
vi.mock('../../../lib/session-id', () => ({ newSessionId: () => `run-${++idCounter}` }))

const { fireRoutine, fireRoutinesForEvent, onSessionEnd, onSessionStart } =
  await import('../../../lib/routines/dispatch.server')

const T0 = new Date('2026-08-16T12:00:00Z')

type Routine = Parameters<typeof fireRoutine>[0]

function routine(over: Partial<Routine> = {}): Routine {
  return {
    id: 'routine-1',
    userId: 'user-1',
    agentId: 'default',
    trigger: { kind: 'interval', intervalSeconds: 3600 },
    input: 'summarise the graph',
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
  idCounter = 0
  claimRoutineRun.mockResolvedValue(true)
  getAgent.mockReturnValue({ id: 'default' })
  seedActionRow.mockResolvedValue(undefined)
  listEnabledRoutinesForUser.mockResolvedValue([])
})

describe('fireRoutine', () => {
  it('runs through the agent-trigger path, tagged source=routine', async () => {
    const runId = await fireRoutine(routine({ label: 'Hourly digest' }))

    expect(runId).toBe('run-1')
    expect(seedActionRow).toHaveBeenCalledTimes(1)
    const [seededRunId, userId, agentId, trigger, source] = seedActionRow.mock.calls[0]
    expect(seededRunId).toBe('run-1')
    expect(userId).toBe('user-1')
    expect(agentId).toBe('default')
    expect(source).toBe('routine')
    expect(trigger).toMatchObject({
      transcribedCommand: 'summarise the graph',
      shortDescription: 'Hourly digest',
      routine: { id: 'routine-1', trigger: 'interval' },
    })

    // Fire-and-forget: the harness run is kicked off, not awaited.
    expect(runAgentInBackground).toHaveBeenCalledTimes(1)
    expect(runAgentInBackground.mock.calls[0].slice(0, 4)).toEqual([
      'run-1',
      'user-1',
      'summarise the graph',
      'default',
    ])
  })

  it('titles an unlabelled routine from its trigger and input', async () => {
    await fireRoutine(routine({ label: null, input: '  check   my  inbox  ' }))
    expect(seedActionRow.mock.calls[0][3].shortDescription).toBe('[interval] check my inbox')
  })

  it('truncates a long input in the title', async () => {
    await fireRoutine(routine({ input: 'x'.repeat(100) }))
    const title = seedActionRow.mock.calls[0][3].shortDescription
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBeLessThan(60)
  })

  it('claims BEFORE seeding, so a lost claim runs nothing', async () => {
    claimRoutineRun.mockResolvedValue(false)
    expect(await fireRoutine(routine())).toBeNull()
    expect(seedActionRow).not.toHaveBeenCalled()
    expect(runAgentInBackground).not.toHaveBeenCalled()
  })

  it('claims against the routine’s own last_run_at (compare-and-set input)', async () => {
    const last = new Date('2026-08-16T11:00:00Z')
    await fireRoutine(routine({ lastRunAt: last }))
    expect(claimRoutineRun).toHaveBeenCalledWith('routine-1', last)
  })

  it('skips a routine whose agent no longer exists, without burning the claim', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    getAgent.mockReturnValue(undefined)

    expect(await fireRoutine(routine({ agentId: 'deleted-agent' }))).toBeNull()
    expect(claimRoutineRun).not.toHaveBeenCalled()
    expect(seedActionRow).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('does not start the run when seeding the row fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    seedActionRow.mockRejectedValue(new Error('postgres down'))
    expect(await fireRoutine(routine())).toBeNull()
    expect(runAgentInBackground).not.toHaveBeenCalled()
    err.mockRestore()
  })
})

describe('fireRoutinesForEvent', () => {
  it('fires every enabled routine of that kind for the user', async () => {
    listEnabledRoutinesForUser.mockResolvedValue([
      routine({ id: 'a', trigger: { kind: 'session_start' } }),
      routine({ id: 'b', trigger: { kind: 'session_start' } }),
    ])

    const runs = await fireRoutinesForEvent('session_start', 'user-1')

    expect(listEnabledRoutinesForUser).toHaveBeenCalledWith('user-1', 'session_start')
    expect(runs).toEqual(['run-1', 'run-2'])
    expect(seedActionRow).toHaveBeenCalledTimes(2)
    expect(seedActionRow.mock.calls[0][3].routine).toEqual({
      id: 'a',
      trigger: 'session_start',
    })
  })

  it('is a no-op when the user has none', async () => {
    expect(await fireRoutinesForEvent('session_end', 'user-1')).toEqual([])
    expect(seedActionRow).not.toHaveBeenCalled()
  })

  it('never throws when the store is down — auth must not break', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    listEnabledRoutinesForUser.mockRejectedValue(new Error('postgres down'))
    await expect(fireRoutinesForEvent('session_start', 'user-1')).resolves.toEqual([])
    err.mockRestore()
  })

  it('keeps going when one routine fails', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    listEnabledRoutinesForUser.mockResolvedValue([
      routine({ id: 'boom', trigger: { kind: 'session_start' } }),
      routine({ id: 'ok', trigger: { kind: 'session_start' } }),
    ])
    claimRoutineRun.mockImplementation(async (id) => {
      if (id === 'boom') throw new Error('claim exploded')
      return true
    })

    expect(await fireRoutinesForEvent('session_start', 'user-1')).toEqual(['run-1'])
    err.mockRestore()
  })

  it('caps a runaway fan-out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    listEnabledRoutinesForUser.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) =>
        routine({ id: `r${i}`, trigger: { kind: 'session_start' } }),
      ),
    )
    const runs = await fireRoutinesForEvent('session_start', 'user-1')
    expect(runs).toHaveLength(20)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('session lifecycle hooks', () => {
  it('onSessionStart fires the user’s session_start routines', async () => {
    listEnabledRoutinesForUser.mockResolvedValue([
      routine({ id: 'a', trigger: { kind: 'session_start' } }),
    ])
    onSessionStart('user-1')
    await vi.waitFor(() => expect(seedActionRow).toHaveBeenCalledTimes(1))
    expect(listEnabledRoutinesForUser).toHaveBeenCalledWith('user-1', 'session_start')
  })

  it('onSessionEnd fires the user’s session_end routines', async () => {
    listEnabledRoutinesForUser.mockResolvedValue([
      routine({ id: 'b', trigger: { kind: 'session_end' } }),
    ])
    onSessionEnd('user-2')
    await vi.waitFor(() => expect(seedActionRow).toHaveBeenCalledTimes(1))
    expect(listEnabledRoutinesForUser).toHaveBeenCalledWith('user-2', 'session_end')
  })

  it('returns synchronously — the auth redirect never waits on a harness', () => {
    let resolveList: (v: unknown[]) => void = () => {}
    listEnabledRoutinesForUser.mockReturnValue(
      new Promise<unknown[]>((r) => {
        resolveList = r
      }),
    )
    expect(onSessionStart('user-1')).toBeUndefined()
    expect(seedActionRow).not.toHaveBeenCalled()
    resolveList([])
  })
})
