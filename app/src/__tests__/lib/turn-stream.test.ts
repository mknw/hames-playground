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
  IDLE_TURN,
  RECOVERY_MISSING_POLLS,
  RECOVERY_POLL_MS,
  type PersistedTurn,
  type TurnRecovery,
  type TurnSink,
  type TurnState,
} from '~/lib/turn-stream'
import type { Message } from '~/components/ark-ui/ChatMessages'
import type { ContextEvent, UnifiedContext } from '@hames-ai/harness-patterns'
import type { GraphElement } from '@hames-ai/agents'
import { SSE_STALL_MS, type WarmingEventData } from '~/lib/sse-client'
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
      // The browser's zone rides every turn, so the agent's "now" is the user's.
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
  })

  // Decision-loop-agent slice 9. MUTATION: send the message (or the agent) on
  // a resume → the server's resume carries a body it must not read → red.
  it('a resume posts the session, settings and mode, and no message or agent', async () => {
    const rec = recorder()
    await runTurn(request({ mode: 'resume', message: '' }), rec.sink)

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toEqual({
      sessionId: 's1',
      settings: { maxConcurrentRuns: 3 },
      mode: 'resume',
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
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

  // MUTATION: return `done` for a paused frame → red.
  it('ends in awaiting-decision, naming the unanswered requests, when the run pauses (#433 S8)', async () => {
    const ev = (type: string, requestId: string) => ({ type, data: { requestId } })
    fetchMock.mockResolvedValue(
      sseResponse([
        done({
          status: 'paused',
          response: 'I need a decision.',
          context: {
            events: [
              ev('hitl_request', 'r1'),
              ev('hitl_request', 'r2'),
              ev('hitl_response', 'r1'),
              { type: 'tool_result', data: {} },
            ],
          },
        }),
      ]),
    )
    const rec = recorder()
    const result = await runTurn(request(), rec.sink)

    expect(result.state).toEqual({ status: 'awaiting-decision', requestIds: ['r2'] })
    // A paused turn is not a failure — the thread mark says it landed.
    expect(result.outcome).toBe('done')
    // No inline approve/reject bubble: the card and dialog own the decision.
    expect(rec.messages.at(-1)?.toolCall).toBeUndefined()
  })

  it('a paused frame with no unanswered request is just done', async () => {
    fetchMock.mockResolvedValue(sseResponse([done({ status: 'paused', response: 'ok' })]))
    const result = await runTurn(request(), recorder().sink)
    expect(result.state).toEqual({ status: 'done' })
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

  // #420: a side task's warning arrives as an ordinary message frame and is
  // painted as the amber bubble; the turn is still `done` and still answered.
  // Mutation: delete the `evt.type === 'warning'` branch → no bubble.
  it('paints a warning event inline, and the turn still lands on done', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        message({
          type: 'warning',
          patternId: 'title-gen',
          ts: 1,
          data: {
            task: 'title',
            message: 'The conversation title could not be generated.',
            fallback: 'It is named after the start of your first message.',
            error: 'connect ECONNREFUSED 127.0.0.1:8095',
          },
        }),
        done(),
      ]),
    )
    const rec = recorder()
    const result = await runTurn(request(), rec.sink)

    expect(rec.messages[0]).toMatchObject({
      role: 'warning',
      content: 'The conversation title could not be generated.',
      hint: 'It is named after the start of your first message.',
    })
    expect(result.outcome).toBe('done')
    expect(result.state).toEqual({ status: 'done' })
    expect(rec.messages.at(-1)?.content).toBe('Here is your answer.')
  })

  // PR #424 review F1. The title warning is sent AFTER `done` (the stream is
  // held open for the title), while the answer is painted only once the
  // stream ends — so appending it on arrival put it ABOVE the answer, and
  // replay, which follows event order, puts it below.
  // Mutation: append the bubble on arrival (drop the `if (finalResult)` hold)
  // → roles come out ['warning', 'assistant'].
  it('paints a warning that arrives after done BELOW the answer, as replay does', async () => {
    const titleWarning = message({
      type: 'warning',
      patternId: 'title-gen',
      ts: 2,
      data: {
        task: 'title',
        message: 'The conversation title could not be generated.',
        fallback: 'It is named after the start of your first message.',
      },
    })
    fetchMock.mockResolvedValue(sseResponse([done(), titleWarning]))
    const rec = recorder()
    const result = await runTurn(request(), rec.sink)

    expect(rec.messages.map((m) => m.role)).toEqual(['assistant', 'warning'])
    expect(result.outcome).toBe('done')
  })

  // Mutation: delete `flushAfterAnswer()` from the catch → a held warning is
  // dropped when the stream fails after `done`.
  it('does not drop a held warning when the stream then fails', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        done(),
        message({
          type: 'warning',
          patternId: 'title-gen',
          ts: 2,
          data: { task: 'title', message: 'The conversation title could not be generated.' },
        }),
        { event: 'error', data: { error: 'stream broke' } },
      ]),
    )
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const rec = recorder()
    await runTurn(request(), rec.sink)

    expect(rec.messages.map((m) => m.role)).toEqual(['warning', 'error'])
    err.mockRestore()
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

  // The notice and the failure are different things: the spinner comes down on
  // the `error` frame, the bubble must NOT. "Cleared on the next frame of any
  // kind" is a rule about the warming notice only.
  // MUTATION: call `sink.appendMessage` nowhere in the catch (or clear the
  // transcript with the notice) → no error bubble remains and this reddens.
  it('leaves the wake failure standing as an error bubble after the notice comes down', async () => {
    const rec = recorder()
    const message = 'the private inference box did not wake: nothing was sent to any provider.'
    fetchMock.mockResolvedValue(
      sseResponse([warmingFrame(), { event: 'error', data: { error: message } }]),
    )
    const result = await runTurn(request(), rec.sink)

    expect(rec.order.slice(0, 1)).toEqual(['warming:on'])
    expect(rec.warmings.at(-1)).toBeNull()
    expect(rec.messages).toEqual([expect.objectContaining({ role: 'error', content: message })])
    expect(result.state).toEqual({ status: 'error', message })
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

// ---------------------------------------------------------------------------
// A lost stream: the answer is read back from the saved turn
// ---------------------------------------------------------------------------

/**
 * The live failure this reproduces. The turn finished on the server in
 * seconds, and its stream delivered the early frames and then nothing. `done`
 * never arrived and the stream never closed, so the bubble showed a dot and an
 * empty bar until a reload. The body enqueues `frames` and then never closes:
 * that is the client's whole view of that stall.
 */
const sseThenSilence = (frames: Frame[]) => {
  const text = frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join('')
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
    },
  })
  return { ok: true, status: 200, body } as unknown as Response
}

const savedAnswer = (over: Partial<PersistedTurn> = {}): PersistedTurn => ({
  status: 'done',
  messages: [
    { id: 'u', role: 'user', content: 'what nodes exist?', timestamp: new Date(0) },
    { id: 'a', role: 'assistant', content: 'The saved answer.', timestamp: new Date(0) },
  ],
  context: { events: [] } as unknown as UnifiedContext,
  ...over,
})

/** A recovery double: `inFlight` polls report the turn still running, then it is free. */
const recoveryDouble = (opts: { inFlight?: number; saved?: PersistedTurn } = {}) => {
  let polls = 0
  const rehydrated: PersistedTurn[] = []
  const recovery: TurnRecovery = {
    turnState: vi.fn(async () => ({ turnInFlight: polls++ < (opts.inFlight ?? 0) })),
    load: vi.fn(async () => opts.saved ?? savedAnswer()),
    rehydrate: (turn) => rehydrated.push(turn),
  }
  return { recovery, rehydrated }
}

describe('runTurn — a stream lost before the answer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // MUTATION: read with a bare `reader.read()` in `parseChatStream` (no stall
  // bound) → the turn never settles and `settled` stays false. MUTATION: drop
  // the `recovery` branch in `runTurn` → the turn ends in an error state with
  // no answer, and the rehydrate assertions redden.
  it('shows the saved answer after the stream goes silent, with no reload', async () => {
    fetchMock.mockResolvedValue(sseThenSilence([controllerAction({ tool_name: 'Search' })]))
    const rec = recorder()
    const { recovery, rehydrated } = recoveryDouble({ inFlight: 1 })
    let settled = false
    const turn = runTurn(request(), rec.sink, recovery).then((r) => {
      settled = true
      return r
    })

    // Still inside the keepalive guarantee: nothing is decided yet.
    await vi.advanceTimersByTimeAsync(SSE_STALL_MS - 1)
    expect(settled).toBe(false)
    expect(recovery.turnState).not.toHaveBeenCalled()

    // Stalled. One poll finds the turn still running, the next finds it saved.
    await vi.advanceTimersByTimeAsync(1 + RECOVERY_POLL_MS)
    const result = await turn

    expect(recovery.turnState).toHaveBeenCalledTimes(2)
    expect(rehydrated).toEqual([savedAnswer()])
    expect(result).toEqual({ state: { status: 'done' }, outcome: 'done', aborted: false })
    expect(rec.states.at(-1)).toEqual({ status: 'done' })
    expect(rec.finished).toBe(1)
    // The saved transcript replaces the live one; nothing is appended twice.
    expect(rec.messages).toEqual([])
  })

  // MUTATION: recover only on a stall (`lost && recovery`) → a bare close with
  // no `done` paints nothing and the turn reads as done with no answer.
  it('reads the saved turn when the stream closes without a done frame', async () => {
    fetchMock.mockResolvedValue(sseResponse([controllerAction({})]))
    const rec = recorder()
    const { recovery, rehydrated } = recoveryDouble()

    const result = await runTurn(request(), rec.sink, recovery)

    expect(rehydrated).toHaveLength(1)
    expect(result.state).toEqual({ status: 'done' })
  })

  it('reads the saved turn when the connection drops mid-stream', async () => {
    fetchMock.mockResolvedValue(
      sseThenFailure(
        [controllerAction({})],
        new TypeError('NetworkError when attempting to fetch'),
      ),
    )
    const rec = recorder()
    const { recovery, rehydrated } = recoveryDouble()

    const result = await runTurn(request(), rec.sink, recovery)

    expect(rehydrated).toHaveLength(1)
    expect(result.state).toEqual({ status: 'done' })
    expect(rec.messages).toEqual([])
  })

  // The answer is already in hand; the stall only cost the title or the close.
  it('paints the done frame’s answer when the stall comes after done', async () => {
    fetchMock.mockResolvedValue(sseThenSilence([done()]))
    const rec = recorder()
    const { recovery } = recoveryDouble()

    const turn = runTurn(request(), rec.sink, recovery)
    await vi.advanceTimersByTimeAsync(SSE_STALL_MS)
    const result = await turn

    expect(recovery.turnState).not.toHaveBeenCalled()
    expect(rec.messages).toEqual([
      expect.objectContaining({ role: 'assistant', content: 'Here is your answer.' }),
    ])
    expect(result.state).toEqual({ status: 'done' })
  })

  // An `error` frame is the server reporting the turn failed. That is the
  // answer, so the saved turn is not polled for.
  it('does not recover from an error frame', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchMock.mockResolvedValue(sseResponse([{ event: 'error', data: { error: 'boom' } }]))
    const rec = recorder()
    const { recovery } = recoveryDouble()

    const result = await runTurn(request(), rec.sink, recovery)

    expect(recovery.turnState).not.toHaveBeenCalled()
    expect(result.state).toEqual({ status: 'error', message: 'boom' })
  })

  it('ends as the saved turn ended: a failed run reads as an error', async () => {
    fetchMock.mockResolvedValue(sseResponse([]))
    const rec = recorder()
    const failed = savedAnswer({
      status: 'error',
      messages: [
        { id: 'e', role: 'error', content: 'the box did not wake', timestamp: new Date(0) },
      ],
    })
    const { recovery } = recoveryDouble({ saved: failed })

    const result = await runTurn(request(), rec.sink, recovery)

    expect(result).toMatchObject({
      state: { status: 'error', message: 'the box did not wake' },
      outcome: 'error',
    })
  })

  it('stops waiting when the user presses Stop', async () => {
    fetchMock.mockResolvedValue(sseResponse([]))
    const rec = recorder()
    const controller = new AbortController()
    const { recovery } = recoveryDouble({ inFlight: Infinity })

    const turn = runTurn(request({ signal: controller.signal }), rec.sink, recovery)
    await vi.advanceTimersByTimeAsync(RECOVERY_POLL_MS * 2)
    controller.abort()
    const result = await turn

    expect(result).toEqual({ state: { status: 'stopped' }, outcome: 'done', aborted: true })
  })

  it('gives up with an error when the conversation was never saved', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    fetchMock.mockResolvedValue(sseResponse([]))
    const rec = recorder()
    const recovery: TurnRecovery = {
      turnState: vi.fn(async () => null),
      load: vi.fn(),
      rehydrate: vi.fn(),
    }

    const turn = runTurn(request(), rec.sink, recovery)
    await vi.advanceTimersByTimeAsync(RECOVERY_POLL_MS * RECOVERY_MISSING_POLLS)
    const result = await turn

    expect(recovery.turnState).toHaveBeenCalledTimes(RECOVERY_MISSING_POLLS)
    expect(recovery.load).not.toHaveBeenCalled()
    expect(result.outcome).toBe('error')
    expect(rec.messages.at(-1)).toMatchObject({ role: 'error' })
  })
})
