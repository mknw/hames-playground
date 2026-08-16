/**
 * POST /api/stash — hide / unhide / archive / unarchive a tool result.
 *
 * The route is a read-modify-write over the persisted UnifiedContext, so the
 * behaviour worth pinning is which flags each action ends up writing (archive
 * un-hides, per the panel's semantics), that the write is scoped to the
 * caller's own session, and that nothing is saved when the target is missing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const loadSession =
  vi.fn<
    (
      sessionId: string,
      userId: string,
    ) => Promise<{ serializedContext: string; agentId: string } | null>
  >()
const saveSession = vi.fn<
  (sessionId: string, userId: string, agentId: string, serialized: string) => Promise<void>
>(async () => {})
vi.mock('../../../lib/harness-client/session.server', () => ({
  loadSession: (sessionId: string, userId: string) => loadSession(sessionId, userId),
  saveSession: (sessionId: string, userId: string, agentId: string, serialized: string) =>
    saveSession(sessionId, userId, agentId, serialized),
}))

/** Stand-in context: a bag of tool results the route patches in place. */
interface FakeCtx {
  results: Record<string, { hidden?: boolean; archived?: boolean }>
}
const enrichToolResult = vi.fn(
  (ctx: FakeCtx, eventId: string, patch: { hidden?: boolean; archived?: boolean }) => {
    const target = ctx.results[eventId]
    if (!target) return false
    Object.assign(target, patch)
    return true
  },
)
vi.mock('../../../lib/harness-patterns', () => ({
  deserializeContext: (blob: string) => JSON.parse(blob) as FakeCtx,
  serializeContext: (ctx: FakeCtx) => JSON.stringify(ctx),
  enrichToolResult: (...a: unknown[]) => enrichToolResult(...(a as [FakeCtx, string, never])),
}))

const getAuthenticatedUser = vi.fn<() => Promise<{ id: string }>>()
vi.mock('../../../lib/auth/server', () => ({ getAuthenticatedUser }))
let bypass = false
vi.mock('../../../lib/auth/dev-bypass', () => ({
  isBypassEnabled: () => bypass,
  BYPASS_USER: { id: 'dev-bypass-user', email: 'dev@local' },
}))

const { POST } = await import('../../../routes/api/stash')

function evt(body: unknown) {
  return {
    params: {},
    request: new Request('http://x/api/stash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never
}

/** The context blob handed back to the route, as the store would hold it. */
function stored(flags: { hidden?: boolean; archived?: boolean } = {}) {
  return {
    serializedContext: JSON.stringify({ results: { 'evt-1': { ...flags } } } satisfies FakeCtx),
    agentId: 'neo4j',
  }
}

/** What the route wrote back, parsed. */
function savedFlags() {
  const blob = saveSession.mock.calls[0][3]
  return (JSON.parse(blob) as FakeCtx).results['evt-1']
}

beforeEach(() => {
  vi.clearAllMocks()
  bypass = false
  getAuthenticatedUser.mockResolvedValue({ id: 'user-1' })
  loadSession.mockResolvedValue(stored())
})

describe('POST /api/stash', () => {
  it('400s when sessionId, eventId, or action is missing', async () => {
    for (const body of [
      { eventId: 'evt-1', action: 'hide' },
      { sessionId: 's1', action: 'hide' },
      { sessionId: 's1', eventId: 'evt-1' },
    ]) {
      const res = await POST(evt(body))
      expect(res.status).toBe(400)
    }
    expect(loadSession).not.toHaveBeenCalled()
  })

  it('401s without a session', async () => {
    getAuthenticatedUser.mockRejectedValue(new Error('Authentication required'))
    const res = await POST(evt({ sessionId: 's1', eventId: 'evt-1', action: 'hide' }))
    expect(res.status).toBe(401)
    expect(loadSession).not.toHaveBeenCalled()
  })

  it('404s a session the caller does not own, without writing', async () => {
    loadSession.mockResolvedValue(null)
    const res = await POST(evt({ sessionId: 'theirs', eventId: 'evt-1', action: 'hide' }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Session not found' })
    expect(saveSession).not.toHaveBeenCalled()
  })

  it('hides and unhides a tool result', async () => {
    expect((await POST(evt({ sessionId: 's1', eventId: 'evt-1', action: 'hide' }))).status).toBe(
      200,
    )
    expect(savedFlags()).toEqual({ hidden: true })

    saveSession.mockClear()
    loadSession.mockResolvedValue(stored({ hidden: true }))
    await POST(evt({ sessionId: 's1', eventId: 'evt-1', action: 'unhide' }))
    expect(savedFlags()).toEqual({ hidden: false })
  })

  it('archiving also clears hidden, so an archived result is not doubly filtered', async () => {
    loadSession.mockResolvedValue(stored({ hidden: true }))
    await POST(evt({ sessionId: 's1', eventId: 'evt-1', action: 'archive' }))
    expect(savedFlags()).toEqual({ hidden: false, archived: true })

    saveSession.mockClear()
    loadSession.mockResolvedValue(stored({ archived: true }))
    await POST(evt({ sessionId: 's1', eventId: 'evt-1', action: 'unarchive' }))
    expect(savedFlags()).toEqual({ archived: false })
  })

  it('saves under the session’s own agentId and the authenticated user', async () => {
    await POST(evt({ sessionId: 's1', eventId: 'evt-1', action: 'hide' }))
    expect(loadSession).toHaveBeenCalledWith('s1', 'user-1')
    expect(saveSession.mock.calls[0].slice(0, 3)).toEqual(['s1', 'user-1', 'neo4j'])
  })

  it('resolves the user from dev-bypass when it is enabled', async () => {
    bypass = true
    await POST(evt({ sessionId: 's1', eventId: 'evt-1', action: 'hide' }))
    expect(getAuthenticatedUser).not.toHaveBeenCalled()
    expect(loadSession).toHaveBeenCalledWith('s1', 'dev-bypass-user')
  })

  it('400s an unknown action before touching the context', async () => {
    const res = await POST(evt({ sessionId: 's1', eventId: 'evt-1', action: 'incinerate' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Invalid action/)
    expect(enrichToolResult).not.toHaveBeenCalled()
    expect(saveSession).not.toHaveBeenCalled()
  })

  it('404s an eventId that is not in the context, without saving', async () => {
    const res = await POST(evt({ sessionId: 's1', eventId: 'ghost', action: 'hide' }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Tool result event not found' })
    expect(saveSession).not.toHaveBeenCalled()
  })
})
