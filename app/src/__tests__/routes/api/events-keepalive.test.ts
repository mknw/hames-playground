/**
 * POST /api/events — the keep-alive under a silent turn.
 *
 * A turn can legitimately write NOTHING for many minutes: one call to the
 * self-hosted deployment blocks for its whole `request_timeout_ms` (600s), and
 * a cold start alone measured 146s on 2026-08-26. The stream used to send zero
 * bytes for that entire window, which is indistinguishable from a dead
 * connection — to a proxy with an idle read timeout (the preview runs behind
 * Caddy) and to the user, whose reload destroys the in-flight turn's only
 * record of itself.
 *
 * Two halves, and both matter: the route must WRITE something, and the client
 * parser must IGNORE it. A heartbeat that reached `ChatStreamEvent` consumers
 * would be worse than none.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

type TurnHooks = {
  onEvent?: (evt: Record<string, unknown>) => void
  onResult?: (result: Record<string, unknown>) => void
  onSettled?: () => void
}
type TurnRequest = Record<string, unknown> & TurnHooks

const runTurnAndPersist = vi.fn<(req: TurnRequest) => Promise<Record<string, unknown>>>()
vi.mock('../../../lib/harness-client/turn.server', () => ({
  runTurnAndPersist: (req: TurnRequest) => runTurnAndPersist(req),
}))

vi.mock('../../../lib/auth/server', () => ({ getAuthenticatedUser: vi.fn() }))
vi.mock('../../../lib/auth/dev-bypass', () => ({
  isBypassEnabled: () => true,
  BYPASS_USER: { id: 'dev-bypass-user', email: 'dev@local' },
}))

const { POST } = await import('../../../routes/api/events')
const { parseChatStream, SSE_KEEPALIVE_FRAME, SSE_KEEPALIVE_MS } =
  await import('../../../lib/sse-client')

function req() {
  return {
    params: {},
    request: new Request('http://x/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 's1', message: 'weather in Brussels today' }),
    }),
  } as never
}

/** Everything currently readable from the stream, without waiting for close. */
async function drain(res: Response): Promise<string> {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let text = ''
  // The stream stays open, so read only what is already queued: one read per
  // enqueued chunk, and stop as soon as a read would block.
  for (;;) {
    const next = await Promise.race([reader.read(), Promise.resolve().then(() => 'idle' as const)])
    if (next === 'idle' || next.done) break
    text += decoder.decode(next.value, { stream: true })
  }
  reader.releaseLock()
  return text
}

describe('the stream stays alive across a silent turn', () => {
  let settle: (() => void) | undefined

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    // A turn that emits nothing and never finishes on its own — the shape of a
    // controller call waiting out a cold start.
    runTurnAndPersist.mockImplementation(
      (r) =>
        new Promise((resolve) => {
          settle = () => {
            r.onSettled?.()
            resolve({})
          }
        }),
    )
  })

  afterEach(() => {
    vi.useRealTimers()
    settle = undefined
  })

  it('writes a comment frame per interval while nothing else happens', async () => {
    const res = await POST(req())
    expect(await drain(res)).toBe('')

    await vi.advanceTimersByTimeAsync(SSE_KEEPALIVE_MS * 2 + 1)

    const text = await drain(res)
    expect(text.split(SSE_KEEPALIVE_FRAME).length - 1).toBe(2)
  })

  it('stops writing once the turn settles, so nothing enqueues onto a closed stream', async () => {
    const res = await POST(req())
    await vi.advanceTimersByTimeAsync(SSE_KEEPALIVE_MS + 1)
    await drain(res)

    settle!()
    // An enqueue onto a closed controller throws `Invalid state: Controller is
    // already closed`, and a throw inside the interval callback surfaces here
    // — so this advance passing IS the assertion. Verified by mutation:
    // removing BOTH the `closed` guard and the `clearInterval` fails this test
    // with that TypeError. Removing either one alone does not, because either
    // one alone closes the hazard; they are deliberate belt-and-braces, since
    // the timer and the close are set up in different places.
    await vi.advanceTimersByTimeAsync(SSE_KEEPALIVE_MS * 3)

    const reader = res.body!.getReader()
    await expect(reader.read()).resolves.toMatchObject({ done: true })
  })
})

describe('the client parser ignores the heartbeat', () => {
  it('yields the data frames and nothing for the keep-alives', async () => {
    const body =
      SSE_KEEPALIVE_FRAME +
      `data: ${JSON.stringify({ id: 'ev-1', type: 'user_message' })}\n\n` +
      SSE_KEEPALIVE_FRAME +
      SSE_KEEPALIVE_FRAME +
      `event: done\ndata: ${JSON.stringify({ sessionId: 's1', response: 'hi' })}\n\n`

    const events = []
    for await (const e of parseChatStream(new Response(body))) events.push(e)

    expect(events.map((e) => e.event)).toEqual(['message', 'done'])
  })
})

describe('the route module exports only its handler', () => {
  it('declares no other export, because the build strips them', async () => {
    // The trap this pins, paid for once: `SSE_KEEPALIVE_MS` started life as a
    // `const` exported from the route. SolidStart's API-route transform keeps
    // only the HTTP-verb exports and drops everything else, so the built route
    // referenced a name that was no longer there and every POST answered 503
    // with `ReferenceError: SSE_KEEPALIVE_MS is not defined`. Typecheck, this
    // suite (which imports the module raw, untransformed) and `vinxi build` all
    // stayed green; only opening a real conversation showed it. The hazard is
    // general to `routes/api/**`; this pins the file that hit it.
    // `process.cwd()` is `app/` under vitest; `import.meta.url` is not a file
    // URL there.
    const source = await readFile(path.join(process.cwd(), 'src/routes/api/events.ts'), 'utf8')
    const exported = [...source.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map(
      (m) => m[1],
    )

    expect(exported).toEqual(['POST'])
  })
})
