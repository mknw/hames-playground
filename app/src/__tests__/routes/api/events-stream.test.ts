/**
 * POST /api/events — the SSE envelope around a harness turn.
 *
 * The turn itself is mocked; what this pins is the wire contract the client
 * parses: one `data:` frame per harness event (each stamped with the sessionId
 * it belongs to, #47), a `done` frame carrying the result, an optional
 * `title_updated` frame, and an `error` frame instead of a crash. Also the
 * post-stream background save, which runs after the response is complete and
 * is otherwise invisible.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

type EmitFn = (evt: Record<string, unknown>) => void
const processMessageStreaming =
  vi.fn<
    (
      sessionId: string,
      message: string,
      agentId: string,
      onEvent: EmitFn,
      settings?: unknown,
    ) => Promise<Record<string, unknown>>
  >()
vi.mock('../../../lib/harness-client/actions.server', () => ({
  processMessageStreaming: (...a: unknown[]) =>
    processMessageStreaming(...(a as [never, never, never, never, never])),
}))

const saveSession = vi.fn<
  (sessionId: string, userId: string, agentId: string, serialized: unknown) => Promise<void>
>(async () => {})
vi.mock('../../../lib/harness-client/session.server', () => ({
  saveSession: (sessionId: string, userId: string, agentId: string, serialized: unknown) =>
    saveSession(sessionId, userId, agentId, serialized),
}))

const compactBulkData = vi.fn(async (_ctx: unknown, persist: () => Promise<void>) => {
  await persist()
})
vi.mock('../../../lib/harness-patterns', () => ({
  compactBulkData: (...a: unknown[]) => compactBulkData(...(a as [unknown, () => Promise<void>])),
  serializeContext: (ctx: unknown) => ({ serialized: ctx }),
}))

const runFirstTurnTitleGen = vi.fn<() => Promise<string | null>>(async () => null)
vi.mock('../../../lib/harness-client/agents/title-generator.server', () => ({
  runFirstTurnTitleGen: (...a: unknown[]) => runFirstTurnTitleGen(...(a as [])),
}))

const getAuthenticatedUser = vi.fn<() => Promise<{ id: string }>>()
vi.mock('../../../lib/auth/server', () => ({ getAuthenticatedUser }))
let bypass = false
vi.mock('../../../lib/auth/dev-bypass', () => ({
  isBypassEnabled: () => bypass,
  BYPASS_USER: { id: 'dev-bypass-user', email: 'dev@local' },
}))

const { POST } = await import('../../../routes/api/events')

function evt(body: unknown) {
  return {
    params: {},
    request: new Request('http://x/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  } as never
}

/** Split an SSE body into `{ event, data }` frames. */
async function frames(
  res: Response,
): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const text = await res.text()
  return text
    .split('\n\n')
    .filter((block) => block.trim())
    .map((block) => {
      const lines = block.split('\n')
      const name = lines.find((l) => l.startsWith('event: '))?.slice(7) ?? 'message'
      const data = lines.find((l) => l.startsWith('data: '))!.slice(6)
      return { event: name, data: JSON.parse(data) as Record<string, unknown> }
    })
}

const RESULT = {
  response: 'the answer',
  data: { rows: 1 },
  status: 'running',
  duration_ms: 42,
  context: { id: 'ctx' },
  serialized: 'serialized-blob',
}

beforeEach(() => {
  vi.clearAllMocks()
  bypass = false
  getAuthenticatedUser.mockResolvedValue({ id: 'user-1' })
  runFirstTurnTitleGen.mockResolvedValue(null)
  processMessageStreaming.mockImplementation(async (_sid, _msg, _agent, onEvent) => {
    onEvent({ type: 'tool_call', ts: 1 })
    onEvent({ type: 'tool_result', ts: 2 })
    return RESULT
  })
})

describe('POST /api/events', () => {
  it('400s without a sessionId or message, before authenticating', async () => {
    const res = await POST(evt({ message: 'hi' }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/required/)
    expect(getAuthenticatedUser).not.toHaveBeenCalled()

    expect((await POST(evt({ sessionId: 's1' }))).status).toBe(400)
    expect(processMessageStreaming).not.toHaveBeenCalled()
  })

  it('401s without a session, and never starts the harness', async () => {
    getAuthenticatedUser.mockRejectedValue(new Error('Authentication required'))
    const res = await POST(evt({ sessionId: 's1', message: 'hi' }))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Authentication required' })
    expect(processMessageStreaming).not.toHaveBeenCalled()
  })

  it('runs as the bypass user when dev-bypass is on', async () => {
    bypass = true
    await POST(evt({ sessionId: 's1', message: 'hi' })).then((r) => r.text())
    expect(getAuthenticatedUser).not.toHaveBeenCalled()
    expect(saveSession).toHaveBeenCalledWith('s1', 'dev-bypass-user', 'search', expect.anything())
  })

  it('streams each harness event, stamped with the sessionId, then a done frame', async () => {
    const res = await POST(evt({ sessionId: 's1', message: 'hi', settings: { maxTurns: 3 } }))

    expect(res.headers.get('Content-Type')).toBe('text/event-stream')
    expect(res.headers.get('Cache-Control')).toBe('no-cache')

    const parsed = await frames(res)
    expect(parsed.map((f) => f.event)).toEqual(['message', 'message', 'done'])
    // Events don't carry a sessionId in their own shape — the envelope adds it.
    expect(parsed[0].data).toEqual({ type: 'tool_call', ts: 1, sessionId: 's1' })
    expect(parsed[2].data).toMatchObject({
      sessionId: 's1',
      response: 'the answer',
      status: 'running',
      duration_ms: 42,
      serialized: 'serialized-blob',
    })
    expect(processMessageStreaming.mock.calls[0][4]).toEqual({ maxTurns: 3 })
  })

  it('defaults the agent to "search" when none is named', async () => {
    await POST(evt({ sessionId: 's1', message: 'hi' })).then((r) => r.text())
    expect(processMessageStreaming.mock.calls[0][2]).toBe('search')

    await POST(evt({ sessionId: 's1', message: 'hi', agentId: 'neo4j' })).then((r) => r.text())
    expect(processMessageStreaming.mock.calls[1][2]).toBe('neo4j')
  })

  it('emits title_updated when the title generator resolves one', async () => {
    runFirstTurnTitleGen.mockResolvedValue('Quarterly numbers')
    const parsed = await frames(await POST(evt({ sessionId: 's1', message: 'hi' })))

    expect(parsed.at(-1)).toEqual({
      event: 'title_updated',
      data: { sessionId: 's1', title: 'Quarterly numbers' },
    })
  })

  it('closes cleanly when title generation fails — the heuristic title stands', async () => {
    runFirstTurnTitleGen.mockRejectedValue(new Error('LLM down'))
    const parsed = await frames(await POST(evt({ sessionId: 's1', message: 'hi' })))

    expect(parsed.map((f) => f.event)).toEqual(['message', 'message', 'done'])
  })

  it('persists the summarized turn after the stream closes', async () => {
    await POST(evt({ sessionId: 's1', message: 'hi', agentId: 'neo4j' })).then((r) => r.text())

    expect(compactBulkData).toHaveBeenCalledTimes(1)
    expect(compactBulkData.mock.calls[0][0]).toEqual(RESULT.context)
    expect(saveSession).toHaveBeenCalledWith('s1', 'user-1', 'neo4j', {
      serialized: RESULT.context,
    })
  })

  it('runs the background compaction inside the request and settings scopes', async () => {
    // SA-M13: this call is deliberately made AFTER `controller.close()`, so it
    // inherits neither ALS scope the request handler opened. Without them
    // `getRequestSettings()` silently fell back to DEFAULT_SETTINGS and the
    // user's `maxResultForSummary` was ignored by every background summary.
    const { getRequestSettings } = await import('../../../lib/settings-context.server')
    const { getRequestUserId, getRequestSessionId } =
      await import('../../../lib/harness-client/request-user.server')

    const seen: { max?: number; userId?: string | null; sessionId?: string | null } = {}
    compactBulkData.mockImplementationOnce(async (_ctx, persist) => {
      seen.max = getRequestSettings().maxResultForSummary
      seen.userId = getRequestUserId()
      seen.sessionId = getRequestSessionId()
      await persist()
    })

    await POST(
      evt({ sessionId: 's1', message: 'hi', settings: { maxResultForSummary: 12_345 } }),
    ).then((r) => r.text())

    expect(seen.max).toBe(12_345)
    expect(seen.userId).toBe('user-1')
    expect(seen.sessionId).toBe('s1')
  })

  it('emits an error frame — not a rejected response — when the harness throws', async () => {
    processMessageStreaming.mockRejectedValue(new Error('gateway unreachable'))
    const res = await POST(evt({ sessionId: 's1', message: 'hi' }))

    expect(res.status).toBe(200)
    expect(await frames(res)).toEqual([
      { event: 'error', data: { sessionId: 's1', error: 'gateway unreachable' } },
    ])
    expect(saveSession).not.toHaveBeenCalled()
  })
})
