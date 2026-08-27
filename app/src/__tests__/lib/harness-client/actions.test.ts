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
const dbGetConversationInferenceTier = vi.fn<
  (id: string, userId: string) => Promise<string | null>
>(async () => null)
const dbSetConversationPinned = vi.fn<
  (id: string, userId: string, pinned: boolean) => Promise<string>
>(async () => 'pinned')
vi.mock('../../../lib/db/conversations.server', () => ({
  listConversations: dbListConversations,
  promoteConversation: dbPromoteConversation,
  deleteConversations: dbDeleteConversations,
  getConversationInferenceTier: dbGetConversationInferenceTier,
  setConversationPinned: dbSetConversationPinned,
  CONVERSATION_PIN_LIMIT: 3,
}))

// ── the tier resolver (its own order is pinned by lib/inference/tier.test.ts) ─
const getStoredInferenceTier = vi.fn<(id: string) => Promise<'verda' | 'anthropic' | null>>(
  async () => null,
)
vi.mock('../../../lib/db/user-prefs.server', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/db/user-prefs.server')>(
    '../../../lib/db/user-prefs.server',
  )
  // Only the DB read is stubbed. `isInferenceTier` and `defaultInferenceTier`
  // are the real ones, because `resolveTier` below is the real one.
  return { ...actual, getStoredInferenceTier }
})

const chooseConversationTier = vi.fn<
  (sessionId: string, userId: string, tier: unknown) => Promise<'verda' | 'anthropic'>
>(async (_s, _u, tier) => tier as 'verda' | 'anthropic')
const verdaConfigured = vi.fn(() => true)
vi.mock('../../../lib/inference/tier.server', async () => {
  const actual = await vi.importActual<typeof import('../../../lib/inference/tier.server')>(
    '../../../lib/inference/tier.server',
  )
  return {
    // The ORDER is the real implementation: the list's glyph and the switch have
    // to reach the same answer the turn runner does, and a stubbed resolver here
    // would assert that this module calls something rather than that it agrees.
    resolveTier: actual.resolveTier,
    chooseConversationTier: (s: string, u: string, t: unknown) => chooseConversationTier(s, u, t),
    verdaConfigured: () => verdaConfigured(),
  }
})

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
  dbGetConversationInferenceTier.mockResolvedValue(null)
  getStoredInferenceTier.mockResolvedValue(null)
  verdaConfigured.mockReturnValue(true)
  chooseConversationTier.mockImplementation(async (_s, _u, tier) => tier as 'verda' | 'anthropic')
  dbSetConversationPinned.mockResolvedValue('pinned')
  getAuthenticatedUser.mockResolvedValue({ id: 'entra-user', email: 'e@x.dev' })
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
        inferenceTier: 'verda',
        updatedAt: new Date('2026-01-02T03:04:05.000Z'),
        pinnedAt: new Date('2026-01-03T00:00:00.000Z'),
      },
      {
        id: 'c2',
        agentId: 'removed-agent',
        title: null,
        kind: 'action',
        source: 'post',
        status: 'running',
        // No tier of its own — a legacy row, or an action seeded before one was
        // resolved. It resolves through the seed below rather than showing
        // nothing, because the glyph is on every row.
        inferenceTier: null,
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        pinnedAt: null,
      },
    ])
    getStoredInferenceTier.mockResolvedValue('anthropic')

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
      inferenceTier: 'verda',
      updatedAt: '2026-01-02T03:04:05.000Z',
      // Serialized like `updatedAt`: a Date does not survive the server-action
      // boundary, and an unpinned row carries an explicit null rather than an
      // absent key.
      pinnedAt: '2026-01-03T00:00:00.000Z',
    })
    // A removed agent leaves icon/accent undefined rather than breaking the list.
    expect(rows[1].agentIcon).toBeUndefined()
    expect(rows[1].agentAccent).toBeUndefined()
    // Resolved, never null: an untiered row falls through to the seed, so every
    // row carries an answer the sidebar can render.
    expect(rows[1].inferenceTier).toBe('anthropic')
    // One seed read for the whole list, not one per row.
    expect(getStoredInferenceTier).toHaveBeenCalledTimes(1)
    expect(rows[1].pinnedAt).toBeNull()
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

describe('getConversationTier / setConversationTier — the switch’s RPC surface', () => {
  it('answers for the conversation, resolving an untiered row through the seed', async () => {
    getStoredInferenceTier.mockResolvedValue('anthropic')
    dbGetConversationInferenceTier.mockResolvedValue('verda')
    await expect(actions.getConversationTier('c1')).resolves.toEqual({
      tier: 'verda',
      verdaAvailable: true,
    })

    // Every chat before its first message: no row, so the answer is the seed —
    // which is exactly what that chat's first turn will record.
    dbGetConversationInferenceTier.mockResolvedValue(null)
    await expect(actions.getConversationTier('never-persisted')).resolves.toMatchObject({
      tier: 'anthropic',
    })
  })

  it('reads under the SESSION’s user, never a supplied one', async () => {
    isBypassEnabled.mockReturnValue(false)
    await actions.getConversationTier('c1')
    expect(dbGetConversationInferenceTier).toHaveBeenCalledWith('c1', 'entra-user')
    expect(getStoredInferenceTier).toHaveBeenCalledWith('entra-user')
  })

  it('tells the switch to disable the private position on an unconfigured deployment', async () => {
    verdaConfigured.mockReturnValue(false)
    await expect(actions.getConversationTier('c1')).resolves.toMatchObject({
      verdaAvailable: false,
    })
  })

  it('writes against the session’s user, and takes no owner argument', async () => {
    await expect(actions.setConversationTier('c1', 'verda')).resolves.toEqual({
      tier: 'verda',
      verdaAvailable: true,
    })
    expect(chooseConversationTier).toHaveBeenCalledWith('c1', 'bypass-user', 'verda')
    // Two arguments — the conversation and the tier. A third for the owner would
    // let the caller choose whose conversation to re-route.
    expect(actions.setConversationTier.length).toBe(2)
  })

  it('refuses an unauthenticated caller before writing anything', async () => {
    isBypassEnabled.mockReturnValue(false)
    getAuthenticatedUser.mockRejectedValueOnce(new Error('Authentication required'))

    await expect(actions.setConversationTier('c1', 'verda')).rejects.toThrow(
      'Authentication required',
    )
    expect(chooseConversationTier).not.toHaveBeenCalled()
  })

  it('reports the refusal rather than settling the switch on a tier it did not get', async () => {
    // The resolver refuses the private position on a deployment with no
    // endpoint. A switch that swallowed that would show one tier while the next
    // turn ran on another, which is worse than no switch at all.
    chooseConversationTier.mockRejectedValueOnce(
      new Error('The self-hosted inference endpoint is not configured on this deployment'),
    )
    await expect(actions.setConversationTier('c1', 'verda')).rejects.toThrow(
      /not configured on this deployment/,
    )
  })
})

describe('setConversationPinned (server action)', () => {
  it('scopes the write to the session user, who is never a parameter', async () => {
    isBypassEnabled.mockReturnValue(false)
    getAuthenticatedUser.mockResolvedValue({ id: 'entra-user', email: 'e@x.dev' })

    const result = await actions.setConversationPinned('c1', true)

    // The owner is resolved from the session, not taken from the caller — a
    // browser cannot ask to pin a row on someone else's behalf (SD-13).
    expect(dbSetConversationPinned).toHaveBeenCalledWith('c1', 'entra-user', true)
    expect(result).toEqual({ outcome: 'pinned', limit: 3 })
  })

  it('attributes the write to the bypass user in dev', async () => {
    isBypassEnabled.mockReturnValue(true)
    await actions.setConversationPinned('c1', false)
    expect(dbSetConversationPinned).toHaveBeenCalledWith('c1', 'bypass-user', false)
  })

  it('returns a refusal as a value, with the cap the server applied', async () => {
    dbSetConversationPinned.mockResolvedValueOnce('cap_reached')
    // A refused pin is a normal answer the sidebar renders as a hint, not an
    // exception the route has to catch.
    await expect(actions.setConversationPinned('c9', true)).resolves.toEqual({
      outcome: 'cap_reached',
      limit: 3,
    })
  })

  it('refuses an unauthenticated caller rather than pinning anything', async () => {
    isBypassEnabled.mockReturnValue(false)
    getAuthenticatedUser.mockRejectedValueOnce(new Error('no session'))
    await expect(actions.setConversationPinned('c1', true)).rejects.toThrow('no session')
    expect(dbSetConversationPinned).not.toHaveBeenCalled()
  })
})
