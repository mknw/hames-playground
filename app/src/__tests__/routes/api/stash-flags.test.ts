/**
 * POST /api/stash — hide / unhide / archive / unarchive a tool result.
 *
 * The route is a read-modify-write over the persisted UnifiedContext, so the
 * behaviour worth pinning is which flags each action ends up writing (archive
 * un-hides, per the panel's semantics), that the write is scoped to the
 * caller's own session, that nothing is saved when the target is missing, and
 * that the write is pinned to the version it read — the turn's own
 * `compactAndSave` fires just after the answer lands, which is exactly when a
 * user acts on a tool result.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const loadConversation =
  vi.fn<
    (id: string, userId: string) => Promise<{ serializedContext: string; version: string } | null>
  >()
const updateConversationContextIfUnchanged = vi.fn<
  (id: string, userId: string, serialized: string, version: string) => Promise<boolean>
>(async () => true)
const saveConversation = vi.fn<(input: unknown) => Promise<void>>(async () => {})
vi.mock('../../../lib/db/conversations.server', () => ({
  loadConversation: (id: string, userId: string) => loadConversation(id, userId),
  updateConversationContextIfUnchanged: (
    id: string,
    userId: string,
    serialized: string,
    version: string,
  ) => updateConversationContextIfUnchanged(id, userId, serialized, version),
  saveConversation: (input: unknown) => saveConversation(input),
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
vi.mock('@hames-ai/harness-patterns', () => ({
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

/** The row handed back to the route, as the repository would load it. */
function stored(flags: { hidden?: boolean; archived?: boolean } = {}) {
  return {
    serializedContext: JSON.stringify({ results: { 'evt-1': { ...flags } } } satisfies FakeCtx),
    version: 'v-1',
  }
}

/** What the route wrote back, parsed. */
function savedFlags() {
  const blob = updateConversationContextIfUnchanged.mock.calls[0][2]
  return (JSON.parse(blob) as FakeCtx).results['evt-1']
}

beforeEach(() => {
  vi.clearAllMocks()
  bypass = false
  updateConversationContextIfUnchanged.mockResolvedValue(true)
  getAuthenticatedUser.mockResolvedValue({ id: 'user-1' })
  loadConversation.mockResolvedValue(stored())
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
    expect(loadConversation).not.toHaveBeenCalled()
  })

  it('401s without a session', async () => {
    getAuthenticatedUser.mockRejectedValue(new Error('Authentication required'))
    const res = await POST(evt({ sessionId: 's1', eventId: 'evt-1', action: 'hide' }))
    expect(res.status).toBe(401)
    expect(loadConversation).not.toHaveBeenCalled()
  })

  it('404s a session the caller does not own, without writing', async () => {
    loadConversation.mockResolvedValue(null)
    const res = await POST(evt({ sessionId: 'theirs', eventId: 'evt-1', action: 'hide' }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Session not found' })
    expect(updateConversationContextIfUnchanged).not.toHaveBeenCalled()
  })

  it('hides and unhides a tool result', async () => {
    expect((await POST(evt({ sessionId: 's1', eventId: 'evt-1', action: 'hide' }))).status).toBe(
      200,
    )
    expect(savedFlags()).toEqual({ hidden: true })

    updateConversationContextIfUnchanged.mockClear()
    loadConversation.mockResolvedValue(stored({ hidden: true }))
    await POST(evt({ sessionId: 's1', eventId: 'evt-1', action: 'unhide' }))
    expect(savedFlags()).toEqual({ hidden: false })
  })

  it('archiving also clears hidden, so an archived result is not doubly filtered', async () => {
    loadConversation.mockResolvedValue(stored({ hidden: true }))
    await POST(evt({ sessionId: 's1', eventId: 'evt-1', action: 'archive' }))
    expect(savedFlags()).toEqual({ hidden: false, archived: true })

    updateConversationContextIfUnchanged.mockClear()
    loadConversation.mockResolvedValue(stored({ archived: true }))
    await POST(evt({ sessionId: 's1', eventId: 'evt-1', action: 'unarchive' }))
    expect(savedFlags()).toEqual({ archived: false })
  })

  it('reads and writes as the authenticated user, pinned to the version it read', async () => {
    await POST(evt({ sessionId: 's1', eventId: 'evt-1', action: 'hide' }))
    expect(loadConversation).toHaveBeenCalledWith('s1', 'user-1')
    const [id, userId, , version] = updateConversationContextIfUnchanged.mock.calls[0]
    expect([id, userId, version]).toEqual(['s1', 'user-1', 'v-1'])
    // Context only. The blob this route holds can be a turn behind, so
    // restamping `status`/`title`/`agent_id` from it would undo the turn's own.
    expect(saveConversation).not.toHaveBeenCalled()
  })

  it('409s when the conversation moved on between the read and the write', async () => {
    // The competing writer is the turn's own `compactAndSave`, which fires
    // after the stream closes — i.e. while the user is looking at the finished
    // tool results. An unguarded write here answers `{"ok":true}` and either
    // loses the flag or replaces the whole turn with the blob it loaded.
    updateConversationContextIfUnchanged.mockResolvedValue(false)
    const res = await POST(evt({ sessionId: 's1', eventId: 'evt-1', action: 'hide' }))
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/changed/i)
    expect(saveConversation).not.toHaveBeenCalled()
  })

  it('resolves the user from dev-bypass when it is enabled', async () => {
    bypass = true
    await POST(evt({ sessionId: 's1', eventId: 'evt-1', action: 'hide' }))
    expect(getAuthenticatedUser).not.toHaveBeenCalled()
    expect(loadConversation).toHaveBeenCalledWith('s1', 'dev-bypass-user')
  })

  it('400s an unknown action before touching the context', async () => {
    const res = await POST(evt({ sessionId: 's1', eventId: 'evt-1', action: 'incinerate' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/Invalid action/)
    expect(enrichToolResult).not.toHaveBeenCalled()
    expect(updateConversationContextIfUnchanged).not.toHaveBeenCalled()
  })

  it('404s an eventId that is not in the context, without saving', async () => {
    const res = await POST(evt({ sessionId: 's1', eventId: 'ghost', action: 'hide' }))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'Tool result event not found' })
    expect(updateConversationContextIfUnchanged).not.toHaveBeenCalled()
  })
})
