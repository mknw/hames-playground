/**
 * Server actions (`lib/harness-client/actions.server.ts`).
 *
 * The turn itself is `runTurnAndPersist` (`turn.server.ts`, pinned by
 * `turn.test.ts`) and is mocked here; everything below the actions — the
 * pattern cache, the Postgres layer and auth — is mocked too. What is asserted
 * is the behaviour the actions themselves own:
 *   - who the run is attributed to (bypass vs. Entra), and that the turn is
 *     handed the right request for it,
 *   - the sidebar surface: listing, bulk delete, load, title regeneration.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

// ── the shared turn driver ──────────────────────────────────────────────────
const runTurnAndPersist = vi.fn(async (req: Record<string, unknown>) => ({
  response: `ran:${req.mode as string}`,
  serialized: 'serialized',
  data: {},
}))
vi.mock('../../../lib/harness-client/turn.server', () => ({ runTurnAndPersist }))

// Only reached through `regenerateConversationTitle`'s dynamic import.
const deserializeContext = vi.fn((s: string) => JSON.parse(s))
vi.mock('../../../lib/harness-patterns', () => ({ deserializeContext }))

// ── session.server (pattern cache + persistence) ────────────────────────────
type Loaded = { serializedContext: string; agentId: string; kind: string; status: string } | null

const loadSession = vi.fn<(id: string, userId: string) => Promise<Loaded>>(async () => null)
const deleteSession = vi.fn(async () => {})
const evictPatterns = vi.fn()
vi.mock('../../../lib/harness-client/session.server', () => ({
  loadSession,
  deleteSession,
  evictPatterns,
}))

// ── registry ────────────────────────────────────────────────────────────────
const AGENTS: Record<string, { icon: string; accent: string }> = {
  search: { icon: 'i-material-symbols-search', accent: 'cyan' },
}
const getAgent = vi.fn((id: string) => AGENTS[id])
const getAgentMetadata = vi.fn(() => [
  {
    id: 'search',
    name: 'Default',
    description: 'd',
    welcome: 'w',
    icon: 'i-x',
    accent: 'cyan',
    servers: ['neo4j'],
  },
])
vi.mock('../../../lib/harness-client/registry.server', () => ({ getAgent, getAgentMetadata }))

// ── db/conversations ────────────────────────────────────────────────────────
const dbListConversations = vi.fn(async () => [] as Array<Record<string, unknown>>)
const dbPromoteConversation = vi.fn<(id: string, userId: string) => Promise<void>>(async () => {})
const dbDeleteConversations = vi.fn(async (ids: string[]) => ids)
vi.mock('../../../lib/db/conversations.server', () => ({
  listConversations: dbListConversations,
  promoteConversation: dbPromoteConversation,
  deleteConversations: dbDeleteConversations,
}))

// ── auth ────────────────────────────────────────────────────────────────────
const isBypassEnabled = vi.fn(() => true)
const getAuthenticatedUser = vi.fn(async () => ({ id: 'entra-user', email: 'e@x.dev' }))
vi.mock('../../../lib/auth/dev-bypass', () => ({
  isBypassEnabled,
  BYPASS_USER: { id: 'bypass-user', email: 'dev@local' },
}))
vi.mock('../../../lib/auth/server', () => ({ getAuthenticatedUser }))

// ── title generator (dynamically imported by the action) ────────────────────
const runRegenerateTitle = vi.fn(async () => 'A better title')
vi.mock('../../../lib/harness-client/agents/title-generator.server', () => ({
  runRegenerateTitle,
}))

const actions = await import('../../../lib/harness-client/actions.server')

beforeEach(() => {
  vi.clearAllMocks()
  isBypassEnabled.mockReturnValue(true)
  loadSession.mockResolvedValue(null)
  dbDeleteConversations.mockImplementation(async (ids: string[]) => ids)
})

describe('processMessage / processMessageWithAgent', () => {
  it('runs one interactive turn as the bypass user, on the default agent', async () => {
    const result = await actions.processMessage('sess-1', 'hello world, this is long')

    expect(runTurnAndPersist).toHaveBeenCalledWith({
      mode: 'interactive',
      sessionId: 'sess-1',
      userId: 'bypass-user',
      agentId: 'search',
      message: 'hello world, this is long',
    })
    expect(result.response).toBe('ran:interactive')
  })

  it('passes the named agent through', async () => {
    await actions.processMessageWithAgent('sess-2', 'follow up', 'neo4j')
    expect(runTurnAndPersist).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'neo4j', message: 'follow up' }),
    )
  })

  it('attributes the run to the Entra user when the dev bypass is off', async () => {
    isBypassEnabled.mockReturnValue(false)
    await actions.processMessage('sess-3', 'who am i')
    expect(runTurnAndPersist).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'entra-user' }),
    )
  })

  it('refuses to run at all without a session', async () => {
    isBypassEnabled.mockReturnValue(false)
    getAuthenticatedUser.mockRejectedValueOnce(new Error('Authentication required'))
    await expect(actions.processMessage('sess-4', 'hi')).rejects.toThrow('Authentication required')
    expect(runTurnAndPersist).not.toHaveBeenCalled()
  })
})

describe('approval gate', () => {
  it('resumes the stored context as approved, for the current user', async () => {
    const result = await actions.approveAction('sess-7')
    expect(runTurnAndPersist).toHaveBeenCalledWith({
      mode: 'approval',
      sessionId: 'sess-7',
      userId: 'bypass-user',
      approved: true,
    })
    expect(result.response).toBe('ran:approval')
  })

  it('resumes as rejected, ignoring the (unused) reason', async () => {
    await actions.rejectAction('sess-8', 'too risky')
    expect(runTurnAndPersist).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'approval', approved: false }),
    )
  })

  // The turn driver owns the "does this session exist?" check — it needs the
  // row anyway to know which agent to resume under.
  it('surfaces the driver’s refusal for a session the user does not own', async () => {
    runTurnAndPersist.mockRejectedValueOnce(new Error('No active session'))
    await expect(actions.approveAction('sess-9')).rejects.toThrow('No active session')
  })
})

describe('sidebar actions', () => {
  it('promotes an action row for the current user only', async () => {
    await actions.promoteAction('sess-10')
    expect(dbPromoteConversation).toHaveBeenCalledWith('sess-10', 'bypass-user')
  })

  it('clears a session through the user-scoped delete', async () => {
    await actions.clearSession('sess-11')
    expect(deleteSession).toHaveBeenCalledWith('sess-11', 'bypass-user')
  })

  it('dedupes ids, caps the batch, and evicts patterns for what was actually deleted', async () => {
    const ids = ['a', 'a', 'b', ...Array.from({ length: 250 }, (_, i) => `x${i}`)]
    dbDeleteConversations.mockResolvedValue(['a', 'b'])

    const { deleted } = await actions.deleteConversationsBulk(ids)

    const passed = dbDeleteConversations.mock.calls[0][0] as string[]
    expect(passed).toHaveLength(200)
    expect(passed.slice(0, 3)).toEqual(['a', 'b', 'x0'])
    expect(deleted).toEqual(['a', 'b'])
    // Only rows the DB confirmed gone lose their cached patterns.
    expect(evictPatterns.mock.calls).toEqual([['a'], ['b']])
  })

  it('lists conversations with the agent icon/accent resolved server-side', async () => {
    dbListConversations.mockResolvedValue([
      {
        id: 'c1',
        agentId: 'search',
        title: 'T',
        kind: 'conversation',
        source: 'chat',
        status: 'done',
        updatedAt: new Date('2026-01-02T03:04:05.000Z'),
      },
      {
        id: 'c2',
        agentId: 'removed-agent',
        title: null,
        kind: 'action',
        source: 'post',
        status: 'running',
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ])

    const rows = await actions.listConversations()

    expect(rows[0]).toEqual({
      id: 'c1',
      agentId: 'search',
      agentIcon: 'i-material-symbols-search',
      agentAccent: 'cyan',
      title: 'T',
      kind: 'conversation',
      source: 'chat',
      status: 'done',
      updatedAt: '2026-01-02T03:04:05.000Z',
    })
    // A removed agent leaves icon/accent undefined rather than breaking the list.
    expect(rows[1].agentIcon).toBeUndefined()
    expect(rows[1].agentAccent).toBeUndefined()
  })

  it('returns an empty list rather than throwing for an unauthenticated page load', async () => {
    isBypassEnabled.mockReturnValue(false)
    getAuthenticatedUser.mockRejectedValueOnce(new Error('no session'))
    await expect(actions.listConversations()).resolves.toEqual([])
    expect(dbListConversations).not.toHaveBeenCalled()
  })

  it('exposes the registry metadata to the agent picker', async () => {
    await expect(actions.getAgentList()).resolves.toEqual(getAgentMetadata())
  })
})

describe('loadConversation', () => {
  it('returns the stored blob plus a chat-ready replay', async () => {
    const serialized = JSON.stringify({
      sessionId: 'sess-12',
      events: [
        { id: 'e1', type: 'user_message', ts: 1, data: { content: 'hi' } },
        { id: 'e2', type: 'assistant_message', ts: 2, data: { content: 'hello', final: true } },
      ],
    })
    loadSession.mockResolvedValue({
      serializedContext: serialized,
      agentId: 'search',
      kind: 'action',
      status: 'done',
    })

    const loaded = await actions.loadConversation('sess-12')

    expect(loaded).toMatchObject({ id: 'sess-12', agentId: 'search', kind: 'action', serialized })
    expect(loaded.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'hi'],
      ['assistant', 'hello'],
    ])
  })

  it('throws for a conversation that is not the current user’s', async () => {
    loadSession.mockResolvedValue(null)
    await expect(actions.loadConversation('nope')).rejects.toThrow('Conversation not found')
  })
})

describe('regenerateConversationTitle', () => {
  it('runs the title generator against the stored context', async () => {
    loadSession.mockResolvedValue({
      serializedContext: '{"sessionId":"sess-13"}',
      agentId: 'search',
      kind: 'conversation',
      status: 'done',
    })

    await expect(actions.regenerateConversationTitle('sess-13')).resolves.toBe('A better title')
    expect(runRegenerateTitle).toHaveBeenCalledWith(
      { sessionId: 'sess-13' },
      'sess-13',
      'bypass-user',
    )
  })

  it('returns null (leaving the title alone) when the conversation is gone', async () => {
    loadSession.mockResolvedValue(null)
    await expect(actions.regenerateConversationTitle('gone')).resolves.toBeNull()
    expect(runRegenerateTitle).not.toHaveBeenCalled()
  })
})
