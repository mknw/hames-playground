/**
 * Keystroke / data input for a session's interactive sandbox terminal (#79).
 *
 * POST /api/sandbox/pty/input  { sessionId, data }
 *
 * `data` is written verbatim to the PTY's stdin (raw bytes from xterm's
 * onData — includes control sequences). No-op if no PTY exists for the
 * session (the next stream connect will start one).
 *
 * Ownership: verified via the read gate (`requireSessionOwner`) — a PTY only
 * exists once the stream route has claimed the session, so input never has to
 * claim. A foreign or unknown session gets the same indistinguishable 404.
 */
import type { APIEvent } from '@solidjs/start/server'
import { ptyManager } from '../../../../lib/sandbox/pty-manager.server'
import { requireUserId, requireSessionOwner } from '../../../../lib/stash/http.server'

export async function POST(event: APIEvent) {
  let userId: string
  try {
    userId = await requireUserId()
  } catch (err) {
    return new Response(err instanceof Error ? err.message : 'Unauthorized', { status: 401 })
  }

  const body = (await event.request.json().catch(() => null)) as {
    sessionId?: string
    data?: string
  } | null
  if (!body || !body.sessionId || typeof body.data !== 'string') {
    return new Response('sessionId and data (string) are required', { status: 400 })
  }

  const denied = await requireSessionOwner(body.sessionId, userId)
  if (denied) return denied

  ptyManager.write(body.sessionId, body.data)
  return new Response(null, { status: 204 })
}
