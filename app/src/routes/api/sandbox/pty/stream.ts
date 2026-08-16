/**
 * SSE stream of a session's interactive sandbox terminal (#79).
 *
 * GET /api/sandbox/pty/stream?sessionId=<id>
 *
 * Ensures a PTY exists for the session (boots the VM + spawns the shell on
 * first connect), replays the current scrollback, then streams live PTY
 * output. Each frame is `data: <json-string>` — the raw PTY bytes are
 * JSON-encoded so control chars / newlines survive the SSE line protocol;
 * the client `JSON.parse`s and writes straight into xterm.
 *
 * Keystrokes go the other way via POST /api/sandbox/pty/input.
 */
import type { APIEvent } from '@solidjs/start/server'
import { ptyManager } from '../../../../lib/sandbox/pty-manager.server'
import { agentUsesSyncWorkspace } from '../../../../lib/harness-client/registry.server'
import { getAuthenticatedUser } from '../../../../lib/auth/server'
import { isBypassEnabled } from '../../../../lib/auth/dev-bypass'

async function requireAuth(): Promise<void> {
  if (isBypassEnabled()) return
  await getAuthenticatedUser() // throws if unauthenticated
}

export async function GET(event: APIEvent) {
  const url = new URL(event.request.url)
  const sessionId = url.searchParams.get('sessionId')
  const agentId = url.searchParams.get('agentId')
  if (!sessionId) {
    return new Response('sessionId is required', { status: 400 })
  }

  try {
    await requireAuth()
  } catch (err) {
    return new Response(err instanceof Error ? err.message : 'Unauthorized', { status: 401 })
  }

  try {
    // If the session's agent uses durable workspaces, the PtyManager hydrates
    // /work/in when this Shell is the first to boot the container (#97 Gap 3).
    // Best-effort: a capability-resolution hiccup must not block the terminal.
    const syncWorkspace = agentId
      ? await agentUsesSyncWorkspace(agentId, sessionId).catch(() => false)
      : false
    await ptyManager.ensure(sessionId, { syncWorkspace })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return new Response(`failed to start sandbox terminal: ${msg}`, { status: 500 })
  }

  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      const send = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
        } catch {
          /* controller closed mid-write */
        }
      }

      // Redraw the current screen for a freshly-connected (or re-mounted) tab.
      const scrollback = ptyManager.getScrollback(sessionId)
      if (scrollback) send(scrollback)

      const unsubscribe = ptyManager.subscribe(sessionId, send)
      event.request.signal.addEventListener('abort', () => {
        unsubscribe()
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      })
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  })
}
