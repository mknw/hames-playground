/**
 * InteractiveTerminal — xterm.js bound to a session's sandbox PTY (#79).
 *
 * Client-only widget (xterm needs the DOM, so it's all built in onMount with
 * dynamic imports to stay SSR-safe). Transport is SSE-down / POST-up:
 *   - POST /api/sandbox/pty/stream { sessionId, agentId } -> { ticket }, then
 *     EventSource /api/sandbox/pty/stream?ticket -> term.write (JSON-decoded)
 *   - term.onData -> POST /api/sandbox/pty/input { sessionId, data }
 *   - fit + ResizeObserver -> POST /api/sandbox/pty/resize { sessionId, cols, rows }
 *
 * The stream opens in two steps because a GET must never start a shell (#429):
 * the POST does that and hands back a single-use ticket for the EventSource.
 * A spent ticket also means EventSource's own reconnect (same URL) can never
 * succeed, so a dropped stream is re-opened here, through a fresh POST.
 *
 * Mounting opens (or attaches to) the session's live sandbox shell; the
 * backend keeps the PTY alive across unmounts (tab switches) and replays
 * scrollback on reconnect, so the shell's cwd/env/processes persist.
 */
import { onMount, onCleanup, createSignal } from 'solid-js'
import { ApiError, openPtyStream, ptyStreamUrl, resizePty, sendPtyInput } from '~/lib/api-client'

export interface InteractiveTerminalProps {
  sessionId: string
  /** Active agent id — forwarded to the stream route so the Shell can hydrate
   *  /work for durable-workspace agents on a first boot it triggers (#97 Gap 3). */
  agentId?: string
}

type ConnState = 'connecting' | 'connected' | 'closed'

/** First re-open delay after a drop; each consecutive failure waits one more step. */
const RECONNECT_STEP_MS = 1_000
/** Consecutive failed re-opens before the tab stays disconnected (~15s of trying). */
const MAX_RECONNECTS = 5

export const InteractiveTerminal = (props: InteractiveTerminalProps) => {
  let containerRef: HTMLDivElement | undefined
  const [state, setState] = createSignal<ConnState>('connecting')

  // Register cleanup SYNCHRONOUSLY — onCleanup called after an `await` inside
  // onMount loses the reactive owner and never runs (Solid warns). We stash
  // the real disposer once async setup finishes; `disposed` covers the case
  // where the component unmounts mid-boot (fast tab switch).
  let disposed = false
  let dispose: (() => void) | undefined
  onCleanup(() => {
    disposed = true
    dispose?.()
  })

  onMount(async () => {
    const [{ Terminal }, { FitAddon }] = await Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
      import('@xterm/xterm/css/xterm.css'),
    ])

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      fontSize: 13,
      theme: { background: '#0a0a0a', foreground: '#e4e4e7', cursor: '#10b981' },
      scrollback: 5000,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    if (!containerRef) return
    term.open(containerRef)
    try {
      fit.fit()
    } catch {
      /* container not sized yet; ResizeObserver will refit */
    }

    const sessionId = props.sessionId
    const agentId = props.agentId

    const postResize = () => {
      try {
        fit.fit()
      } catch {
        /* ignore */
      }
      resizePty(sessionId, term.cols, term.rows).catch(() => {})
    }

    // Keystrokes (and pasted control sequences) up.
    const dataSub = term.onData((data) => {
      sendPtyInput(sessionId, data).catch(() => {})
    })

    // PTY output down. Each frame is a JSON-encoded raw byte string.
    let es: EventSource | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let failures = 0

    const reopenLater = () => {
      setState('closed')
      if (disposed || failures >= MAX_RECONNECTS) return
      failures += 1
      retryTimer = setTimeout(() => void connect(), RECONNECT_STEP_MS * failures)
    }

    const connect = async () => {
      if (disposed) return
      setState('connecting')
      let ticket: string
      try {
        ticket = await openPtyStream(sessionId, agentId)
      } catch (err) {
        if (disposed) return
        if (err instanceof ApiError) {
          // The server answered: a refused session or a shell that failed to
          // start. Asking again would get the same answer.
          setState('closed')
          term.write(`\r\n[sandbox terminal unavailable: ${err.message}]\r\n`)
          return
        }
        reopenLater() // unreachable server — it may be restarting
        return
      }
      if (disposed) return

      const source = new EventSource(ptyStreamUrl(ticket))
      es = source
      source.onopen = () => {
        failures = 0
        setState('connected')
        postResize()
      }
      source.onmessage = (ev) => {
        try {
          term.write(JSON.parse(ev.data) as string)
        } catch {
          /* malformed frame; skip */
        }
      }
      source.onerror = () => {
        source.close()
        reopenLater()
      }
    }

    const ro = new ResizeObserver(() => postResize())
    ro.observe(containerRef)

    term.focus()

    const teardown = () => {
      clearTimeout(retryTimer)
      dataSub.dispose()
      es?.close()
      ro.disconnect()
      term.dispose()
    }

    // Unmounted while we were still booting/wiring — tear down now, before
    // the POST that would start a shell for a tab that is already gone.
    if (disposed) {
      teardown()
      return
    }
    dispose = teardown
    void connect()
  })

  return (
    <div flex="~ col" h="full" bg="black" style={{ position: 'relative' }}>
      <div flex="~" items="center" gap="2" p="1 3" bg="ui-bg-tertiary" border="b ui-border-primary">
        <span
          style={{
            width: '8px',
            height: '8px',
            'border-radius': '9999px',
            'background-color':
              state() === 'connected' ? '#10b981' : state() === 'closed' ? '#ef4444' : '#f59e0b',
          }}
        />
        <span text="2xs ui-text-secondary" font="mono">
          {state() === 'connected'
            ? 'sandbox shell · /work · mcp-only'
            : state() === 'closed'
              ? 'disconnected'
              : 'connecting…'}
        </span>
      </div>
      <div ref={containerRef} style={{ flex: '1', 'min-height': '0', padding: '4px' }} />
    </div>
  )
}
