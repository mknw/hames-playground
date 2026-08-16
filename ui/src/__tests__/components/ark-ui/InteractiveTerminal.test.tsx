/**
 * InteractiveTerminal — the SSE-down / POST-up wiring around xterm (#79).
 *
 * xterm needs a real canvas, so the terminal and the fit addon are stubbed and
 * what is asserted is the contract on either side of them: which URL the stream
 * is opened on, what reaches `term.write`, what is POSTed back, the connection
 * badge, and that an unmount closes everything it opened.
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
  static last: FakeEventSource | undefined
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  close = vi.fn()
  constructor(public url: string) {
    FakeEventSource.last = this
  }
}

let resizeCallback: (() => void) | undefined
const roDisconnect = vi.fn()

const { render } = await import('@solidjs/testing-library')
const { InteractiveTerminal } = await import('../../../components/ark-ui/InteractiveTerminal')

const tick = () => new Promise((r) => setTimeout(r, 10))
const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }))

const badge = (container: HTMLElement) => container.querySelectorAll('span')[1]?.textContent

beforeEach(() => {
  written.length = 0
  dataHandler = undefined
  resizeCallback = undefined
  FakeEventSource.last = undefined
  vi.clearAllMocks()
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
  vi.unstubAllGlobals()
})

describe('InteractiveTerminal', () => {
  it('opens the PTY stream for the session and shows "connecting" until it opens', async () => {
    const { container } = render(() => <InteractiveTerminal sessionId="sess-1" />)
    await tick()

    expect(FakeEventSource.last?.url).toBe('/api/sandbox/pty/stream?sessionId=sess-1')
    expect(badge(container)).toContain('connecting')
  })

  it('forwards the agent id so the server can hydrate /work', async () => {
    render(() => <InteractiveTerminal sessionId="sess 1" agentId="sandbox/data" />)
    await tick()

    expect(FakeEventSource.last?.url).toBe(
      '/api/sandbox/pty/stream?sessionId=sess%201&agentId=sandbox%2Fdata',
    )
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

  it('shows "disconnected" when the stream errors', async () => {
    const { container } = render(() => <InteractiveTerminal sessionId="sess-1" />)
    await tick()

    FakeEventSource.last!.onerror!()
    await tick()

    expect(badge(container)).toContain('disconnected')
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

  it('tears down even when unmounted mid-boot', async () => {
    const { unmount } = render(() => <InteractiveTerminal sessionId="sess-1" />)
    // No await: the dynamic xterm import is still in flight.
    unmount()
    await tick()

    expect(FakeEventSource.last!.close).toHaveBeenCalled()
    expect(disposeTerm).toHaveBeenCalled()
  })
})
