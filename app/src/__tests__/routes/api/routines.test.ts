/**
 * Routines management API (#131) — auth, validation, and user scoping.
 * The store is mocked; this asserts the routes' HTTP behaviour.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const getAuthenticatedUser = vi.fn<() => Promise<{ id: string; email: string }>>()
vi.mock('../../../lib/auth/server', () => ({ getAuthenticatedUser }))
vi.mock('../../../lib/auth/dev-bypass', () => ({
  isBypassEnabled: () => false,
  BYPASS_USER: { id: 'dev-bypass-user', email: 'dev@local' },
}))

const getAgent = vi.fn<(id: string) => { id: string } | undefined>()
vi.mock('../../../lib/harness-client/registry.server', () => ({ getAgent }))

type Row = {
  id: string
  userId: string
  agentId: string
  trigger: { kind: string; intervalSeconds?: number }
  input: string
  label: string | null
  enabled: boolean
  lastRunAt: Date | null
  createdAt: Date
  updatedAt: Date
}

const createRoutine = vi.fn<(input: Record<string, unknown>) => Promise<Row>>()
const listRoutines = vi.fn<() => Promise<Row[]>>(async () => [])
const updateRoutine = vi.fn<() => Promise<Row | null>>()
const deleteRoutine = vi.fn<() => Promise<boolean>>(async () => true)
vi.mock('../../../lib/db/routines.server', () => ({
  createRoutine,
  listRoutines,
  updateRoutine,
  deleteRoutine,
}))

vi.mock('../../../lib/session-id', () => ({ newSessionId: () => 'routine-fixed' }))

const T0 = new Date('2026-08-16T12:00:00Z')
const row = (over: Partial<Row> = {}): Row => ({
  id: 'routine-1',
  userId: 'user-1',
  agentId: 'search',
  trigger: { kind: 'interval', intervalSeconds: 3600 },
  input: 'go',
  label: null,
  enabled: true,
  lastRunAt: null,
  createdAt: T0,
  updatedAt: T0,
  ...over,
})

const index = await import('../../../routes/api/routines/index')
const byId = await import('../../../routes/api/routines/[id]')

function jsonEvent(body: unknown, id = 'routine-1') {
  return {
    params: { id },
    request: new Request('http://x/api/routines', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  getAuthenticatedUser.mockResolvedValue({ id: 'user-1', email: 'u@x' })
  getAgent.mockReturnValue({ id: 'search' })
  listRoutines.mockResolvedValue([])
  createRoutine.mockImplementation(async (input) => row(input as Partial<Row>))
  updateRoutine.mockResolvedValue(row({ enabled: false }))
  deleteRoutine.mockResolvedValue(true)
})

describe('GET /api/routines', () => {
  it('401s without a session', async () => {
    getAuthenticatedUser.mockRejectedValue(new Error('no session'))
    expect((await index.GET()).status).toBe(401)
    expect(listRoutines).not.toHaveBeenCalled()
  })

  it('returns the caller’s routines plus the trigger catalogue', async () => {
    listRoutines.mockResolvedValue([row({ label: 'Digest' })])
    const res = await index.GET()
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(listRoutines).toHaveBeenCalledWith('user-1')
    expect(body.routines).toEqual([
      {
        id: 'routine-1',
        agentId: 'search',
        trigger: 'interval',
        triggerConfig: { intervalSeconds: 3600 },
        input: 'go',
        label: 'Digest',
        enabled: true,
        lastRunAt: null,
        createdAt: T0.toISOString(),
      },
    ])
    // The catalogue is derived from the registry, so a new kind shows up here
    // without touching the route.
    expect(body.triggers.map((t: { kind: string }) => t.kind)).toEqual([
      'interval',
      'session_start',
      'session_end',
    ])
  })
})

describe('POST /api/routines', () => {
  it('401s without a session', async () => {
    getAuthenticatedUser.mockRejectedValue(new Error('no session'))
    expect((await index.POST(jsonEvent({}))).status).toBe(401)
  })

  it('creates an interval routine owned by the caller', async () => {
    const res = await index.POST(
      jsonEvent({
        agentId: 'search',
        trigger: 'interval',
        triggerConfig: { intervalSeconds: 3600 },
        input: '  daily digest  ',
        label: ' Digest ',
      }),
    )
    expect(res.status).toBe(201)
    expect(createRoutine).toHaveBeenCalledWith({
      id: 'routine-fixed',
      userId: 'user-1',
      agentId: 'search',
      trigger: { kind: 'interval', intervalSeconds: 3600 },
      input: 'daily digest',
      label: 'Digest',
      enabled: true,
    })
    expect((await res.json()).routine.trigger).toBe('interval')
  })

  it('creates a session-lifecycle routine with no config', async () => {
    const res = await index.POST(
      jsonEvent({ agentId: 'search', trigger: 'session_start', input: 'brief me' }),
    )
    expect(res.status).toBe(201)
    expect(createRoutine.mock.calls[0][0].trigger).toEqual({ kind: 'session_start' })
  })

  it('400s a missing agentId, input, or unknown agent', async () => {
    expect((await index.POST(jsonEvent({ trigger: 'interval', input: 'x' }))).status).toBe(400)
    expect((await index.POST(jsonEvent({ agentId: 'search', trigger: 'interval' }))).status).toBe(
      400,
    )
    getAgent.mockReturnValue(undefined)
    const res = await index.POST(jsonEvent({ agentId: 'ghost', trigger: 'interval', input: 'x' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Unknown agent/)
    expect(createRoutine).not.toHaveBeenCalled()
  })

  it('400s an unknown trigger kind or an out-of-range interval', async () => {
    const unknown = await index.POST(
      jsonEvent({ agentId: 'search', trigger: 'webhook', input: 'x' }),
    )
    expect(unknown.status).toBe(400)
    expect((await unknown.json()).error).toMatch(/Unknown routine trigger kind/)

    const tooFast = await index.POST(
      jsonEvent({
        agentId: 'search',
        trigger: 'interval',
        triggerConfig: { intervalSeconds: 5 },
        input: 'x',
      }),
    )
    expect(tooFast.status).toBe(400)
    expect((await tooFast.json()).error).toMatch(/at least 60/)
  })

  it('400s a non-JSON body', async () => {
    const res = await index.POST({
      params: {},
      request: new Request('http://x/api/routines', { method: 'POST', body: 'nope' }),
    } as never)
    expect(res.status).toBe(400)
  })
})

describe('PATCH /api/routines/:id', () => {
  it('401s without a session', async () => {
    getAuthenticatedUser.mockRejectedValue(new Error('no session'))
    expect((await byId.PATCH(jsonEvent({ enabled: false }))).status).toBe(401)
  })

  it('toggles enabled, scoped to the caller', async () => {
    const res = await byId.PATCH(jsonEvent({ enabled: false }))
    expect(res.status).toBe(200)
    expect(updateRoutine).toHaveBeenCalledWith('routine-1', 'user-1', { enabled: false })
    expect((await res.json()).routine.enabled).toBe(false)
  })

  it('patches input, label, and the trigger together', async () => {
    await byId.PATCH(
      jsonEvent({
        input: ' new input ',
        label: '  ',
        trigger: 'interval',
        triggerConfig: { intervalSeconds: 120 },
      }),
    )
    expect(updateRoutine).toHaveBeenCalledWith('routine-1', 'user-1', {
      input: 'new input',
      // A blank label clears it rather than storing whitespace.
      label: null,
      trigger: { kind: 'interval', intervalSeconds: 120 },
    })
  })

  it('400s an empty input or an invalid trigger', async () => {
    expect((await byId.PATCH(jsonEvent({ input: '   ' }))).status).toBe(400)
    expect((await byId.PATCH(jsonEvent({ trigger: 'nope' }))).status).toBe(400)
    expect(updateRoutine).not.toHaveBeenCalled()
  })

  it('404s another user’s routine (the store scopes by user_id)', async () => {
    updateRoutine.mockResolvedValue(null)
    expect((await byId.PATCH(jsonEvent({ enabled: false }))).status).toBe(404)
  })
})

describe('DELETE /api/routines/:id', () => {
  it('401s without a session', async () => {
    getAuthenticatedUser.mockRejectedValue(new Error('no session'))
    expect((await byId.DELETE(jsonEvent({}))).status).toBe(401)
  })

  it('deletes, and 404s an id that is not the caller’s', async () => {
    expect((await byId.DELETE(jsonEvent({}))).status).toBe(200)
    expect(deleteRoutine).toHaveBeenCalledWith('routine-1', 'user-1')

    deleteRoutine.mockResolvedValue(false)
    expect((await byId.DELETE(jsonEvent({}))).status).toBe(404)
  })
})
