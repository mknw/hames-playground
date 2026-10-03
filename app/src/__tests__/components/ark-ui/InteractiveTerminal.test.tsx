/**
 * InteractiveTerminal — the SSE-down / POST-up wiring around xterm (#79).
 *
 * xterm needs a real canvas, so the terminal and the fit addon are stubbed and
 * what is asserted is the contract on either side of them: how the stream is
 * opened (a POST for a ticket, then an EventSource on it — #429), what reaches
 * `term.write`, what is POSTed back, the connection badge, how a dropped stream
 * is re-opened, and that an unmount closes everything it opened.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// xterm stubs
// ---------------------------------------------------------------------------
const written: string[] = []
let dataHandler: ((data: string) => void) | undefined
const disposeData = vi.fn()
const disposeTerm = vi.fn()
const fit = vi.fn()

class FakeTerminal {
  cols = 80
  rows = 24
  loadAddon = vi.fn()
  open = vi.fn()
  focus = vi.fn()
  dispose = disposeTerm
  write(chunk: string) {
    written.push(chunk)
  }
  onData(cb: (data: string) => void) {
    dataHandler = cb
    return { dispose: disposeData }
  }
}

vi.mock('@xterm/xterm', () => ({ Terminal: FakeTerminal }))
vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit = fit
  },
}))
vi.mock('@xterm/xterm/css/xterm.css', () => ({}))

// ---------------------------------------------------------------------------
// EventSource + ResizeObserver stubs
// ---------------------------------------------------------------------------
class FakeEventSource {
  static all: FakeEventSource[] = []
  static get last(): FakeEventSource | undefined {
    return FakeEventSource.all.at(-1)
  }
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()
  constructor(public url: string) {
    FakeEventSource.all.push(this)
  }
}

let resizeCallback: (() => void) | undefined
const roDisconnect = vi.fn()

const { render } = await import('@solidjs/testing-library')
const { InteractiveTerminal } = await import('../../../components/ark-ui/InteractiveTerminal')

const tick = () => new Promise((r) => setTimeout(r, 10))

const OPEN_URL = '/api/sandbox/pty/stream'
let ticketSeq = 0
/** The terminal's own server: a ticket per open, `{}` for input/resize. */
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()
const defaultFetch = async (url: string) =>
  url === OPEN_URL
    ? new Response(JSON.stringify({ ticket: `t-${++ticketSeq}` }), { status: 200 })
    : new Response('{}', { status: 200 })

const opens = () => fetchMock.mock.calls.filter(([url]) => url === OPEN_URL)

const badge = (container: HTMLElement) => container.querySelectorAll('span')[1]?.textContent

beforeEach(() => {
  written.length = 0
  dataHandler = undefined
  resizeCallback = undefined
  FakeEventSource.all = []
  ticketSeq = 0
  vi.clearAllMocks()
  fetchMock.mockImplementation(defaultFetch)
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        resizeCallback = cb
      }
      observe() {}
      unobserve() {}
      disconnect = roDisconnect
    },
  )
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('InteractiveTerminal', () => {
  it('opens the terminal with a POST, then streams on the ticket it got back', async () => {
    const { container } = render(() => <InteractiveTerminal sessionId="sess-1" />)
    await tick()

    const [[url, init]] = opens()
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init!.body as string)).toEqual({ sessionId: 'sess-1' })
    // The stream URL carries the ticket and nothing that could start a shell.
    expect(FakeEventSource.last?.url).toBe('/api/sandbox/pty/stream?ticket=t-1')
    expect(url).toBe(OPEN_URL)
    expect(badge(container)).toContain('connecting')
  })

  it('forwards the agent id so the server can hydrate /work', async () => {
    render(() => <InteractiveTerminal sessionId="sess 1" agentId="sandbox/data" />)
    await tick()

    expect(JSON.parse(opens()[0][1]!.body as string)).toEqual({
      sessionId: 'sess 1',
      agentId: 'sandbox/data',
    })
  })

  it('reports the connection and sizes the PTY once the stream opens', async () => {
    const { container } = render(() => <InteractiveTerminal sessionId="sess-1" />)
    await tick()

    FakeEventSource.last!.onopen!()
    await tick()

    expect(badge(container)).toContain('sandbox shell')
    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(url).toBe('/api/sandbox/pty/resize')
    expect(JSON.parse(init.body as string)).toEqual({ sessionId: 'sess-1', cols: 80, rows: 24 })
  })

  it('writes JSON-decoded PTY frames and skips malformed ones', async () => {
    render(() => <InteractiveTerminal sessionId="sess-1" />)
    await tick()

    FakeEventSource.last!.onmessage!({ data: JSON.stringify('hello$ ') })
    FakeEventSource.last!.onmessage!({ data: 'not json' })
    FakeEventSource.last!.onmessage!({ data: JSON.stringify('world\r\n') })

    expect(written).toEqual(['hello$ ', 'world\r\n'])
  })

  it('POSTs keystrokes back to the PTY', async () => {
    render(() => <InteractiveTerminal sessionId="sess-1" />)
    await tick()

    dataHandler!('ls -la\r')

    const [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(url).toBe('/api/sandbox/pty/input')
    expect(JSON.parse(init.body as string)).toEqual({ sessionId: 'sess-1', data: 'ls -la\r' })
  })

  it('refits and reports the new size when the container resizes', async () => {
    render(() => <InteractiveTerminal sessionId="sess-1" />)
    await tick()
    fetchMock.mockClear()
    fit.mockClear()

    resizeCallback!()

    expect(fit).toHaveBeenCalled()
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/sandbox/pty/resize')
  })

  it('shows "disconnected" when the stream errors, and closes that EventSource', async () => {
    const { container } = render(() => <InteractiveTerminal sessionId="sess-1" />)
    await tick()
    const es = FakeEventSource.last!

    es.onerror!()
    await tick()

    expect(badge(container)).toContain('disconnected')
    // Its own reconnect would re-send a spent ticket.
    expect(es.close).toHaveBeenCalled()
  })

  it('re-opens a dropped stream through a fresh POST and a fresh ticket', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { container } = render(() => <InteractiveTerminal sessionId="sess-1" />)
    await vi.advanceTimersByTimeAsync(10)
    FakeEventSource.last!.onopen!()

    FakeEventSource.last!.onerror!()
    await vi.advanceTimersByTimeAsync(1_000)

    expect(opens()).toHaveLength(2)
    expect(FakeEventSource.all.map((es) => es.url)).toEqual([
      '/api/sandbox/pty/stream?ticket=t-1',
      '/api/sandbox/pty/stream?ticket=t-2',
    ])
    FakeEventSource.last!.onopen!()
    await vi.advanceTimersByTimeAsync(10)
    expect(badge(container)).toContain('sandbox shell')
  })

  it('stops re-opening after repeated failures rather than looping forever', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    render(() => <InteractiveTerminal sessionId="sess-1" />)
    await vi.advanceTimersByTimeAsync(10)

    // A stream that never opens: every attempt fails at once.
    for (let i = 0; i < 10; i++) {
      FakeEventSource.last!.onerror!()
      await vi.advanceTimersByTimeAsync(60_000)
    }

    expect(opens()).toHaveLength(6) // the first open + five re-opens
  })

  it('retries the open when the server cannot be reached — it may be restarting', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'))
    render(() => <InteractiveTerminal sessionId="sess-1" />)
    await vi.advanceTimersByTimeAsync(10)
    expect(FakeEventSource.all).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1_000)

    expect(opens()).toHaveLength(2)
    expect(FakeEventSource.last?.url).toBe('/api/sandbox/pty/stream?ticket=t-1')
  })

  it('shows why, and does not retry, when the server refuses to open the terminal', async () => {
    fetchMock.mockImplementation(async (url) =>
      url === OPEN_URL
        ? new Response(
            JSON.stringify({ error: 'failed to start sandbox terminal: docker not running' }),
            { status: 500 },
          )
        : new Response('{}'),
    )
    const { container } = render(() => <InteractiveTerminal sessionId="sess-1" />)
    await tick()
    await tick()

    expect(FakeEventSource.all).toHaveLength(0)
    expect(badge(container)).toContain('disconnected')
    expect(written.join('')).toContain('docker not running')
    expect(opens()).toHaveLength(1)
  })

  it('keeps going when the container is not sized yet', async () => {
    fit.mockImplementationOnce(() => {
      throw new Error('container has no dimensions')
    })
    render(() => <InteractiveTerminal sessionId="sess-1" />)
    await tick()

    expect(FakeEventSource.last, 'the stream still opens').toBeTruthy()
  })

  it('closes the stream and disposes the terminal on unmount', async () => {
    const { unmount } = render(() => <InteractiveTerminal sessionId="sess-1" />)
    await tick()
    const es = FakeEventSource.last!

    unmount()

    expect(es.close).toHaveBeenCalled()
    expect(disposeData).toHaveBeenCalled()
    expect(roDisconnect).toHaveBeenCalled()
    expect(disposeTerm).toHaveBeenCalled()
  })

  it('opens no stream when the tab is unmounted while its POST is in flight', async () => {
    // Teardown has already run by the time the ticket arrives, so a stream
    // opened then would never be closed — and its subscription would cancel
    // the shell's idle clock, holding the container for as long as the page
    // stays open (#451 review).
    let answer!: (res: Response) => void
    fetchMock.mockImplementation((url) =>
      url === OPEN_URL
        ? new Promise<Response>((resolve) => (answer = resolve))
        : Promise.resolve(new Response('{}')),
    )
    const { unmount } = render(() => <InteractiveTerminal sessionId="sess-1" />)
    await tick()
    expect(opens()).toHaveLength(1) // the POST is out

    unmount()
    answer(new Response(JSON.stringify({ ticket: 't-late' }), { status: 200 }))
    await tick()

    expect(FakeEventSource.all).toHaveLength(0)
  })

  it('tears down when unmounted mid-boot, without starting a shell for the gone tab', async () => {
    const { unmount } = render(() => <InteractiveTerminal sessionId="sess-1" />)
    // No await: the dynamic xterm import is still in flight.
    unmount()
    await tick()

    expect(opens()).toHaveLength(0)
    expect(FakeEventSource.all).toHaveLength(0)
    expect(disposeTerm).toHaveBeenCalled()
  })
})
