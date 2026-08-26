/**
 * turn-stream — the streaming-turn state machine (#226 B2).
 *
 * The whole point of extracting it is that a turn can now be driven by a
 * scripted array of SSE frames with no component mounted and no DOM. These
 * tests do exactly that: they script the wire, record the sink, and assert the
 * state sequence and the effects, including the paths that used to be
 * reachable only through a rendered composer (a non-OK response, an `error`
 * frame, a torn-down stream, a paused write).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  runTurn,
  applyApprovalResult,
  IDLE_TURN,
  type TurnSink,
  type TurnState,
} from '~/lib/turn-stream'
import type { Message } from '~/components/ark-ui/ChatMessages'
import type { ContextEvent, UnifiedContext } from '~/lib/harness-patterns'
import type { GraphElement } from '~/lib/harness-client/types'
import type { WarmingEventData } from '~/lib/sse-client'
import type { HarnessSettings } from '~/lib/settings'
import singleNodeFixture from './harness-client/fixtures/cypher-single-node.json'

// ---------------------------------------------------------------------------
// Wire + sink doubles
// ---------------------------------------------------------------------------
type Frame = { event: string; data: unknown }

const sseResponse = (frames: Frame[], init: { ok?: boolean; status?: number } = {}) => {
  const text = frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('')
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
  return { ok: init.ok ?? true, status: init.status ?? 200, body } as unknown as Response
}

/**
 * A stream that delivers `frames` and then FAILS mid-iteration, which
 * `sseResponse` cannot express: it closes cleanly, so the loop is left
 * normally and the `catch` path is unreachable.
 *
 * The failure is raised from a LATER `pull` rather than beside the enqueue,
 * because `error()` discards whatever is still queued — enqueueing and erroring
 * in one go delivers no frames at all.
 */
const sseThenFailure = (frames: Frame[], error: unknown) => {
  const text = frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('')
  let sent = false
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent) return controller.error(error)
      sent = true
      controller.enqueue(new TextEncoder().encode(text))
    },
  })
  return { ok: true, status: 200, body } as unknown as Response
}

const recorder = () => {
  const messages: Message[] = []
  const events: ContextEvent[] = []
  const graph: GraphElement[] = []
  const contexts: UnifiedContext[] = []
  const states: TurnState[] = []
  const progress: ContextEvent[] = []
  const titles: Array<[string, string]> = []
  const warmings: Array<WarmingEventData | null> = []
  /** Interleaved log of the calls whose ORDER carries meaning — the notice has
   *  to come down before the answer is painted, not at the end of the turn, and
   *  nothing else in this recorder can tell those apart. */
  const order: string[] = []
  let started = 0
  let finished = 0

  const sink: TurnSink = {
    appendMessage: (m) => messages.push(m),
    pushEvents: (e) => events.push(...e),
    pushGraph: (g) => graph.push(...g),
    setContext: (c) => contexts.push(c),
    ingestProgress: (e) => {
      order.push('progress')
      return progress.push(e)
    },
    finishProgress: () => {
      order.push('finish')
      finished++
    },
    onWarming: (n) => {
      order.push(n ? 'warming:on' : 'warming:off')
      warmings.push(n)
    },
    onStarted: () => started++,
    onTitleUpdated: (sid, title) => titles.push([sid, title]),
    onState: (s) => states.push(s),
  }
  return {
    sink,
    messages,
    events,
    graph,
    contexts,
    states,
    progress,
    warmings,
    order,
    titles,
    get started() {
      return started
    },
    get finished() {
      return finished
    },
  }
}

const request = (over: Partial<Parameters<typeof runTurn>[0]> = {}) => ({
  sessionId: 's1',
  message: 'what nodes exist?',
  agentId: 'search',
  settings: { maxConcurrentRuns: 3 } as unknown as HarnessSettings,
  signal: new AbortController().signal,
  ...over,
})

const message = (data: unknown): Frame => ({ event: 'message', data })
const done = (over: Record<string, unknown> = {}): Frame => ({
  event: 'done',
  data: { status: 'done', response: 'Here is your answer.', context: { events: [] }, ...over },
})
const controllerAction = (action: Record<string, unknown>): Frame =>
  message({ type: 'controller_action', patternId: 'neo4j-query', ts: 1, data: { action } })
const toolResult = (result: unknown): Frame =>
  message({
    type: 'tool_result',
    patternId: 'neo4j-query',
    ts: 2,
    data: { tool: 'read_neo4j_cypher', result, success: true },
  })

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => sseResponse([done()]))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// ---------------------------------------------------------------------------

describe('runTurn — the request', () => {
  it('posts the message, agent and settings to /api/events under the run’s abort signal', async () => {
    const rec = recorder()
    const controller = new AbortController()
    await runTurn(request({ signal: controller.signal }), rec.sink)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('/api/events')
    expect(init.method).toBe('POST')
    expect(init.signal).toBe(controller.signal)
    expect(JSON.parse(init.body as string)).toEqual({
      sessionId: 's1',
      message: 'what nodes exist?',
      agentId: 'search',
      settings: { maxConcurrentRuns: 3 },
    })
  })

  it('announces the run once, on the first frame, however many follow', async () => {
    fetchMock.mockResolvedValue(sseResponse([controllerAction({ tool_name: 'a' }), done()]))
    const rec = recorder()
    await runTurn(request(), rec.sink)
    expect(rec.started).toBe(1)
  })

  it('announces nothing for a stream that closes without a single frame', async () => {
    fetchMock.mockResolvedValue(sseResponse([]))
    const rec = recorder()
    const result = await runTurn(request(), rec.sink)
    expect(rec.started).toBe(0)
    expect(result.state).toEqual({ status: 'done' })
  })
})

describe('runTurn — transitions', () => {
  it('opens in streaming with no tool named, and lands on done', async () => {
    const rec = recorder()
    const result = await runTurn(request(), rec.sink)

    expect(rec.states).toEqual([{ status: 'streaming', runningTool: null }, { status: 'done' }])
    expect(result).toEqual({ state: { status: 'done' }, outcome: 'done', aborted: false })
  })

  it('names the tool the controller is waiting on, and clears it on the final action', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        controllerAction({ tool_name: 'read_neo4j_cypher' }),
        controllerAction({ tool_name: 'Return', is_final: true }),
        done(),
      ]),
    )
    const rec = recorder()
    await runTurn(request(), rec.sink)

    expect(rec.states).toEqual([
      { status: 'streaming', runningTool: null },
      { status: 'streaming', runningTool: 'read_neo4j_cypher' },
      { status: 'streaming', runningTool: null },
      { status: 'done' },
    ])
  })

  it('names the batch size rather than one tool for a multi-call turn', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        controllerAction({
          tool_name: 'read_neo4j_cypher',
          additional_calls: [{ tool_name: 'get_schema' }, { tool_name: 'brave_web_search' }],
        }),
        done(),
      ]),
    )
    const rec = recorder()
    await runTurn(request(), rec.sink)
    expect(rec.states[1]).toEqual({ status: 'streaming', runningTool: '3 tools' })
  })

  it('ends in awaiting-approval when the run pauses on a write', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        done({
          status: 'paused',
          response: 'I need approval to write.',
          data: { pendingAction: { action: 'write_neo4j_cypher', reason: 'creates a node' } },
        }),
      ]),
    )
    const rec = recorder()
    const result = await runTurn(request(), rec.sink)

    expect(result.state).toEqual({
      status: 'awaiting-approval',
      tool: 'write_neo4j_cypher',
      reason: 'creates a node',
    })
    // A paused turn is not a failure — the thread mark says it landed.
    expect(result.outcome).toBe('done')
    expect(rec.messages.at(-1)?.toolCall).toEqual({
      type: 'neo4j',
      status: 'pending',
      tool: 'write_neo4j_cypher',
      explanation: 'creates a node',
      isReadOnly: false,
    })
  })

  it('exposes idle as the resting state a caller starts from', () => {
    expect(IDLE_TURN).toEqual({ status: 'idle' })
  })
})

describe('runTurn — effects', () => {
  it('feeds every message frame to progress and to the event buffer, in order', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([controllerAction({ tool_name: 'a' }), toolResult(singleNodeFixture), done()]),
    )
    const rec = recorder()
    await runTurn(request(), rec.sink)

    expect(rec.events.map((e) => e.type)).toEqual(['controller_action', 'tool_result'])
    expect(rec.progress.map((e) => e.type)).toEqual(['controller_action', 'tool_result'])
    // Graph elements come off tool results only.
    expect(rec.graph.map((e) => e.data?.id)).toEqual(['Redis'])
  })

  it('does not route unknown SSE event names into the event buffer', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([{ event: 'telemetry', data: { anything: true } }, done()]),
    )
    const rec = recorder()
    await runTurn(request(), rec.sink)
    expect(rec.events).toEqual([])
    // ...but the frame still counts as the stream having started.
    expect(rec.started).toBe(1)
  })

  it('forwards a title_updated frame with the session id it names, not the run’s', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        { event: 'title_updated', data: { sessionId: 'other', title: 'Node inventory' } },
        done(),
      ]),
    )
    const rec = recorder()
    await runTurn(request(), rec.sink)
    expect(rec.titles).toEqual([['other', 'Node inventory']])
  })

  it('paints a recoverable error event inline without ending the run', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        message({
          type: 'error',
          patternId: 'neo4j-query',
          ts: 1,
          data: {
            error: 'Page too large',
            hint: 'Retrying with a smaller page.',
            severity: 'recoverable',
            turn: 1,
          },
        }),
        done(),
      ]),
    )
    const rec = recorder()
    const result = await runTurn(request(), rec.sink)

    expect(rec.messages[0]).toMatchObject({
      role: 'warning',
      content: 'Page too large',
      hint: 'Retrying with a smaller page.',
      turnInfo: '(turn 2)',
      patternId: 'neo4j-query',
    })
    // Recoverable — the turn still completed and still painted the answer.
    expect(result.outcome).toBe('done')
    expect(rec.messages.at(-1)?.content).toBe('Here is your answer.')
  })

  it('publishes the final context and finishes the progress bar exactly once', async () => {
    const context = { events: [{ type: 'user_message', ts: 1 }] } as unknown as UnifiedContext
    fetchMock.mockResolvedValue(sseResponse([done({ context })]))
    const rec = recorder()
    await runTurn(request(), rec.sink)

    expect(rec.contexts).toEqual([context])
    expect(rec.finished).toBe(1)
  })

  it('does not paint an answer for a done frame with no response', async () => {
    fetchMock.mockResolvedValue(sseResponse([done({ response: '' })]))
    const rec = recorder()
    await runTurn(request(), rec.sink)
    expect(rec.messages).toEqual([])
  })
})

describe('runTurn — failure paths', () => {
  it('turns a non-OK response into an error state and a bubble', async () => {
    fetchMock.mockResolvedValue(sseResponse([], { ok: false, status: 503 }))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rec = recorder()
    const result = await runTurn(request(), rec.sink)

    expect(result).toEqual({
      state: { status: 'error', message: 'Server error: 503' },
      outcome: 'error',
      aborted: false,
    })
    expect(rec.messages).toEqual([
      expect.objectContaining({ role: 'error', content: 'Server error: 503' }),
    ])
    // The bar must not be left spinning on a failed run.
    expect(rec.finished).toBe(1)
    err.mockRestore()
  })

  it('turns an SSE error frame into an error state', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([{ event: 'error', data: { error: 'controller exploded' } }]),
    )
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rec = recorder()
    const result = await runTurn(request(), rec.sink)

    expect(result.state).toEqual({ status: 'error', message: 'controller exploded' })
    expect(result.outcome).toBe('error')
    err.mockRestore()
  })

  it('reports an errored done frame without painting its stale response as an answer', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([done({ status: 'error', response: 'partial garbage' })]),
    )
    const rec = recorder()
    const result = await runTurn(request(), rec.sink)

    expect(result.outcome).toBe('error')
    expect(result.state).toEqual({ status: 'error', message: 'partial garbage' })
    expect(rec.messages).toEqual([])
  })

  it('reports a torn-down stream as stopped, silently — the chain lives on server-side', async () => {
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'))
    const rec = recorder()
    const result = await runTurn(request(), rec.sink)

    expect(result).toEqual({ state: { status: 'stopped' }, outcome: 'done', aborted: true })
    // No bubble: whether that deserves one is the caller's call, not the turn's.
    expect(rec.messages).toEqual([])
    expect(rec.finished).toBe(1)
  })

  it('never throws — a failure is a state, not an exception for the caller to catch', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rec = recorder()
    await expect(runTurn(request(), rec.sink)).resolves.toMatchObject({ outcome: 'error' })
    expect(rec.messages[0]).toMatchObject({ role: 'error', content: 'offline' })
    err.mockRestore()
  })
})

describe('applyApprovalResult', () => {
  const context = (n: number): UnifiedContext =>
    ({
      events: Array.from({ length: n }, (_, i) => ({ type: 'tool_call', ts: i })),
    }) as unknown as UnifiedContext

  it('emits only the events added since the cursor, and returns the new one', async () => {
    const rec = recorder()
    const cursor = applyApprovalResult({ context: context(5) }, 3, rec.sink)

    expect(cursor).toBe(5)
    expect(rec.events.map((e) => e.ts)).toEqual([3, 4])
    expect(rec.contexts).toHaveLength(1)
  })

  it('emits nothing when the resumed run added no events', () => {
    const rec = recorder()
    expect(applyApprovalResult({ context: context(3) }, 3, rec.sink)).toBe(3)
    expect(rec.events).toEqual([])
  })

  it('leaves the cursor alone when the result carries no context at all', () => {
    const rec = recorder()
    expect(applyApprovalResult({}, 7, rec.sink)).toBe(7)
    expect(rec.contexts).toEqual([])
  })

  it('fans graph elements out through the same sink the streaming turn uses', () => {
    const rec = recorder()
    applyApprovalResult(
      {
        context: {
          events: [
            {
              type: 'tool_result',
              patternId: 'neo4j-query',
              ts: 1,
              data: { tool: 'read_neo4j_cypher', result: singleNodeFixture, success: true },
            },
          ],
        } as unknown as UnifiedContext,
      },
      0,
      rec.sink,
    )
    expect(rec.graph.map((e) => e.data?.id)).toEqual(['Redis'])
  })
})

// ---------------------------------------------------------------------------
// The cold-start notice (D-c)
// ---------------------------------------------------------------------------

/** A `warming` frame as the SSE route emits it. */
const warmingFrame = (over: Partial<WarmingEventData> = {}): Frame => ({
  event: 'warming',
  data: { sessionId: 's1', estimateMs: 146_000, basis: 'default', samples: 0, ...over },
})

describe('runTurn — the cold-start notice', () => {
  it('raises the notice when the server says the box is starting', async () => {
    const rec = recorder()
    fetchMock.mockResolvedValue(sseResponse([warmingFrame(), controllerAction({}), done()]))
    await runTurn(request(), rec.sink)

    expect(rec.warmings[0]).toMatchObject({ estimateMs: 146_000, basis: 'default', samples: 0 })
  })

  it('clears it on the next frame of ANY kind — that is what "first token" means here', async () => {
    // No dedicated clear frame exists on purpose: one more frame is one more
    // frame that can be dropped, and a dropped clear leaves a spinner up
    // forever. The next `message` is the box answering.
    //
    // The ORDER is the assertion, not the pair of calls: clearing only once the
    // turn ends would produce the same two calls while leaving a spinner up
    // across the whole answer.
    const rec = recorder()
    fetchMock.mockResolvedValue(sseResponse([warmingFrame(), controllerAction({}), done()]))
    await runTurn(request(), rec.sink)

    expect(rec.warmings).toEqual([expect.objectContaining({ estimateMs: 146_000 }), null])
    expect(rec.order).toEqual(['warming:on', 'warming:off', 'progress', 'finish'])
  })

  it('clears it on `done` when the cold call was the turn’s last', async () => {
    const rec = recorder()
    fetchMock.mockResolvedValue(sseResponse([warmingFrame(), done()]))
    await runTurn(request(), rec.sink)

    expect(rec.warmings.at(-1)).toBeNull()
  })

  it('clears it on an `error` frame — a failed wait is still over', async () => {
    const rec = recorder()
    fetchMock.mockResolvedValue(
      sseResponse([warmingFrame(), { event: 'error', data: { error: 'boom' } }]),
    )
    await runTurn(request(), rec.sink)

    expect(rec.warmings.at(-1)).toBeNull()
  })

  it('clears it when the stream just ends mid-wait, rather than leaving a spinner behind', async () => {
    // A stream that closes with no `done` (a teardown, a dropped connection)
    // still leaves the loop, and the notice has to come down with it — the
    // whole turn is over and there is nothing behind the spinner.
    const rec = recorder()
    fetchMock.mockResolvedValue(sseResponse([warmingFrame()]))
    await runTurn(request(), rec.sink)

    expect(rec.warmings).toEqual([expect.objectContaining({ estimateMs: 146_000 }), null])
  })

  it('clears it when the wait is torn down mid-stream, not just when it ends', async () => {
    // Stop pressed during a 146s wait, or a dropped connection: the loop throws
    // with the notice still up, so the `catch` is the ONLY exit that can take it
    // down — its two siblings (the in-loop clear and the post-loop one) are
    // never reached. This is the exact case the no-clear-frame design has to
    // answer for, and the one exit that had no pin of its own.
    const rec = recorder()
    fetchMock.mockResolvedValue(
      sseThenFailure([warmingFrame()], new DOMException('aborted', 'AbortError')),
    )
    const result = await runTurn(request(), rec.sink)

    expect(result).toMatchObject({ state: { status: 'stopped' }, aborted: true })
    expect(rec.warmings).toEqual([expect.objectContaining({ estimateMs: 146_000 }), null])
  })

  it('never raises one on a turn the server said nothing about', async () => {
    const rec = recorder()
    fetchMock.mockResolvedValue(
      sseResponse([controllerAction({}), toolResult(singleNodeFixture), done()]),
    )
    await runTurn(request(), rec.sink)

    expect(rec.warmings).toEqual([])
  })

  it('does not feed the notice to the progress controller — it is not a chain event', async () => {
    const rec = recorder()
    fetchMock.mockResolvedValue(sseResponse([warmingFrame(), controllerAction({}), done()]))
    await runTurn(request(), rec.sink)

    expect(rec.progress).toHaveLength(1)
    expect(rec.progress[0].type).toBe('controller_action')
  })
})
