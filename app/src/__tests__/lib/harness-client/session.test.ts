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
  doNotCachePatterns,
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

  it('skips the cache when the build called doNotCachePatterns', async () => {
    // A degraded build (e.g. the general agent's graph-schema fetch failing)
    // is usable now but must not be frozen into the session — an eviction from
    // inside createPatterns would be overwritten by the write that follows it.
    createPatterns.mockImplementationOnce(async (sessionId: string) => {
      doNotCachePatterns(sessionId)
      return [{ id: `degraded-${sessionId}` }]
    })

    const degraded = await getOrBuildPatterns('cache-5', 'known')
    const rebuilt = await getOrBuildPatterns('cache-5', 'known')

    expect(degraded).toEqual([{ id: 'degraded-cache-5' }])
    expect(rebuilt).not.toBe(degraded)
    expect(createPatterns).toHaveBeenCalledTimes(2)
  })

  it('drops a previously cached entry when a rebuild comes out degraded', async () => {
    await getOrBuildPatterns('cache-6', 'known')
    evictPatterns('cache-6')
    createPatterns.mockImplementationOnce(async (sessionId: string) => {
      doNotCachePatterns(sessionId)
      return [{ id: `degraded-${sessionId}` }]
    })
    await getOrBuildPatterns('cache-6', 'known')

    // Third call must build again rather than serve the degraded one.
    await getOrBuildPatterns('cache-6', 'known')
    expect(createPatterns).toHaveBeenCalledTimes(3)
  })

  it('ignores doNotCachePatterns from outside a getOrBuildPatterns build', async () => {
    // The registry capability probes (agentUsesCodeMode &c.) call
    // createPatterns directly and discard the result. A degraded probe build
    // must not leave a flag that costs the next REAL build its cache entry.
    doNotCachePatterns('cache-7')

    const first = await getOrBuildPatterns('cache-7', 'known')
    const second = await getOrBuildPatterns('cache-7', 'known')

    expect(second).toBe(first)
    expect(createPatterns).toHaveBeenCalledTimes(1)
  })

  it('still honours doNotCachePatterns when a concurrent build finishes first', async () => {
    // getOrBuildPatterns has no in-flight dedupe, so two entry points can build
    // the same session at once. The fast build must not clear the "am I inside
    // a build" marker out from under the slow one — that would silently drop
    // the slow build's degraded flag and freeze it into the session.
    let release: () => void = () => {}
    const blocked = new Promise<void>((r) => (release = r))
    createPatterns
      .mockImplementationOnce(async (sessionId: string) => {
        doNotCachePatterns(sessionId)
        await blocked
        return [{ id: `slow-${sessionId}` }]
      })
      .mockImplementationOnce(async (sessionId: string) => [{ id: `fast-${sessionId}` }])

    const slow = getOrBuildPatterns('cache-9', 'known')
    await getOrBuildPatterns('cache-9', 'known') // fast build settles first
    release()
    await slow

    // The slow build was degraded, so nothing may be served from the cache.
    await getOrBuildPatterns('cache-9', 'known')
    expect(createPatterns).toHaveBeenCalledTimes(3)
  })

  it('drops the flag when the build itself throws', async () => {
    createPatterns.mockImplementationOnce(async (sessionId: string) => {
      doNotCachePatterns(sessionId)
      throw new Error('build blew up')
    })
    await expect(getOrBuildPatterns('cache-8', 'known')).rejects.toThrow('build blew up')

    const first = await getOrBuildPatterns('cache-8', 'known')
    const second = await getOrBuildPatterns('cache-8', 'known')
    expect(second).toBe(first)
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

  // sf-L3: the write must still happen (the blob is all we have), but calling
  // an unreadable conversation 'done' is the one case where that badge lies —
  // nothing in it can be replayed.
  it('persists an unparseable blob as status error, not done', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await saveSession('sess-d', 'u1', 'known', 'not json at all')
    expect(saveConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        title: null,
        status: 'error',
        serializedContext: 'not json at all',
      }),
    )
    expect(err).toHaveBeenCalled()
    err.mockRestore()
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

  it('clears a pending uncacheable flag for the deleted session', async () => {
    // The flag lives between "set inside createPatterns" and "consumed by
    // getOrBuildPatterns". A delete inside that window used to leave it behind
    // for the life of the process, so the id's next build skipped its cache
    // write. Reproduce the window with a build that blocks after flagging.
    let release: () => void = () => {}
    const flagged = new Promise<void>((r) => (release = r))
    createPatterns.mockImplementationOnce(async (sessionId: string) => {
      doNotCachePatterns(sessionId)
      await flagged
      return [{ id: `degraded-${sessionId}` }]
    })

    const inFlight = getOrBuildPatterns('del-2', 'known')
    await deleteSession('del-2', 'u1')
    release()
    const built = await inFlight

    // The id starts clean after the delete: the very next lookup is served
    // from the cache. With the flag left pending, `inFlight` would have
    // consumed it, dropped its own cache entry, and forced a second build.
    expect(await getOrBuildPatterns('del-2', 'known')).toBe(built)
    expect(createPatterns).toHaveBeenCalledTimes(1)
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
