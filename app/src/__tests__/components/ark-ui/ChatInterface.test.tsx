/**
 * ChatInterface — the run loop that turns a composer submit into a transcript.
 *
 * The component owns four things worth pinning down, and all four are bugs
 * that have actually been fixed here (#47, #105, #71-adjacent promotion gate):
 *
 *  - hydration: a session swap reloads that thread's history, and must NOT
 *    wipe a thread whose run is still streaming;
 *  - the SSE run: events are filed against the session captured at *submit*
 *    time, so switching threads mid-stream can't misfile a turn;
 *  - the gates: concurrency cap, in-flight block, embedding block, and the
 *    action→conversation promotion confirm;
 *  - the approve/reject round trip on a paused write.
 *
 * The route's per-session state is the real `SessionRegistry` (#226 B1),
 * provided through context exactly as `routes/index.tsx` does — so these
 * assertions read the registry rather than a hand-rolled stand-in that could
 * drift from it.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { render } from '@solidjs/testing-library'
import { createSignal, createRoot, type JSX } from 'solid-js'
import { installDomObservers } from '../../mocks/dom-observers'
import type { ContextEvent, UnifiedContext } from '~/lib/harness-patterns'
import singleNodeFixture from '../../lib/harness-client/fixtures/cypher-single-node.json'

beforeAll(() => {
  installDomObservers()
  Element.prototype.scrollIntoView = vi.fn()
})

// ---------------------------------------------------------------------------
// Module doubles. The harness-client barrel re-exports `actions.server`, whose
// transitive `assert.server` throws under jsdom — so the whole barrel is
// replaced, with the two genuinely client-safe extractors kept real.
// ---------------------------------------------------------------------------
vi.mock('~/lib/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

const loadConversation = vi.fn()
const approveAction = vi.fn()
const rejectAction = vi.fn()
const promoteAction = vi.fn()
const AGENTS = [
  {
    id: 'search',
    name: 'Default',
    description: 'The generalist',
    welcome: 'I route your question to the graph or the web.',
    icon: 'i-x',
    servers: ['neo4j'],
  },
  {
    id: 'kg',
    name: 'KG Builder',
    description: 'Builds the graph',
    welcome: 'I write what you tell me into the knowledge graph.',
    icon: 'i-y',
    servers: ['neo4j', 'memory'],
  },
]
const getAgentList = vi.fn(async () => AGENTS)

const getConversationTier = vi.fn(async () => ({ tier: 'anthropic', verdaAvailable: true }))
const setConversationTier = vi.fn(async (_id: string, tier: string) => ({
  tier,
  verdaAvailable: true,
}))
vi.mock('~/lib/harness-client', async () => {
  const graph = await import('~/lib/harness-client/graph-extractor')
  const refs = await import('~/lib/harness-client/reference-extractor')
  return {
    ...graph,
    ...refs,
    loadConversation,
    approveAction,
    rejectAction,
    promoteAction,
    getAgentList,
    // The tier switch beside the agent selector reads on mount and on every
    // session change. Its own behaviour is `ConversationTierSwitch.test.tsx`;
    // here it only has to answer, so the header renders.
    getConversationTier,
    setConversationTier,
  }
})

const { ChatInterface } = await import('~/components/ark-ui/ChatInterface')
const { createSessionRegistry } = await import('~/lib/session-registry')
const { SessionRegistryContext } = await import('~/lib/session-registry-context')
type SessionRegistry = import('~/lib/session-registry').SessionRegistry

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
/** Long enough for a full fetch → stream → finally cycle to settle. */
const settle = () => tick(60)

// ---------------------------------------------------------------------------
// SSE plumbing: build a Response whose body streams the given frames.
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
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    body,
  } as unknown as Response
}

/**
 * A response the test feeds frame by frame, so a MID-stream state can be
 * observed. `sseResponse` closes the body before the component has rendered
 * anything, which is fine for end-state assertions and useless for a notice
 * that exists only while the turn is still waiting.
 *
 * A caller must let the stream be READ between a `push` and a `fail`: a
 * ReadableStream discards its queue on `error()`, so a frame that has not been
 * consumed yet is lost rather than delivered-then-failed.
 */
const drivenSseResponse = () => {
  const enc = new TextEncoder()
  let ctrl!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start: (controller) => void (ctrl = controller),
  })
  return {
    response: { ok: true, status: 200, body } as unknown as Response,
    push: (frame: Frame) =>
      ctrl.enqueue(enc.encode(`event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`)),
    fail: (error: unknown) => ctrl.error(error),
    close: () => ctrl.close(),
  }
}

/** A `tool_result` event the graph extractor turns into real elements. */
const toolResult = (result: unknown) => ({
  type: 'tool_result' as const,
  ts: 1,
  patternId: 'neo4j-query',
  data: { tool: 'read_neo4j_cypher', result, success: true },
})

const doneFrame = (over: Record<string, unknown> = {}): Frame => ({
  event: 'done',
  data: { status: 'done', response: 'Here is your answer.', context: { events: [] }, ...over },
})

// ---------------------------------------------------------------------------
// The route's registry, mounted around the component under test (#226 B1).
// ---------------------------------------------------------------------------
const makeHost = (over: Partial<SessionRegistry> = {}) => {
  const registry: SessionRegistry = { ...createRoot(() => createSessionRegistry()), ...over }
  return {
    registry,
    /** Mount `node` under this registry, the way `routes/index.tsx` does. */
    mount: (node: () => JSX.Element) =>
      render(() => (
        <SessionRegistryContext.Provider value={registry}>{node()}</SessionRegistryContext.Provider>
      )),
    /** Put `n` *other* conversations into a streaming state (concurrency cap). */
    withOtherRuns: (n: number) => {
      for (let i = 0; i < n; i++) registry.updateRunState(`other-${i}`, { isProcessing: true })
    },
  }
}

const composer = (root: HTMLElement) => root.querySelector('textarea')!

const send = (root: HTMLElement, text: string) => {
  const el = composer(root)
  el.value = text
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
}

const transcript = (root: HTMLElement) => root.textContent ?? ''

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  getAgentList.mockResolvedValue(AGENTS)
  // Default: brand-new session with nothing persisted.
  loadConversation.mockRejectedValue(new Error('not found'))
  fetchMock = vi.fn(async () => sseResponse([doneFrame()]))
  vi.stubGlobal('fetch', fetchMock)
  localStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ChatInterface — hydration', () => {
  // The greeting used to be one hardcoded assistant message planted in the
  // transcript, identical for every agent ("your knowledge assistant"). It is
  // now the SELECTED AGENT's own `welcome` from the registry, rendered as
  // ChatMessages' empty state — so the transcript itself stays empty, and no
  // words are attributed to an assistant that has not spoken.
  it("greets with the selected agent's own copy, leaving the transcript empty", async () => {
    const host = makeHost()
    const { container } = host.mount(() => <ChatInterface sessionId="s1" />)
    await settle()

    expect(transcript(container)).toContain('I route your question to the graph or the web.')
    expect(transcript(container)).toContain('Default')
    expect(host.registry.messages('s1')).toHaveLength(0)
  })

  it('greets as the agent a rehydrated thread reports, not as the default', async () => {
    loadConversation.mockResolvedValue({
      agentId: 'kg',
      kind: 'conversation',
      serialized: JSON.stringify({ events: [] } satisfies Partial<UnifiedContext>),
      messages: [],
    })
    const host = makeHost()
    const { container } = host.mount(() => <ChatInterface sessionId="s1" />)
    await settle()

    expect(transcript(container)).toContain('I write what you tell me into the knowledge graph.')
  })

  it('falls back to the generic empty state when the agent list cannot be fetched', async () => {
    getAgentList.mockRejectedValue(new Error('gateway down'))
    const host = makeHost()
    const { container } = host.mount(() => <ChatInterface sessionId="s1" />)
    await settle()

    expect(transcript(container)).toContain('Start a conversation')
  })

  it('does not let a LATE hydration wipe the turn the user already sent', async () => {
    // Caught by `05-multi-turn.browser.ts`, pinned here because it is provable
    // at this layer and layer 3 costs minutes.
    //
    // A brand-new chat REJECTS `loadConversation` — there is no row yet — and
    // that rejection is a network round trip. The effect's "a run is in flight,
    // leave the buffer alone" guard sat only at ENTRY, so a rejection landing
    // after the first send replaced the user's message and its answer with a
    // planted welcome bubble: nothing wrong on the wire, a transcript missing
    // its first exchange on screen.
    //
    // The greeting is no longer planted at all — an empty transcript is what
    // makes `ChatMessages` render the selected agent's own welcome — so what is
    // pinned here is the property that outlives the plant: a hydration that
    // answers late writes NOTHING over a turn that has already happened.
    let rejectLoad: ((err: Error) => void) | undefined
    loadConversation.mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectLoad = reject
      }),
    )

    const host = makeHost()
    const { container } = host.mount(() => <ChatInterface sessionId="s-late" />)
    await settle()

    send(container, 'the first question')
    await settle()
    expect(host.registry.messages('s-late').map((m) => m.content)).toContain('the first question')

    // The hydration finally answers, after the turn has come and gone.
    rejectLoad?.(new Error('not found'))
    await settle()

    // The turn survives, and it is still the FIRST thing in the transcript:
    // nothing was written in front of it and nothing replaced it, whichever of
    // the two round trips lands first.
    const contents = host.registry.messages('s-late').map((m) => m.content)
    expect(contents).toContain('the first question')
    expect(contents[0]).toBe('the first question')
  })

  it('rehydrates a persisted thread, reporting its agent and replaying its events', async () => {
    const events: ContextEvent[] = [
      { type: 'user_message', patternId: 'chat', ts: 1, data: { content: 'earlier' } },
    ]
    loadConversation.mockResolvedValue({
      agentId: 'kg',
      kind: 'conversation',
      serialized: JSON.stringify({ events } satisfies Partial<UnifiedContext>),
      messages: [
        { id: 'm1', role: 'user', content: 'earlier', timestamp: '2026-05-10T09:00:00Z' },
        {
          id: 'm2',
          role: 'assistant',
          content: 'earlier answer',
          timestamp: '2026-05-10T09:00:05Z',
        },
      ],
    })
    const onContextUpdate = vi.fn()
    const onSelectedAgentChange = vi.fn()
    const host = makeHost()

    const { container } = host.mount(() => (
      <ChatInterface
        sessionId="s1"
        onContextUpdate={onContextUpdate}
        onSelectedAgentChange={onSelectedAgentChange}
      />
    ))
    await settle()

    expect(transcript(container)).toContain('earlier answer')
    // Registry writes are addressed by session id (SA-H8), so a hydration that
    // lands after the user has moved on still files into the thread it belongs to.
    expect(host.registry.events('s1')).toEqual(events)
    expect(onContextUpdate).toHaveBeenCalledWith('s1', { events })
    expect(onSelectedAgentChange).toHaveBeenLastCalledWith('kg')
  })

  // Regression for the field-picking bug called out in the source: an error
  // bubble's hint/patternId/turnInfo must survive a reload.
  it('keeps the hint and attribution on a replayed error bubble', async () => {
    loadConversation.mockResolvedValue({
      agentId: 'search',
      kind: 'conversation',
      serialized: '{}',
      messages: [
        {
          id: 'e1',
          role: 'error',
          content: 'Gateway unreachable',
          timestamp: '2026-05-10T09:00:00Z',
          hint: 'Start the MCP gateway.',
          patternId: 'neo4j-query',
          turnInfo: '(turn 2)',
        },
      ],
    })
    const host = makeHost()
    const { container } = host.mount(() => <ChatInterface sessionId="s1" />)
    await settle()

    expect(transcript(container)).toContain('Error in neo4j-query (turn 2)')
    expect(transcript(container)).toContain('Start the MCP gateway.')
  })

  it('survives a thread whose serialized context is unparseable', async () => {
    loadConversation.mockResolvedValue({
      agentId: 'search',
      kind: 'conversation',
      serialized: 'not json',
      messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: '2026-05-10T09:00:00Z' }],
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const host = makeHost()
    const { container } = host.mount(() => <ChatInterface sessionId="s1" />)
    await settle()

    expect(transcript(container)).toContain('hi')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('reloads and resets the panels when the route swaps in another session', async () => {
    loadConversation.mockImplementation(async (sid: string) => ({
      agentId: 'search',
      kind: 'conversation',
      serialized: '{}',
      messages: [
        { id: sid, role: 'user', content: `msg for ${sid}`, timestamp: '2026-05-10T09:00:00Z' },
      ],
    }))
    const host = makeHost()
    const clearPanels = vi.fn(host.registry.clearPanels)
    host.registry.clearPanels = clearPanels
    const [sid, setSid] = createSignal('s1')

    const { container } = host.mount(() => <ChatInterface sessionId={sid()} />)
    await settle()
    expect(transcript(container)).toContain('msg for s1')

    setSid('s2')
    await settle()

    expect(transcript(container)).toContain('msg for s2')
    // One wipe per hydration, each addressed at the session being hydrated.
    expect(clearPanels.mock.calls).toEqual([['s1'], ['s2']])
  })

  // Graph batches are filed against the conversation they belong to, and the
  // highlight — which is view state, not session state — only moves when that
  // conversation is the one on screen (SA-H8 / #226 B1).
  it('files a replayed graph in its own thread and highlights it while displayed', async () => {
    loadConversation.mockResolvedValue({
      agentId: 'search',
      kind: 'conversation',
      serialized: JSON.stringify({ events: [toolResult(singleNodeFixture)] }),
      messages: [],
    })
    const onHighlightEntities = vi.fn()
    const host = makeHost()
    host.mount(() => <ChatInterface sessionId="s1" onHighlightEntities={onHighlightEntities} />)
    await settle()

    expect(host.registry.graph('s1').map((e) => e.data?.id)).toEqual(['Redis'])
    expect(onHighlightEntities).toHaveBeenCalledWith(['Redis'])
  })

  it('does not move the highlight for a batch landing in a thread that is not on screen', async () => {
    let releaseS1: () => void = () => {}
    loadConversation.mockImplementation(
      (sid: string) =>
        new Promise((resolve) => {
          const payload = {
            agentId: 'search',
            kind: 'conversation',
            serialized: JSON.stringify({ events: [toolResult(singleNodeFixture)] }),
            messages: [],
          }
          if (sid === 's1') releaseS1 = () => resolve(payload)
          else resolve({ agentId: 'search', kind: 'conversation', serialized: '{}', messages: [] })
        }),
    )
    const onHighlightEntities = vi.fn()
    const host = makeHost()
    const [sid, setSid] = createSignal('s1')
    host.mount(() => <ChatInterface sessionId={sid()} onHighlightEntities={onHighlightEntities} />)
    await settle()

    // The user moves on before s1's history comes back.
    setSid('s2')
    await settle()
    releaseS1()
    await settle()

    // s1's graph is populated — but the thread on screen keeps its highlight.
    expect(host.registry.graph('s1').map((e) => e.data?.id)).toEqual(['Redis'])
    expect(onHighlightEntities).not.toHaveBeenCalled()
  })

  // The #105 bug in one test: a mid-stream session swap must not clear the
  // running thread's buffer, because nothing is persisted until the run ends.
  it("leaves a streaming session's buffer alone when it is re-selected", async () => {
    const host = makeHost()
    host.registry.setMessages('s1', [
      { id: 'live', role: 'assistant', content: 'streaming so far', timestamp: new Date() },
    ])
    host.registry.updateRunState('s1', { isProcessing: true, runningTool: null })

    const { container } = host.mount(() => <ChatInterface sessionId="s1" />)
    await settle()

    expect(loadConversation).not.toHaveBeenCalled()
    expect(transcript(container)).toContain('streaming so far')
  })
})

describe('ChatInterface — sending a message', () => {
  it('posts the message and appends the user turn then the answer', async () => {
    const host = makeHost()
    const { container } = host.mount(() => <ChatInterface sessionId="s1" />)
    await settle()

    send(container, 'what nodes exist?')
    await settle()

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/events')
    expect(JSON.parse(init.body)).toMatchObject({
      sessionId: 's1',
      message: 'what nodes exist?',
      agentId: 'search',
    })
    expect(transcript(container)).toContain('what nodes exist?')
    expect(transcript(container)).toContain('Here is your answer.')
  })

  it('announces the run start and its outcome to the route', async () => {
    const onRunStarted = vi.fn()
    const onRunSettled = vi.fn()
    const host = makeHost()
    const { container } = host.mount(() => (
      <ChatInterface
        sessionId="s1"

        onRunStarted={onRunStarted}
        onRunSettled={onRunSettled}
      />
    ))
    await settle()

    send(container, 'go')
    await settle()

    expect(onRunStarted).toHaveBeenCalledExactlyOnceWith('s1')
    expect(onRunSettled).toHaveBeenCalledExactlyOnceWith('s1', 'done')
    // The run released its slot and its abort controller.
    expect(host.registry.runState('s1').isProcessing).toBe(false)
  })

  it('reports an error outcome when the run ends in an error status', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([doneFrame({ status: 'error', response: 'partial garbage' })]),
    )
    const onRunSettled = vi.fn()
    const host = makeHost()
    const { container } = host.mount(() => (
      <ChatInterface sessionId="s1" onRunSettled={onRunSettled} />
    ))
    await settle()

    send(container, 'go')
    await settle()

    expect(onRunSettled).toHaveBeenCalledWith('s1', 'error')
    // A stale/garbage response on an errored run is not shown as an answer.
    expect(transcript(container)).not.toContain('partial garbage')
  })

  it('surfaces a non-OK response as an error bubble', async () => {
    fetchMock.mockResolvedValue(sseResponse([], { ok: false, status: 503 }))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const onRunSettled = vi.fn()
    const host = makeHost()
    const { container } = host.mount(() => (
      <ChatInterface sessionId="s1" onRunSettled={onRunSettled} />
    ))
    await settle()

    send(container, 'go')
    await settle()

    expect(transcript(container)).toContain('Server error: 503')
    expect(onRunSettled).toHaveBeenCalledWith('s1', 'error')
    err.mockRestore()
  })

  // A page-unload abort is teardown, not a result — it must not paint an
  // error bubble or report an outcome.
  it('stays silent when the run is aborted', async () => {
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'))
    const onRunSettled = vi.fn()
    const host = makeHost()
    const { container } = host.mount(() => (
      <ChatInterface sessionId="s1" onRunSettled={onRunSettled} />
    ))
    await settle()

    send(container, 'go')
    await settle()

    expect(onRunSettled).not.toHaveBeenCalled()
    expect(transcript(container)).not.toContain('aborted')
  })

  it('turns an SSE error frame into an error bubble', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([{ event: 'error', data: { error: 'controller exploded' } }]),
    )
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = makeHost()
    const { container } = host.mount(() => <ChatInterface sessionId="s1" />)
    await settle()

    send(container, 'go')
    await settle()

    expect(transcript(container)).toContain('controller exploded')
    err.mockRestore()
  })

  it('paints a recoverable error event as an inline warning without ending the run', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        {
          event: 'message',
          data: {
            type: 'error',
            patternId: 'neo4j-query',
            ts: 1,
            data: {
              error: 'tool timed out',
              severity: 'recoverable',
              hint: 'Retrying with a smaller page.',
              turn: 1,
            },
          },
        },
        doneFrame(),
      ]),
    )
    const onRunSettled = vi.fn()
    const host = makeHost()
    const { container } = host.mount(() => (
      <ChatInterface sessionId="s1" onRunSettled={onRunSettled} />
    ))
    await settle()

    send(container, 'go')
    await settle()

    expect(transcript(container)).toContain('Warning in neo4j-query (turn 2)')
    expect(transcript(container)).toContain('Retrying with a smaller page.')
    // Recoverable — the turn still completed.
    expect(transcript(container)).toContain('Here is your answer.')
    expect(onRunSettled).toHaveBeenCalledWith('s1', 'done')
  })

  it('forwards the pushed title straight to the route', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([
        { event: 'title_updated', data: { sessionId: 's1', title: 'Node inventory' } },
        doneFrame(),
      ]),
    )
    const onTitleUpdated = vi.fn()
    const host = makeHost()
    const { container } = host.mount(() => (
      <ChatInterface sessionId="s1" onTitleUpdated={onTitleUpdated} />
    ))
    await settle()

    send(container, 'go')
    await settle()

    expect(onTitleUpdated).toHaveBeenCalledWith('s1', 'Node inventory')
  })

  /**
   * The seam between `turn-stream` and `LiveProgressBar`, which is the half
   * that decides whether a human sees anything.
   *
   * `turn-stream.test.ts` pins that the sink is called in the right order and
   * `LiveProgressBar.test.tsx` pins that a `warming` prop renders a notice and
   * suppresses the bar — and BOTH stay green with this component's wiring
   * removed. Two mutations that kill the feature end to end:
   *
   *  - `onWarming: () => {}` in the sink — nothing ever reaches the registry;
   *  - dropping `!!warming() ||` from the bar's `visible` condition — the
   *    notice cannot mount, because during a cold start no chain event has
   *    arrived yet and `maxProjection` is still 0. That guard is what makes the
   *    notice deterministic rather than dependent on which agent seeded the
   *    denominator first, so it is exactly the line that gets "simplified" away.
   */
  it('puts a warming frame on screen instead of the bar, and clears it on the next frame', async () => {
    const stream = drivenSseResponse()
    fetchMock.mockResolvedValue(stream.response)
    const host = makeHost()
    const { container } = host.mount(() => <ChatInterface sessionId="s1" />)
    await settle()

    send(container, 'go')
    await settle()

    stream.push({
      event: 'warming',
      data: { sessionId: 's1', estimateMs: 146_000, basis: 'default', samples: 0 },
    })
    // Past the bar's 350ms mount delay — the notice shares the shell with it.
    await tick(450)

    expect(host.registry.runState('s1').warming).toMatchObject({
      estimateMs: 146_000,
      basis: 'default',
    })
    expect(
      container.querySelector('[data-testid="cold-start-notice"]'),
      'the notice never reached the screen',
    ).toBeTruthy()
    expect(transcript(container)).toContain('starting GPU')
    // The suppression is the point: a bar seeded at 0/N for 146s is the "is it
    // stuck?" reading this replaces.
    expect(
      container.querySelector('[data-part="range"]'),
      'the progress bar rendered during the cold start',
    ).toBeNull()

    stream.push(doneFrame())
    stream.close()
    await settle()

    expect(host.registry.runState('s1').warming).toBeNull()
    expect(container.querySelector('[data-testid="cold-start-notice"]')).toBeNull()
    expect(transcript(container)).toContain('Here is your answer.')
  })

  it('ignores an SSE event name it does not know', async () => {
    fetchMock.mockResolvedValue(
      sseResponse([{ event: 'telemetry', data: { anything: true } }, doneFrame()]),
    )
    const host = makeHost()
    const { container } = host.mount(() => <ChatInterface sessionId="s1" />)
    await settle()

    send(container, 'go')
    await settle()

    expect(host.registry.events('s1')).toEqual([])
    expect(transcript(container)).toContain('Here is your answer.')
  })
})

describe('ChatInterface — composer gates', () => {
  it('blocks the composer while this session is streaming', async () => {
    const host = makeHost()
    host.registry.updateRunState('s1', { isProcessing: true, runningTool: 'read_neo4j_cypher' })
    const { container } = host.mount(() => <ChatInterface sessionId="s1" />)
    await settle()

    expect(composer(container).getAttribute('aria-disabled')).toBe('true')
    expect(transcript(container)).toContain('Waiting for `read_neo4j_cypher` to complete.')
  })

  // The guard banner names whatever the controller is currently waiting on.
  // The label is written into run state as the stream goes by and is gone
  // again by the time the run settles, so it has to be observed in transit.
  const runningToolLabels = async (action: Record<string, unknown>) => {
    fetchMock.mockResolvedValue(
      sseResponse([
        {
          event: 'message',
          data: { type: 'controller_action', patternId: 'neo4j-query', ts: 1, data: { action } },
        },
        doneFrame(),
      ]),
    )
    const seen: Array<string | null> = []
    const base = createRoot(() => createSessionRegistry())
    const host = makeHost({
      updateRunState: (sid, patch) => {
        if ('runningTool' in patch) seen.push(patch.runningTool ?? null)
        base.updateRunState(sid, patch)
      },
      runState: (sid) => base.runState(sid),
    })
    const { container } = host.mount(() => <ChatInterface sessionId="s1" />)
    await settle()
    send(container, 'go')
    await settle()
    return seen
  }

  it('names the tool the controller is waiting on', async () => {
    expect(await runningToolLabels({ tool_name: 'read_neo4j_cypher' })).toContain(
      'read_neo4j_cypher',
    )
  })

  it('names the batch size rather than one tool for a multi-call turn', async () => {
    const seen = await runningToolLabels({
      tool_name: 'read_neo4j_cypher',
      additional_calls: [{ tool_name: 'get_schema' }, { tool_name: 'brave_web_search' }],
    })
    expect(seen).toContain('3 tools')
    expect(seen).not.toContain('read_neo4j_cypher')
  })

  it('clears the tool label when the controller returns its final answer', async () => {
    const seen = await runningToolLabels({ tool_name: 'Return', is_final: true })
    expect(seen).not.toContain('Return')
    expect(seen.at(-1)).toBeNull()
  })

  it('refuses to send once the concurrency cap is reached', async () => {
    const host = makeHost()
    host.withOtherRuns(3) // default cap is 3
    const { container } = host.mount(() => <ChatInterface sessionId="s1" />)
    await settle()

    expect(composer(container).getAttribute('aria-disabled')).toBe('true')
    expect(transcript(container)).toContain('max 3 reached')

    send(container, 'blocked')
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // The cap counts *other* sessions: a thread that is itself running is
  // already blocked by isProcessing and must not be double-counted out.
  it('does not cap-block a session that is itself the running one', async () => {
    const host = makeHost()
    host.withOtherRuns(3)
    host.registry.updateRunState('s1', { isProcessing: true, runningTool: 'read_neo4j_cypher' })
    const { container } = host.mount(() => <ChatInterface sessionId="s1" />)
    await settle()

    // Its own run blocks it, so it reads as "waiting for the tool" — not as
    // "someone else used the last slot", which would be wrong and confusing.
    expect(transcript(container)).toContain('Waiting for `read_neo4j_cypher` to complete.')
    expect(transcript(container)).not.toContain('max 3 reached')
  })

  it('blocks the composer while uploaded sources are still embedding', async () => {
    const host = makeHost()
    const { container } = host.mount(() => <ChatInterface sessionId="s1" embeddingSources />)
    await settle()

    expect(composer(container).getAttribute('aria-disabled')).toBe('true')
    expect(transcript(container)).toContain('Embedding sources…')
  })
})

describe('ChatInterface — action promotion gate', () => {
  const asAction = () =>
    loadConversation.mockResolvedValue({
      agentId: 'search',
      kind: 'action',
      serialized: '{}',
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          content: 'triggered run output',
          timestamp: '2026-05-10T09:00:00Z',
        },
      ],
    })

  const modal = () => document.querySelector<HTMLElement>('[data-role="promotion-confirm"]')
  const modalButton = (label: string) =>
    [...modal()!.querySelectorAll('button')].find((b) => b.textContent?.includes(label))!

  it('asks before sending into a triggered action, and sends nothing yet', async () => {
    asAction()
    const host = makeHost()
    const { container } = host.mount(() => <ChatInterface sessionId="s1" />)
    await settle()

    send(container, 'follow-up question')
    await settle()

    expect(modal()).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(promoteAction).not.toHaveBeenCalled()
  })

  it('drops the drafted message when the user declines', async () => {
    asAction()
    const host = makeHost()
    const { container } = host.mount(() => <ChatInterface sessionId="s1" />)
    await settle()

    send(container, 'follow-up question')
    await settle()
    modalButton('Cancel').click()
    await settle()

    expect(modal()).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(promoteAction).not.toHaveBeenCalled()
  })

  it('promotes then sends when the user confirms, and never gates again', async () => {
    asAction()
    promoteAction.mockResolvedValue(undefined)
    const onPromoted = vi.fn()
    const host = makeHost()
    const { container } = host.mount(() => <ChatInterface sessionId="s1" onPromoted={onPromoted} />)
    await settle()

    send(container, 'follow-up question')
    await settle()
    modalButton('Promote & send').click()
    await settle()

    expect(promoteAction).toHaveBeenCalledWith('s1')
    expect(onPromoted).toHaveBeenCalledWith('s1')
    expect(modal()).toBeNull()
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).message).toBe('follow-up question')

    // Second send goes straight out — the thread is a conversation now.
    send(container, 'and another')
    await settle()
    expect(modal()).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the confirm open when promotion fails so the user can retry', async () => {
    asAction()
    promoteAction.mockRejectedValue(new Error('row locked'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = makeHost()
    const { container } = host.mount(() => <ChatInterface sessionId="s1" />)
    await settle()

    send(container, 'follow-up question')
    await settle()
    modalButton('Promote & send').click()
    await settle()

    expect(modal()).toBeTruthy()
    expect(fetchMock).not.toHaveBeenCalled()
    err.mockRestore()
  })
})

describe('ChatInterface — paused write approval', () => {
  const pausedRun = () =>
    fetchMock.mockResolvedValue(
      sseResponse([
        doneFrame({
          status: 'paused',
          response: 'I need approval to write.',
          data: { pendingAction: { action: 'write_neo4j_cypher', reason: 'creates a node' } },
        }),
      ]),
    )

  const toolTrigger = (root: HTMLElement) =>
    root.querySelector<HTMLElement>('[data-scope="collapsible"][data-part="trigger"]')!
  const toolButton = (root: HTMLElement, label: string) =>
    [...root.querySelectorAll('button')].find((b) => b.textContent?.includes(label))!

  it('offers the pending write for approval and shows the result once approved', async () => {
    pausedRun()
    approveAction.mockResolvedValue({ response: 'Node created.', context: { events: [] } })
    const host = makeHost()
    const { container } = host.mount(() => <ChatInterface sessionId="s1" />)
    await settle()

    send(container, 'create a node')
    await settle()

    expect(transcript(container)).toContain('KG: Write')
    expect(transcript(container)).toContain('Awaiting approval')

    toolTrigger(container).click()
    await tick()
    toolButton(container, 'Approve').click()
    await settle()

    expect(approveAction).toHaveBeenCalledWith('s1')
    expect(transcript(container)).toContain('Node created.')
    expect(transcript(container)).toContain('Executed')
  })

  it('marks the tool call failed and reports why when the write throws', async () => {
    pausedRun()
    approveAction.mockRejectedValue(new Error('constraint violation'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = makeHost()
    const { container } = host.mount(() => <ChatInterface sessionId="s1" />)
    await settle()

    send(container, 'create a node')
    await settle()
    toolTrigger(container).click()
    await tick()
    toolButton(container, 'Approve').click()
    await settle()

    expect(transcript(container)).toContain('Write operation failed')
    expect(transcript(container)).toContain('constraint violation')
    expect(transcript(container)).toContain('Failed')
    err.mockRestore()
  })

  it("records the rejection on the tool call and shows the agent's reply", async () => {
    pausedRun()
    rejectAction.mockResolvedValue({ response: 'Understood, skipping the write.' })
    const host = makeHost()
    const { container } = host.mount(() => <ChatInterface sessionId="s1" />)
    await settle()

    send(container, 'create a node')
    await settle()
    toolTrigger(container).click()
    await tick()
    toolButton(container, 'Reject').click()
    await settle()

    expect(rejectAction).toHaveBeenCalledWith('s1')
    expect(transcript(container)).toContain('Understood, skipping the write.')
    toolTrigger(container).click()
    await tick()
    expect(transcript(container)).toContain('Rejected by user')
  })

  it('swallows a failed rejection without inventing an agent reply', async () => {
    pausedRun()
    rejectAction.mockRejectedValue(new Error('offline'))
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const host = makeHost()
    const { container } = host.mount(() => <ChatInterface sessionId="s1" />)
    await settle()

    send(container, 'create a node')
    await settle()
    toolTrigger(container).click()
    await tick()
    toolButton(container, 'Reject').click()
    await settle()

    expect(transcript(container)).toContain('Awaiting approval')
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})

describe('ChatInterface — agent selection', () => {
  it('asks the route for a fresh session rather than re-badging this one', async () => {
    const onAgentChangeRequestsNewSession = vi.fn()
    const onSelectedAgentChange = vi.fn()
    const host = makeHost()
    const { container } = host.mount(() => (
      <ChatInterface
        sessionId="s1"

        onAgentChangeRequestsNewSession={onAgentChangeRequestsNewSession}
        onSelectedAgentChange={onSelectedAgentChange}
      />
    ))
    await settle()

    // Open the selector and pick the other agent.
    const trigger = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Default'),
    )!
    trigger.click()
    await tick()
    const option = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('KG Builder'),
    )!
    option.click()
    await tick()

    expect(onAgentChangeRequestsNewSession).toHaveBeenCalledTimes(1)
    expect(onSelectedAgentChange).toHaveBeenLastCalledWith('kg')
  })
})
