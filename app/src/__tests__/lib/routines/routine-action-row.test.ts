/**
 * A routine run lands as an action row (#131).
 *
 * The point of routines is that they are a *scheduling* layer over the
 * existing agent-trigger path, not a second execution path — so this test uses
 * the REAL `action-runner.server.ts` and mocks only the database underneath
 * it, asserting the row that reaches Postgres: `kind='action'`,
 * `source='routine'`, `status='running'`, the routine's input replayable as
 * the first `user_message`, and the routine provenance on `ctx.data.trigger`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const claimRoutineRunAt = vi.fn<() => Promise<Date | null>>(
  async () => new Date('2026-08-16T12:00:00Z'),
)
vi.mock('../../../lib/db/routines.server', () => ({
  claimRoutineRunAt,
  releaseRoutineClaim: vi.fn(async () => true),
  listEnabledRoutinesForUser: vi.fn(async () => []),
}))

vi.mock('../../../lib/harness-client/registry.server', () => ({
  getAgent: () => ({ id: 'search' }),
}))

// The harness itself never runs here: `runAgentInBackground` is fire-and-forget
// and this test is about the row seeded before it. Stub the session layer it
// would reach for so nothing tries to build real patterns.
vi.mock('../../../lib/harness-client/session.server', () => ({
  getOrBuildPatterns: vi.fn(async () => []),
  saveSession: vi.fn(async () => {}),
}))
vi.mock('../../../lib/harness-client/request-user.server', () => ({
  runWithRequestContext: vi.fn(async () => {}),
}))

interface SavedRow {
  id: string
  userId: string
  agentId: string
  title: string | null
  serializedContext: string
  kind?: string
  source?: string
  status?: string
}
const saveConversation = vi.fn<(row: SavedRow) => Promise<void>>(async () => {})
vi.mock('../../../lib/db/conversations.server', () => ({
  saveConversation,
  setConversationStatus: vi.fn(async () => {}),
}))

vi.mock('../../../lib/session-id', () => ({ newSessionId: () => 'run-fixed' }))

const { fireRoutine } = await import('../../../lib/routines/dispatch.server')

const T0 = new Date('2026-08-16T12:00:00Z')

type Routine = Parameters<typeof fireRoutine>[0]

const routine = (over: Partial<Routine> = {}): Routine =>
  ({
    id: 'routine-1',
    userId: 'user-1',
    agentId: 'search',
    trigger: { kind: 'interval', intervalSeconds: 3600 },
    input: 'summarise what changed today',
    label: 'Daily digest',
    enabled: true,
    lastRunAt: null,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  }) as Routine

beforeEach(() => {
  vi.clearAllMocks()
  claimRoutineRunAt.mockResolvedValue(new Date('2026-08-16T12:00:00Z'))
})

describe('a routine run', () => {
  it('seeds an observable action row with source=routine', async () => {
    const runId = await fireRoutine(routine())
    expect(runId).toBe('run-fixed')

    expect(saveConversation).toHaveBeenCalledTimes(1)
    const row = saveConversation.mock.calls[0][0]
    expect(row).toMatchObject({
      id: 'run-fixed',
      userId: 'user-1',
      agentId: 'search',
      kind: 'action',
      source: 'routine',
      // In-flight badge until the background run persists its result.
      status: 'running',
      title: 'Daily digest',
    })
  })

  it('seeds a context that replays the routine input and carries provenance', async () => {
    await fireRoutine(routine())
    const ctx = JSON.parse(saveConversation.mock.calls[0][0].serializedContext)

    expect(ctx.sessionId).toBe('run-fixed')
    const firstUser = (ctx.events as Array<{ type: string; data: { content?: string } }>).find(
      (e) => e.type === 'user_message',
    )
    expect(firstUser?.data.content).toBe('summarise what changed today')

    expect(ctx.data.trigger).toMatchObject({
      transcribedCommand: 'summarise what changed today',
      routine: { id: 'routine-1', trigger: 'interval' },
    })
  })

  it('tags a session-lifecycle run with its own trigger kind', async () => {
    await fireRoutine(routine({ trigger: { kind: 'session_start' }, label: null }))
    const row = saveConversation.mock.calls[0][0]
    expect(row.source).toBe('routine')
    expect(JSON.parse(row.serializedContext).data.trigger.routine).toEqual({
      id: 'routine-1',
      trigger: 'session_start',
    })
    expect(row.title).toBe('[session_start] summarise what changed today')
  })
})
