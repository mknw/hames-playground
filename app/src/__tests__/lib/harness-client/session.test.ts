/**
 * Session layer (`lib/harness-client/session.server.ts`) — the split between
 * the in-process pattern cache (non-serializable) and the Postgres-backed
 * serialized context.
 *
 * The DB layer and the agent registry are mocked; the real context
 * serialize/deserialize helpers are used, so the title/status lifting is
 * exercised against genuine blobs.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

type Row = {
  serializedContext: string
  agentId: string
  kind: string
  status: string
} | null

const loadConversation = vi.fn<(id: string, userId: string) => Promise<Row>>(async () => null)
const saveConversation = vi.fn<(row: Record<string, unknown>) => Promise<void>>(async () => {})
const deleteConversation = vi.fn<(id: string, userId: string) => Promise<void>>(async () => {})
vi.mock('../../../lib/db/conversations.server', () => ({
  loadConversation,
  saveConversation,
  deleteConversation,
  deriveTitle: (s: string) => (s ? s.slice(0, 12) : null),
}))

const createPatterns = vi.fn(async (sessionId: string) => [{ id: `p-${sessionId}` }])
const getAgent = vi.fn((id: string) => (id === 'known' ? { id, createPatterns } : undefined))
vi.mock('../../../lib/harness-client/registry.server', () => ({ getAgent }))

const { createContext, serializeContext } = await import('../../../lib/harness-patterns')
const {
  getOrBuildPatterns,
  evictPatterns,
  loadSession,
  saveSession,
  deleteSession,
  hasPendingApproval,
  persistContext,
} = await import('../../../lib/harness-client/session.server')

beforeEach(() => {
  vi.clearAllMocks()
  loadConversation.mockResolvedValue(null)
  getAgent.mockImplementation((id: string) => (id === 'known' ? { id, createPatterns } : undefined))
})

describe('pattern cache', () => {
  it('builds patterns once per (session, agent) and reuses them', async () => {
    const first = await getOrBuildPatterns('cache-1', 'known')
    const second = await getOrBuildPatterns('cache-1', 'known')

    expect(second).toBe(first)
    expect(createPatterns).toHaveBeenCalledTimes(1)
    expect(createPatterns).toHaveBeenCalledWith('cache-1')
  })

  it('rebuilds when the same session asks for a different agent', async () => {
    getAgent.mockImplementation((id: string) => ({ id, createPatterns }))
    const first = await getOrBuildPatterns('cache-2', 'known')
    const second = await getOrBuildPatterns('cache-2', 'other')

    expect(second).not.toBe(first)
    expect(createPatterns).toHaveBeenCalledTimes(2)
  })

  it('rebuilds after eviction', async () => {
    await getOrBuildPatterns('cache-3', 'known')
    evictPatterns('cache-3')
    await getOrBuildPatterns('cache-3', 'known')
    expect(createPatterns).toHaveBeenCalledTimes(2)
  })

  it('refuses an unregistered agent', async () => {
    await expect(getOrBuildPatterns('cache-4', 'ghost')).rejects.toThrow('Unknown agent: ghost')
  })
})

describe('loadSession', () => {
  it('returns null when the row does not exist for this user', async () => {
    await expect(loadSession('s', 'u')).resolves.toBeNull()
    expect(loadConversation).toHaveBeenCalledWith('s', 'u')
  })

  it('lifts kind and status out of the row alongside the blob', async () => {
    loadConversation.mockResolvedValue({
      serializedContext: '{"status":"paused"}',
      agentId: 'known',
      kind: 'action',
      status: 'paused',
    })
    await expect(loadSession('s', 'u')).resolves.toEqual({
      serializedContext: '{"status":"paused"}',
      agentId: 'known',
      kind: 'action',
      status: 'paused',
    })
  })
})

describe('saveSession — title + status lifting', () => {
  it('derives the title from the first user_message and stores a finished run as done', async () => {
    const ctx = createContext('Explain the graph schema please', undefined, 'sess-a')
    await saveSession('sess-a', 'u1', 'known', serializeContext(ctx))

    expect(saveConversation).toHaveBeenCalledWith({
      id: 'sess-a',
      userId: 'u1',
      agentId: 'known',
      title: 'Explain the ',
      serializedContext: serializeContext(ctx),
      // The harness never flips a successful run to 'done' — a persisted
      // 'running' means "completed, never flipped".
      status: 'done',
    })
  })

  it('preserves paused and error, the two statuses that are set deliberately', async () => {
    for (const status of ['paused', 'error'] as const) {
      const ctx = { ...createContext('hi', undefined, 'sess-b'), status }
      await saveSession('sess-b', 'u1', 'known', serializeContext(ctx))
      expect(saveConversation.mock.lastCall?.[0]).toMatchObject({ status })
    }
  })

  it('stores a null title when the context carries no user message', async () => {
    const ctx = { ...createContext('hi', undefined, 'sess-c'), events: [] }
    await saveSession('sess-c', 'u1', 'known', serializeContext(ctx))
    expect(saveConversation.mock.lastCall?.[0]).toMatchObject({ title: null })
  })

  it('survives an unparseable blob without blocking the write', async () => {
    await saveSession('sess-d', 'u1', 'known', 'not json at all')
    expect(saveConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        title: null,
        status: 'done',
        serializedContext: 'not json at all',
      }),
    )
  })

  it('omits kind/source so an existing action row is never demoted', async () => {
    await saveSession(
      'sess-e',
      'u1',
      'known',
      serializeContext(createContext('x', undefined, 'sess-e')),
    )
    const written = saveConversation.mock.lastCall![0]
    expect('kind' in written).toBe(false)
    expect('source' in written).toBe(false)
  })
})

describe('deleteSession', () => {
  it('drops the cached patterns as well as the row', async () => {
    const built = await getOrBuildPatterns('del-1', 'known')
    await deleteSession('del-1', 'u1')

    expect(deleteConversation).toHaveBeenCalledWith('del-1', 'u1')
    const rebuilt = await getOrBuildPatterns('del-1', 'known')
    expect(rebuilt).not.toBe(built)
  })
})

describe('hasPendingApproval', () => {
  it('is true only for a persisted paused context', async () => {
    loadConversation.mockResolvedValue({
      serializedContext: serializeContext({
        ...createContext('x', undefined, 's'),
        status: 'paused',
      }),
      agentId: 'known',
      kind: 'conversation',
      status: 'paused',
    })
    await expect(hasPendingApproval('s', 'u')).resolves.toBe(true)
  })

  it('is false for a finished run, a missing row, and a corrupt blob', async () => {
    loadConversation.mockResolvedValue({
      serializedContext: serializeContext(createContext('x', undefined, 's')),
      agentId: 'known',
      kind: 'conversation',
      status: 'done',
    })
    await expect(hasPendingApproval('s', 'u')).resolves.toBe(false)

    loadConversation.mockResolvedValue(null)
    await expect(hasPendingApproval('s', 'u')).resolves.toBe(false)

    loadConversation.mockResolvedValue({
      serializedContext: '<<corrupt>>',
      agentId: 'known',
      kind: 'conversation',
      status: 'done',
    })
    await expect(hasPendingApproval('s', 'u')).resolves.toBe(false)
  })
})

describe('persistContext', () => {
  it('re-serializes a mutated in-memory context through the same save path', async () => {
    const ctx = createContext<Record<string, unknown>>('Mutated in place', {}, 'sess-f')
    await persistContext('sess-f', 'u1', 'known', ctx)

    expect(saveConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'sess-f',
        userId: 'u1',
        serializedContext: serializeContext(ctx),
        title: 'Mutated in p',
      }),
    )
  })
})
