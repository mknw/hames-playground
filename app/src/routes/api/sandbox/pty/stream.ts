/**
 * SSE stream of a session's interactive sandbox terminal (#79), opened in two
 * steps so that no `GET` changes state (#429):
 *
 *   POST /api/sandbox/pty/stream  { sessionId, agentId? }  → { ticket }
 *   GET  /api/sandbox/pty/stream?ticket=<ticket>           → text/event-stream
 *
 * The `POST` is the state change. It claims the session for the caller (the
 * write gate, `claimSession` — the caller claims an unclaimed session id and is
 * verified against an already-owned one, exactly like a stash upload), starts
 * the shell (booting the container on first use), and answers with a
 * single-use ticket (`lib/auth/pty-ticket.server.ts`).
 *
 * The `GET` is a read. It spends the ticket, replays the current scrollback,
 * then streams live PTY output. It never claims and never boots: a ticket is
 * what an authenticated same-origin `POST` hands back, so the only way to a
 * stream is through that `POST`. `EventSource` can only `GET`, which is why the
 * stream is not simply the `POST`'s response.
 *
 * Both check the request came from the app's own pages
 * (`lib/auth/csrf.server.ts`) before anything else.
 *
 * Each frame is `data: <json-string>` — the raw PTY bytes are JSON-encoded so
 * control chars / newlines survive the SSE line protocol; the client
 * `JSON.parse`s and writes straight into xterm. Keystrokes go the other way via
 * POST /api/sandbox/pty/input.
 *
 * A foreign session gets the same 404 an absent one would, so the two are
 * indistinguishable from outside.
 */
import type { APIEvent } from '@solidjs/start/server'
import { ptyManager } from '@hames-ai/sandbox/pty-manager.server'
import { agentUsesSyncWorkspace } from '../../../../lib/harness-client/registry.server'
import { withUser, claimSession, json } from '../../../../lib/stash/http.server'
import { refuseCrossSite } from '../../../../lib/auth/csrf.server'
import { mintPtyTicket, redeemPtyTicket } from '../../../../lib/auth/pty-ticket.server'

export async function POST(event: APIEvent) {
  const refused = refuseCrossSite(event.request)
  if (refused) return refused

  const body = (await event.request.json().catch(() => null)) as {
    sessionId?: unknown
    agentId?: unknown
  } | null
  const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
  const agentId = typeof body?.agentId === 'string' ? body.agentId : null
  if (!sessionId) return json({ error: 'sessionId is required' }, 400)

  return withUser(async (userId) => {
    const denied = await claimSession(sessionId, userId)
    if (denied) return denied

    try {
      // If the session's agent uses durable workspaces, the PtyManager hydrates
      // /work/in when this Shell is the first to boot the container (#97 Gap 3).
      // Best-effort: a capability-resolution hiccup must not block the terminal.
      const syncWorkspace = agentId
        ? await agentUsesSyncWorkspace(agentId, sessionId).catch(() => false)
        : false
      await ptyManager.ensure(sessionId, { syncWorkspace, tenantId: userId })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return json({ error: `failed to start sandbox terminal: ${msg}` }, 500)
    }

    return json({ ticket: mintPtyTicket(userId, sessionId) })
  })
}

export async function GET(event: APIEvent) {
  const refused = refuseCrossSite(event.request)
  if (refused) return refused

  const ticket = new URL(event.request.url).searchParams.get('ticket')
  if (!ticket) {
    return new Response('ticket is required: open the terminal with a POST first', {
      status: 400,
    })
  }

  return withUser(async (userId) => {
    const sessionId = redeemPtyTicket(ticket, userId)
    if (!sessionId) {
      return new Response('ticket is invalid, expired or already used', { status: 403 })
    }
    // The shell exited between the POST and this GET. Starting another is the
    // POST's job, so say so rather than stream silence from nothing.
    if (!ptyManager.has(sessionId)) {
      return new Response('the sandbox terminal is no longer running', { status: 410 })
    }
    return streamPty(event, sessionId)
  })
}

function streamPty(event: APIEvent, sessionId: string): Response {
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
