/**
 * POST /api/events — the SSE envelope around a harness turn.
 *
 * The turn itself is `runTurnAndPersist` and is mocked here (its own recipe is
 * pinned by `lib/harness-client/turn.test.ts`); what this pins is the wire
 * contract the client parses, and that the route hands the turn the hooks that
 * produce it: one `data:` frame per harness event (each stamped with the
 * sessionId it belongs to, #47), a `done` frame carrying the result, an optional
 * `title_updated` frame, a close, and an `error` frame instead of a crash.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

type TurnHooks = {
  onEvent?: (evt: Record<string, unknown>) => void
  onResult?: (result: Record<string, unknown>) => void
  onTitle?: (title: string) => void
  onSettled?: () => void
}
type TurnRequest = Record<string, unknown> & TurnHooks

/** Stands in for the real driver: emits two events, then the result, an
 *  optional title, and settles — the same order `runTurnAndPersist` uses. */
const runTurnAndPersist = vi.fn<(req: TurnRequest) => Promise<Record<string, unknown>>>()
vi.mock('../../../lib/harness-client/turn.server', () => ({
  runTurnAndPersist: (req: TurnRequest) => runTurnAndPersist(req),
}))

const getAuthenticatedUser = vi.fn<() => Promise<{ id: string }>>()
vi.mock('../../../lib/auth/server', () => ({ getAuthenticatedUser }))
let bypass = false
vi.mock('../../../lib/auth/dev-bypass', () => ({
  isBypassEnabled: () => bypass,
  BYPASS_USER: { id: 'dev-bypass-user', email: 'dev@local' },
}))

const { POST } = await import('../../../routes/api/events')
const { DEFAULT_SETTINGS } = await import('../../../lib/settings')

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

let title: string | null = null

beforeEach(() => {
  vi.clearAllMocks()
  bypass = false
  title = null
  getAuthenticatedUser.mockResolvedValue({ id: 'user-1' })
  runTurnAndPersist.mockImplementation(async (req) => {
    req.onEvent?.({ type: 'tool_call', ts: 1 })
    req.onEvent?.({ type: 'tool_result', ts: 2 })
    req.onResult?.(RESULT)
    if (title) req.onTitle?.(title)
    req.onSettled?.()
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
    expect(runTurnAndPersist).not.toHaveBeenCalled()
  })

  it('401s without a session, and never starts the turn', async () => {
    getAuthenticatedUser.mockRejectedValue(new Error('Authentication required'))
    const res = await POST(evt({ sessionId: 's1', message: 'hi' }))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Authentication required' })
    expect(runTurnAndPersist).not.toHaveBeenCalled()
  })

  it('runs the turn as the bypass user when dev-bypass is on', async () => {
    bypass = true
    await POST(evt({ sessionId: 's1', message: 'hi' })).then((r) => r.text())
    expect(getAuthenticatedUser).not.toHaveBeenCalled()
    expect(runTurnAndPersist.mock.calls[0][0]).toMatchObject({ userId: 'dev-bypass-user' })
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
  })

  it('drives one interactive turn, with the caller-supplied settings', async () => {
    await POST(
      evt({ sessionId: 's1', message: 'hi', agentId: 'neo4j', settings: { maxToolTurns: 3 } }),
    ).then((r) => r.text())

    expect(runTurnAndPersist).toHaveBeenCalledTimes(1)
    expect(runTurnAndPersist.mock.calls[0][0]).toMatchObject({
      mode: 'interactive',
      sessionId: 's1',
      userId: 'user-1',
      agentId: 'neo4j',
      message: 'hi',
      settings: { maxToolTurns: 3 },
    })
  })

  // `settings` is request-body data that every pattern reads at execution time,
  // so the route clamps it rather than forwarding it. See
  // `sanitizeHarnessSettings`.
  describe('caller-supplied settings are not trusted', () => {
    it('clamps a loop bound to the settings panel’s own ceiling', async () => {
      await POST(evt({ sessionId: 's1', message: 'hi', settings: { maxToolTurns: 100_000 } })).then(
        (r) => r.text(),
      )
      expect(runTurnAndPersist.mock.calls[0][0].settings).toMatchObject({ maxToolTurns: 15 })
    })

    it('discards a caller-chosen sandbox policy, egress included', async () => {
      await POST(
        evt({
          sessionId: 's1',
          message: 'hi',
          settings: { sandbox: { defaultEgress: 'open', defaultMemoryMB: 64_000 } },
        }),
      ).then((r) => r.text())
      expect(runTurnAndPersist.mock.calls[0][0].settings).toMatchObject({
        sandbox: DEFAULT_SETTINGS.sandbox,
      })
    })

    it('falls back to the default for a non-numeric bound rather than propagating it', async () => {
      await POST(evt({ sessionId: 's1', message: 'hi', settings: { maxToolTurns: 'lots' } })).then(
        (r) => r.text(),
      )
      expect(runTurnAndPersist.mock.calls[0][0].settings).toMatchObject({
        maxToolTurns: DEFAULT_SETTINGS.maxToolTurns,
      })
    })
  })

  it('defaults the agent to "search" when none is named', async () => {
    await POST(evt({ sessionId: 's1', message: 'hi' })).then((r) => r.text())
    expect(runTurnAndPersist.mock.calls[0][0]).toMatchObject({ agentId: 'search' })
  })

  it('emits title_updated when the turn generates one', async () => {
    title = 'Quarterly numbers'
    const parsed = await frames(await POST(evt({ sessionId: 's1', message: 'hi' })))

    expect(parsed.at(-1)).toEqual({
      event: 'title_updated',
      data: { sessionId: 's1', title: 'Quarterly numbers' },
    })
  })

  it('closes the stream from onSettled, so nothing after it can reach the client', async () => {
    // The turn's trailing summarization runs after this point; the response is
    // already complete by then.
    let closedBeforeReturn = false
    runTurnAndPersist.mockImplementation(async (req) => {
      req.onResult?.(RESULT)
      req.onSettled?.()
      closedBeforeReturn = true
      return RESULT
    })

    const parsed = await frames(await POST(evt({ sessionId: 's1', message: 'hi' })))
    expect(parsed.map((f) => f.event)).toEqual(['done'])
    expect(closedBeforeReturn).toBe(true)
  })

  it('emits an error frame — not a rejected response — when the turn throws', async () => {
    runTurnAndPersist.mockRejectedValue(new Error('gateway unreachable'))
    const res = await POST(evt({ sessionId: 's1', message: 'hi' }))

    expect(res.status).toBe(200)
    expect(await frames(res)).toEqual([
      { event: 'error', data: { sessionId: 's1', error: 'gateway unreachable' } },
    ])
  })
})
