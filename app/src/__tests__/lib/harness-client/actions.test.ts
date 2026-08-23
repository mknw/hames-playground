/**
 * Server actions (`lib/harness-client/actions.server.ts`).
 *
 * Everything below the actions — the harness itself, the pattern cache, the
 * Postgres layer and auth — is mocked; what is asserted is the behaviour the
 * actions themselves own:
 *   - who the run is attributed to (bypass vs. Entra), and that the request
 *     scope is actually visible to the patterns that run inside it,
 *   - the new-conversation pre-seed (#105) and the continue-vs-fresh decision
 *     when the agent changes mid-conversation,
 *   - the sidebar surface: listing, bulk delete, load, title regeneration.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

// ── harness-patterns: a fake harness whose runs are observable ──────────────
import {
  getRequestUserId,
  getRequestSessionId,
} from '../../../lib/harness-client/request-user.server'

/** Every fresh/continued run records the request scope it saw. */
const seenScopes: Array<{ userId: string | null; sessionId: string | null }> = []

const runFresh = vi.fn(async (message: string, sessionId: string) => {
  seenScopes.push({ userId: getRequestUserId(), sessionId: getRequestSessionId() })
  return { response: `fresh:${message}`, serialized: `serialized:${sessionId}`, data: {} }
})
const harness = vi.fn(() => runFresh)
const continueSession = vi.fn(async (serialized: string, _p: unknown, message: string) => {
  seenScopes.push({ userId: getRequestUserId(), sessionId: getRequestSessionId() })
  return { response: `continued:${message}`, serialized: `${serialized}+${message}`, data: {} }
})
const resumeHarness = vi.fn(async (_s: string, _p: unknown, approved: boolean) => ({
  response: approved ? 'approved' : 'rejected',
  serialized: `resumed:${approved}`,
  data: {},
}))
const createContext = vi.fn((message: string, _data: unknown, sessionId: string) => ({
  sessionId,
  events: [{ type: 'user_message', data: { content: message } }],
}))
const serializeContext = vi.fn((ctx: unknown) => JSON.stringify(ctx))
const deserializeContext = vi.fn((s: string) => JSON.parse(s))

vi.mock('../../../lib/harness-patterns', () => ({
  harness,
  continueSession,
  resumeHarness,
  createContext,
  serializeContext,
  deserializeContext,
}))

// ── session.server (pattern cache + persistence) ────────────────────────────
type Loaded = { serializedContext: string; agentId: string; kind: string; status: string } | null

const loadSession = vi.fn<(id: string, userId: string) => Promise<Loaded>>(async () => null)
const saveSession = vi.fn(async () => {})
const deleteSession = vi.fn(async () => {})
const evictPatterns = vi.fn()
const getOrBuildPatterns = vi.fn(async (_s: string, agentId: string) => [`patterns:${agentId}`])
vi.mock('../../../lib/harness-client/session.server', () => ({
  loadSession,
  saveSession,
  deleteSession,
  evictPatterns,
  getOrBuildPatterns,
}))

// ── registry ────────────────────────────────────────────────────────────────
const AGENTS: Record<string, { icon: string; accent: string }> = {
  search: { icon: 'i-material-symbols-robot-2-outline', accent: 'cyan' },
}
const getAgent = vi.fn((id: string) => AGENTS[id])
const getAgentMetadata = vi.fn(() => [
  {
    id: 'search',
    name: 'Default',
    description: 'd',
    icon: 'i-x',
    accent: 'cyan',
    servers: ['neo4j'],
  },
])
vi.mock('../../../lib/harness-client/registry.server', () => ({ getAgent, getAgentMetadata }))

// ── db/conversations ────────────────────────────────────────────────────────
const dbListConversations = vi.fn(async () => [] as Array<Record<string, unknown>>)
const dbPromoteConversation = vi.fn<(id: string, userId: string) => Promise<void>>(async () => {})
const dbSaveConversation = vi.fn<(row: Record<string, unknown>) => Promise<void>>(async () => {})
const dbDeleteConversations = vi.fn(async (ids: string[]) => ids)
const dbSetConversationStatus = vi.fn<
  (id: string, userId: string, status: string) => Promise<void>
>(async () => {})
vi.mock('../../../lib/db/conversations.server', () => ({
  listConversations: dbListConversations,
  promoteConversation: dbPromoteConversation,
  saveConversation: dbSaveConversation,
  deleteConversations: dbDeleteConversations,
  setConversationStatus: dbSetConversationStatus,
  deriveTitle: (s: string) => s.slice(0, 10),
}))

// ── auth ────────────────────────────────────────────────────────────────────
const isBypassEnabled = vi.fn(() => true)
const getAuthenticatedUser = vi.fn(async () => ({ id: 'entra-user', email: 'e@x.dev' }))
vi.mock('../../../lib/auth/dev-bypass', () => ({
  isBypassEnabled,
  BYPASS_USER: { id: 'bypass-user', email: 'dev@local' },
}))
vi.mock('../../../lib/auth/server', () => ({ getAuthenticatedUser }))

// ── settings scope ──────────────────────────────────────────────────────────
const runWithSettings = vi.fn(<T>(_s: unknown, fn: () => Promise<T>) => fn())
vi.mock('../../../lib/settings-context.server', () => ({ runWithSettings }))

// ── title generator (dynamically imported by the action) ────────────────────
const runRegenerateTitle = vi.fn(async () => 'A better title')
vi.mock('../../../lib/harness-client/agents/title-generator.server', () => ({
  runRegenerateTitle,
}))

const actions = await import('../../../lib/harness-client/actions.server')

beforeEach(() => {
  vi.clearAllMocks()
  seenScopes.length = 0
  isBypassEnabled.mockReturnValue(true)
  loadSession.mockResolvedValue(null)
  dbDeleteConversations.mockImplementation(async (ids: string[]) => ids)
})

describe('processMessage / runTurn', () => {
  it('runs a brand-new conversation fresh and pre-seeds its sidebar row (#105)', async () => {
    const result = await actions.processMessage('sess-1', 'hello world, this is long')

    // Row exists before the run so an in-flight new chat is visible.
    expect(dbSaveConversation).toHaveBeenCalledTimes(1)
    const seeded = dbSaveConversation.mock.calls[0][0]
    expect(seeded).toMatchObject({
      id: 'sess-1',
      userId: 'bypass-user',
      agentId: 'search',
      status: 'running',
    })
    expect(seeded.title).toBe('hello worl')
    expect(dbSaveConversation.mock.invocationCallOrder[0]).toBeLessThan(
      runFresh.mock.invocationCallOrder[0],
    )

    expect(continueSession).not.toHaveBeenCalled()
    expect(result.response).toBe('fresh:hello world, this is long')
    expect(saveSession).toHaveBeenCalledWith('sess-1', 'bypass-user', 'search', 'serialized:sess-1')
  })

  // sf-M2. The pre-seeded row above is written with status='running'; the
  // TRIGGERED path (`action-runner.server.ts`) already flips it to 'error' when
  // its run throws, but the interactive path did not, so a pattern-build
  // failure left a sidebar row spinning for the life of the conversation.
  describe('a throw does not leave the row spinning forever (sf-M2)', () => {
    it('flips the row to error and rethrows when pattern construction fails', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      getOrBuildPatterns.mockRejectedValueOnce(new Error('gateway unreachable'))

      await expect(actions.processMessage('sess-boom', 'do a thing')).rejects.toThrow(
        'gateway unreachable',
      )

      expect(dbSetConversationStatus).toHaveBeenCalledWith('sess-boom', 'bypass-user', 'error')
      err.mockRestore()
    })

    it('flips the row to error when the final persist fails', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      saveSession.mockRejectedValueOnce(new Error('postgres down'))

      await expect(actions.processMessage('sess-save', 'do a thing')).rejects.toThrow(
        'postgres down',
      )

      expect(dbSetConversationStatus).toHaveBeenCalledWith('sess-save', 'bypass-user', 'error')
      err.mockRestore()
    })

    it('reports a status flip that itself failed, instead of swallowing it', async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      getOrBuildPatterns.mockRejectedValueOnce(new Error('gateway unreachable'))
      dbSetConversationStatus.mockRejectedValueOnce(new Error('postgres down too'))

      // The original failure is still what the caller sees…
      await expect(actions.processMessage('sess-both', 'do a thing')).rejects.toThrow(
        'gateway unreachable',
      )
      // …and the fact that the row is now stuck is on the record.
      expect(err).toHaveBeenCalledWith(expect.stringContaining('keep showing'), expect.anything())
      err.mockRestore()
    })

    it('leaves the row alone on a successful turn', async () => {
      await actions.processMessage('sess-ok', 'do a thing')
      expect(dbSetConversationStatus).not.toHaveBeenCalled()
    })
  })

  it('continues an existing conversation instead of re-running it fresh', async () => {
    loadSession.mockResolvedValue({
      serializedContext: 'ctx-a',
      agentId: 'search',
      kind: 'conversation',
      status: 'done',
    })

    const result = await actions.processMessageWithAgent('sess-2', 'follow up', 'search')

    expect(dbSaveConversation).not.toHaveBeenCalled() // no re-seed for a known row
    expect(harness).not.toHaveBeenCalled()
    expect(continueSession).toHaveBeenCalledWith(
      'ctx-a',
      ['patterns:search'],
      'follow up',
      undefined,
    )
    expect(result.response).toBe('continued:follow up')
    expect(saveSession).toHaveBeenCalledWith('sess-2', 'bypass-user', 'search', 'ctx-a+follow up')
  })

  it('starts fresh when the agent changed under an existing sessionId', async () => {
    loadSession.mockResolvedValue({
      serializedContext: 'ctx-a',
      agentId: 'search',
      kind: 'conversation',
      status: 'done',
    })

    const result = await actions.processMessageWithAgent('sess-3', 'hi', 'general')

    expect(continueSession).not.toHaveBeenCalled()
    expect(getOrBuildPatterns).toHaveBeenCalledWith('sess-3', 'general')
    expect(result.response).toBe('fresh:hi')
    expect(saveSession).toHaveBeenCalledWith(
      'sess-3',
      'bypass-user',
      'general',
      'serialized:sess-3',
    )
  })

  it('exposes the user + conversation to the patterns as ambient request scope', async () => {
    await actions.processMessage('sess-4', 'scope check')
    expect(seenScopes).toEqual([{ userId: 'bypass-user', sessionId: 'sess-4' }])
  })

  it('attributes the run to the Entra user when the dev bypass is off', async () => {
    isBypassEnabled.mockReturnValue(false)
    await actions.processMessage('sess-5', 'who am i')
    expect(seenScopes).toEqual([{ userId: 'entra-user', sessionId: 'sess-5' }])
    expect(saveSession).toHaveBeenCalledWith('sess-5', 'entra-user', 'search', 'serialized:sess-5')
  })

  it('streams events and runs the turn under the caller-supplied settings', async () => {
    const onEvent = vi.fn()
    const settings = { maxTurns: 3 } as never
    loadSession.mockResolvedValue({
      serializedContext: 'ctx-a',
      agentId: 'search',
      kind: 'conversation',
      status: 'done',
    })

    await actions.processMessageStreaming('sess-6', 'stream me', 'search', onEvent, settings)

    expect(runWithSettings).toHaveBeenCalledWith(settings, expect.any(Function))
    expect(continueSession).toHaveBeenCalledWith('ctx-a', ['patterns:search'], 'stream me', onEvent)
  })
})

describe('approval gate', () => {
  it('resumes the stored context as approved', async () => {
    loadSession.mockResolvedValue({
      serializedContext: 'ctx-p',
      agentId: 'general',
      kind: 'conversation',
      status: 'paused',
    })
    const result = await actions.approveAction('sess-7')
    expect(resumeHarness).toHaveBeenCalledWith('ctx-p', ['patterns:general'], true)
    expect(result.response).toBe('approved')
    expect(saveSession).toHaveBeenCalledWith('sess-7', 'bypass-user', 'general', 'resumed:true')
  })

  it('resumes as rejected, ignoring the (unused) reason', async () => {
    loadSession.mockResolvedValue({
      serializedContext: 'ctx-p',
      agentId: 'general',
      kind: 'conversation',
      status: 'paused',
    })
    const result = await actions.rejectAction('sess-8', 'too risky')
    expect(resumeHarness).toHaveBeenCalledWith('ctx-p', ['patterns:general'], false)
    expect(result.response).toBe('rejected')
  })

  it('refuses to resume a conversation the user does not own', async () => {
    loadSession.mockResolvedValue(null)
    await expect(actions.approveAction('sess-9')).rejects.toThrow('No active session')
    expect(resumeHarness).not.toHaveBeenCalled()
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
      agentIcon: 'i-material-symbols-robot-2-outline',
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
