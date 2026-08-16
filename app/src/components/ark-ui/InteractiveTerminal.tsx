/**
 * InteractiveTerminal — xterm.js bound to a session's sandbox PTY (#79).
 *
 * Client-only widget (xterm needs the DOM, so it's all built in onMount with
 * dynamic imports to stay SSR-safe). Transport is SSE-down / POST-up:
 *   - EventSource /api/sandbox/pty/stream?sessionId  -> term.write (JSON-decoded)
 *   - term.onData -> POST /api/sandbox/pty/input { sessionId, data }
 *   - fit + ResizeObserver -> POST /api/sandbox/pty/resize { sessionId, cols, rows }
 *
 * Mounting opens (or attaches to) the session's live sandbox shell; the
 * backend keeps the PTY alive across unmounts (tab switches) and replays
 * scrollback on reconnect, so the shell's cwd/env/processes persist.
 */
import { onMount, onCleanup, createSignal } from 'solid-js'

export interface InteractiveTerminalProps {
  sessionId: string
  /** Active agent id — forwarded to the stream route so the Shell can hydrate
   *  /work for durable-workspace agents on a first boot it triggers (#97 Gap 3). */
  agentId?: string
}

type ConnState = 'connecting' | 'connected' | 'closed'

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

    const postResize = () => {
      try {
        fit.fit()
      } catch {
        /* ignore */
      }
      fetch('/api/sandbox/pty/resize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, cols: term.cols, rows: term.rows }),
      }).catch(() => {})
    }

    // Keystrokes (and pasted control sequences) up.
    const dataSub = term.onData((data) => {
      fetch('/api/sandbox/pty/input', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, data }),
      }).catch(() => {})
    })

    // PTY output down. Each frame is a JSON-encoded raw byte string. Forward
    // the agent id so the server can hydrate /work for durable-workspace agents
    // when this Shell is the first to boot the container (#97 Gap 3).
    const agentId = props.agentId
    const streamUrl =
      `/api/sandbox/pty/stream?sessionId=${encodeURIComponent(sessionId)}` +
      (agentId ? `&agentId=${encodeURIComponent(agentId)}` : '')
    const es = new EventSource(streamUrl)
    es.onopen = () => {
      setState('connected')
      postResize()
    }
    es.onmessage = (ev) => {
      try {
        term.write(JSON.parse(ev.data) as string)
      } catch {
        /* malformed frame; skip */
      }
    }
    es.onerror = () => setState('closed')

    const ro = new ResizeObserver(() => postResize())
    ro.observe(containerRef)

    term.focus()

    const teardown = () => {
      dataSub.dispose()
      es.close()
      ro.disconnect()
      term.dispose()
    }

    // Unmounted while we were still booting/wiring — tear down now.
    if (disposed) {
      teardown()
      return
    }
    dispose = teardown
  })

  return (
    <div flex="~ col" h="full" bg="black" style={{ position: 'relative' }}>
      <div
        flex="~"
        items="center"
        gap="2"
        p="1 3"
        bg="dark-bg-tertiary"
        border="b dark-border-primary"
      >
        <span
          style={{
            width: '8px',
            height: '8px',
            'border-radius': '9999px',
            'background-color':
              state() === 'connected' ? '#10b981' : state() === 'closed' ? '#ef4444' : '#f59e0b',
          }}
        />
        <span text="2xs dark-text-secondary" font="mono">
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
