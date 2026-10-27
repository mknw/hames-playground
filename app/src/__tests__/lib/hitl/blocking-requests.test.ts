/**
 * The owner-gated read the blocking dialog renders (decision-loop-agent slice
 * 9): `listBlockingRequests` and `listBlockingInbox` in `actions.server.ts`,
 * over `listBlockingRequestViews`. The SD-13 gate itself is `actions.test.ts`'s
 * source-scan pin, which counts these exports too.
 *
 * Each pin names the source mutation that turns it red; each was run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

const getAuthenticatedUser = vi.fn<() => Promise<{ id: string; email: string }>>()
vi.mock('../../../lib/auth/server', () => ({ getAuthenticatedUser: () => getAuthenticatedUser() }))
vi.mock('../../../lib/auth/dev-bypass', () => ({
  isBypassEnabled: () => false,
  BYPASS_USER: { id: 'dev-bypass-user', email: 'dev@local' },
}))

const getHitlPayload = vi.fn()
const loadHitlAnswerRows = vi.fn(async () => [] as unknown[])
vi.mock('../../../lib/db/hitl.server', () => ({
  getHitlPayload: (...a: unknown[]) => getHitlPayload(...a) as unknown,
  loadHitlAnswerRows: (...a: unknown[]) => loadHitlAnswerRows(...(a as [])),
  isAnswerShape: () => true,
  recordHitlAnswer: vi.fn(),
}))
const loadSession = vi.fn<(s: string, u: string) => Promise<Record<string, unknown> | null>>()
vi.mock('../../../lib/harness-client/session.server', () => ({
  loadSession: (s: string, u: string) => loadSession(s, u),
}))
const listConversations = vi.fn()
vi.mock('../../../lib/db/conversations.server', () => ({
  listConversations: (u: string) => listConversations(u) as unknown,
}))

const { listBlockingRequests, listBlockingInbox } = await import('../../../lib/hitl/actions.server')

function blob(status: string, payloadRef?: string): string {
  return JSON.stringify({
    sessionId: 's1',
    status,
    input: 'do it',
    data: {},
    events: [
      { id: 'u1', type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'do it' } },
      {
        id: 'e2',
        type: 'hitl_request',
        ts: 2,
        patternId: 'p',
        data: {
          v: 1,
          requestId: '00000000-0000-4000-8000-000000000001',
          runId: 'u1',
          key: 'graph-write:k',
          kind: 'graph-write',
          question: 'Change it?',
          options: [
            { id: 'approve', label: 'Approve', tone: 'danger' },
            { id: 'reject', label: 'Reject', unattended: true },
          ],
          defaultOption: 'reject',
          unattended: 'apply-default',
          summary: { n: 1 },
          blocking: true,
          ...(payloadRef ? { payloadRef } : {}),
        },
      },
    ],
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  getAuthenticatedUser.mockResolvedValue({ id: 'alice', email: 'a@example.com' })
})

describe('listBlockingRequests', () => {
  it('refuses an unauthenticated caller before any resource is opened', async () => {
    getAuthenticatedUser.mockRejectedValue(new Error('unauthenticated'))
    await expect(listBlockingRequests('s1')).rejects.toThrow('unauthenticated')
    expect(loadSession).not.toHaveBeenCalled()
  })

  // MUTATION: read the payload under any id but the session's (or with no
  // owner) → another user's held payload could be served → red.
  it("reads the conversation and each held payload as the session's own user", async () => {
    loadSession.mockResolvedValue({ serializedContext: blob('paused', 'ref-1') })
    getHitlPayload.mockResolvedValue({ payload: { url: 'https://a.example' } })
    const views = await listBlockingRequests('s1')
    expect(loadSession).toHaveBeenCalledWith('s1', 'alice')
    expect(getHitlPayload).toHaveBeenCalledWith('ref-1', 'alice')
    expect(views).toEqual([
      expect.objectContaining({
        requestId: '00000000-0000-4000-8000-000000000001',
        defaultOption: 'reject',
        options: [
          { id: 'approve', label: 'Approve', tone: 'danger' },
          { id: 'reject', label: 'Reject' },
        ],
        payload: { url: 'https://a.example' },
        recorded: null,
      }),
    ])
  })

  // MUTATION: list pending requests whatever the run's status → a finished
  // run's old request is offered for an answer → red.
  it('offers nothing for a conversation that is not paused', async () => {
    loadSession.mockResolvedValue({ serializedContext: blob('done', 'ref-1') })
    expect(await listBlockingRequests('s1')).toEqual([])
    expect(getHitlPayload).not.toHaveBeenCalled()
  })

  it('a payload that is gone reads as null, and a request with none carries no payload field', async () => {
    loadSession.mockResolvedValue({ serializedContext: blob('paused', 'ref-gone') })
    getHitlPayload.mockResolvedValue(null)
    expect((await listBlockingRequests('s1'))[0].payload).toBeNull()
    loadSession.mockResolvedValue({ serializedContext: blob('paused') })
    expect('payload' in (await listBlockingRequests('s1'))[0]).toBe(false)
  })

  it("someone else's (or an unknown) conversation is an empty list", async () => {
    loadSession.mockResolvedValue(null)
    expect(await listBlockingRequests('s9')).toEqual([])
  })
})

describe('listBlockingInbox', () => {
  // MUTATION: drop the status filter → every conversation is "waiting" → red.
  it('lists only the caller’s paused conversations', async () => {
    listConversations.mockResolvedValue([
      { id: 'a', title: 'A', status: 'paused' },
      { id: 'b', title: 'B', status: 'done' },
    ])
    expect(await listBlockingInbox()).toEqual([{ sessionId: 'a', title: 'A' }])
    expect(listConversations).toHaveBeenCalledWith('alice')
  })
})
