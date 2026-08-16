/**
 * Keystroke / data input for a session's interactive sandbox terminal (#79).
 *
 * POST /api/sandbox/pty/input  { sessionId, data }
 *
 * `data` is written verbatim to the PTY's stdin (raw bytes from xterm's
 * onData — includes control sequences). No-op if no PTY exists for the
 * session (the next stream connect will start one).
 */
import type { APIEvent } from '@solidjs/start/server'
import { ptyManager } from '../../../../lib/sandbox/pty-manager.server'
import { getAuthenticatedUser } from '../../../../lib/auth/server'
import { isBypassEnabled } from '../../../../lib/auth/dev-bypass'

async function requireAuth(): Promise<void> {
  if (isBypassEnabled()) return
  await getAuthenticatedUser()
}

export async function POST(event: APIEvent) {
  try {
    await requireAuth()
  } catch (err) {
    return new Response(err instanceof Error ? err.message : 'Unauthorized', { status: 401 })
  }

  const body = (await event.request.json().catch(() => null)) as
    | { sessionId?: string; data?: string }
    | null
  if (!body || !body.sessionId || typeof body.data !== 'string') {
    return new Response('sessionId and data (string) are required', { status: 400 })
  }

  ptyManager.write(body.sessionId, body.data)
  return new Response(null, { status: 204 })
}
