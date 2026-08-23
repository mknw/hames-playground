/**
 * Resize a session's interactive sandbox terminal (#79).
 *
 * POST /api/sandbox/pty/resize  { sessionId, cols, rows }
 *
 * Forwarded to the PTY so the in-container shell wraps lines to the browser
 * terminal's dimensions. No-op if no PTY exists for the session.
 *
 * Ownership: same read gate as input — see `input.ts`.
 */
import type { APIEvent } from '@solidjs/start/server'
import { ptyManager } from '../../../../lib/sandbox/pty-manager.server'
import { withUser, requireSessionOwner } from '../../../../lib/stash/http.server'

export async function POST(event: APIEvent) {
  return withUser(async (userId) => {
    const body = (await event.request.json().catch(() => null)) as {
      sessionId?: string
      cols?: number
      rows?: number
    } | null
    if (
      !body ||
      !body.sessionId ||
      typeof body.cols !== 'number' ||
      typeof body.rows !== 'number'
    ) {
      return new Response('sessionId, cols, rows are required', { status: 400 })
    }

    const denied = await requireSessionOwner(body.sessionId, userId)
    if (denied) return denied

    ptyManager.resize(body.sessionId, body.cols, body.rows)
    return new Response(null, { status: 204 })
  })
}
