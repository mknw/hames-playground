/**
 * Resize a session's interactive sandbox terminal (#79).
 *
 * POST /api/sandbox/pty/resize  { sessionId, cols, rows }
 *
 * Forwarded to the PTY so the in-container shell wraps lines to the browser
 * terminal's dimensions. No-op if no PTY exists for the session.
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
    | { sessionId?: string; cols?: number; rows?: number }
    | null
  if (!body || !body.sessionId || typeof body.cols !== 'number' || typeof body.rows !== 'number') {
    return new Response('sessionId, cols, rows are required', { status: 400 })
  }

  ptyManager.resize(body.sessionId, body.cols, body.rows)
  return new Response(null, { status: 204 })
}
