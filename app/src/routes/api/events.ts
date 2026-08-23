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
import type { HarnessSettings } from '../../lib/settings'

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
    settings?: HarnessSettings
  }

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
      const send = (frame: string) => controller.enqueue(encoder.encode(frame))
      try {
        await runTurnAndPersist({
          mode: 'interactive',
          sessionId,
          userId,
          agentId: resolvedAgentId,
          message,
          settings,

          // `sessionId` rides on every envelope so the client can route the
          // event to the right per-session progress controller (#47). Events
          // themselves don't carry sessionId in their typed shape — it's an
          // envelope-only field.
          onEvent: (evt) => send(`data: ${JSON.stringify({ ...evt, sessionId })}\n\n`),

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
          onSettled: () => controller.close(),
        })
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        send(`event: error\ndata: ${JSON.stringify({ sessionId, error: msg })}\n\n`)
        controller.close()
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
