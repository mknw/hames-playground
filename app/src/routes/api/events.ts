/**
 * SSE Endpoint for Streaming Agent Events
 *
 * Streams ContextEvents in real-time as they are committed during harness execution.
 * Enables reactive UI updates (e.g., graph visualization) without waiting for full completion.
 *
 * The turn itself belongs to `runTurnAndPersist` (`harness-client/turn.server.ts`)
 * — the one implementation shared with the interactive server actions and the
 * triggered runner (#226 C5). This route is only the wire: it authenticates,
 * hands the turn its hooks, and turns each of them into an SSE frame.
 */
import type { APIEvent } from '@solidjs/start/server'
import { runTurnAndPersist } from '../../lib/harness-client/turn.server'
import { getAuthenticatedUser } from '../../lib/auth/server'
import { BYPASS_USER, isBypassEnabled } from '../../lib/auth/dev-bypass'
import { sanitizeHarnessSettings } from '../../lib/settings'
// The heartbeat's interval and frame live in `sse-client.ts`, beside the
// parser that has to ignore them — and because a non-handler export declared
// in a route module is stripped from the build (see SSE_KEEPALIVE_MS there).
import { SSE_KEEPALIVE_FRAME, SSE_KEEPALIVE_MS } from '../../lib/sse-client'

async function requireUserId(): Promise<string> {
  if (isBypassEnabled()) return BYPASS_USER.id
  return (await getAuthenticatedUser()).id
}

export async function POST(event: APIEvent) {
  const body = await event.request.json()
  const { sessionId, message, agentId, settings } = body as {
    sessionId: string
    message: string
    agentId?: string
    settings?: unknown
  }
  // `settings` is request-body data, and every pattern reads it at execution
  // time — so it is clamped here, at the only place it enters the server, rather
  // than trusted. See `sanitizeHarnessSettings`: numbers to the settings panel's
  // own bounds, and the `sandbox` subtree (egress profile, memory cap, wall
  // clock) discarded outright as host policy.
  const safeSettings = sanitizeHarnessSettings(settings)

  if (!sessionId || !message) {
    return new Response(JSON.stringify({ error: 'sessionId and message are required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // This route resolves the user itself: `runTurnAndPersist` takes a `userId`
  // and is deliberately not a `"use server"` RPC, so the authentication is
  // here, at the only entry point.
  let userId: string
  try {
    userId = await requireUserId()
  } catch (err) {
    return new Response(
      JSON.stringify({ error: err instanceof Error ? err.message : 'Unauthorized' }),
      { status: 401, headers: { 'Content-Type': 'application/json' } },
    )
  }
  const resolvedAgentId = agentId ?? 'search'

  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    async start(controller) {
      // `closed` guards every write after `onSettled`: the keep-alive timer
      // and the error path below both outlive the close, and `enqueue` on a
      // closed controller throws.
      let closed = false
      const send = (frame: string) => {
        if (closed) return
        controller.enqueue(encoder.encode(frame))
      }
      // Keeps the connection provably alive across a silent LLM call — see
      // SSE_KEEPALIVE_MS. Cleared in the `finally`, so a turn that throws
      // cannot leave a timer writing into a closed stream.
      const keepalive = setInterval(() => send(SSE_KEEPALIVE_FRAME), SSE_KEEPALIVE_MS)
      try {
        await runTurnAndPersist({
          mode: 'interactive',
          sessionId,
          userId,
          agentId: resolvedAgentId,
          message,
          settings: safeSettings,

          // `sessionId` rides on every envelope so the client can route the
          // event to the right per-session progress controller (#47). Events
          // themselves don't carry sessionId in their typed shape — it's an
          // envelope-only field.
          onEvent: (evt) => send(`data: ${JSON.stringify({ ...evt, sessionId })}\n\n`),

          // The turn is now waiting on a self-hosted box that is not up, and
          // will produce nothing for minutes. A turn-level frame rather than a
          // harness `ContextEvent`: it is a property of this wait, not of the
          // conversation, and must not be persisted into the blob or replayed
          // on reload. The client clears it on the next frame of any kind —
          // see `WarmingEventData`.
          onWarming: (estimate) =>
            send(`event: warming\ndata: ${JSON.stringify({ sessionId, ...estimate })}\n\n`),

          // The final result, as a named event.
          onResult: (result) =>
            send(
              `event: done\ndata: ${JSON.stringify({
                sessionId,
                response: result.response,
                data: result.data,
                status: result.status,
                duration_ms: result.duration_ms,
                context: result.context,
                serialized: result.serialized,
              })}\n\n`,
            ),

          // First-turn title, generated between `done` and close so it can
          // still ride out on this stream.
          onTitle: (title) =>
            send(`event: title_updated\ndata: ${JSON.stringify({ sessionId, title })}\n\n`),

          // Everything the client waits for has been sent. The turn's trailing
          // summarization runs after this, with the user already served.
          onSettled: () => {
            closed = true
            controller.close()
          },
        })
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        send(`event: error\ndata: ${JSON.stringify({ sessionId, error: msg })}\n\n`)
        if (!closed) {
          closed = true
          controller.close()
        }
      } finally {
        clearInterval(keepalive)
      }
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
