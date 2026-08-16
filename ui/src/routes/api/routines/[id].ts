/**
 * Routines Management API — update + delete (#131)
 *
 *   PATCH  /api/routines/:id  → { routine: RoutineDto }
 *     body: any of { enabled, input, label, trigger + triggerConfig }
 *   DELETE /api/routines/:id  → { deleted: true }
 *
 * `PATCH { enabled }` is the toggle the issue asks for; the other fields come
 * free from the same store call. Every query is scoped by `user_id`, so
 * another user's id is a 404, never a mutation.
 */

import type { APIEvent } from '@solidjs/start/server'
import { getAuthenticatedUser } from '../../../lib/auth/server'
import { BYPASS_USER, isBypassEnabled } from '../../../lib/auth/dev-bypass'
import {
  deleteRoutine,
  updateRoutine,
  type UpdateRoutineInput,
} from '../../../lib/db/routines.server'
import { parseTrigger, RoutineTriggerError } from '../../../lib/routines/triggers'
import { toRoutineDto } from '../../../lib/routines/dto'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function requireUserId(): Promise<string> {
  if (isBypassEnabled()) return BYPASS_USER.id
  return (await getAuthenticatedUser()).id
}

export async function PATCH(event: APIEvent) {
  let userId: string
  try {
    userId = await requireUserId()
  } catch {
    return json({ error: 'Unauthorized' }, 401)
  }

  let body: Record<string, unknown>
  try {
    body = (await event.request.json()) as Record<string, unknown>
  } catch {
    return json({ error: 'JSON body required' }, 400)
  }

  const patch: UpdateRoutineInput = {}
  if (body.enabled !== undefined) patch.enabled = Boolean(body.enabled)
  if (typeof body.input === 'string') {
    const input = body.input.trim()
    if (!input) return json({ error: 'input must not be empty' }, 400)
    patch.input = input
  }
  if (body.label !== undefined) {
    patch.label = typeof body.label === 'string' ? body.label.trim() || null : null
  }
  if (body.trigger !== undefined) {
    try {
      patch.trigger = parseTrigger(String(body.trigger), body.triggerConfig)
    } catch (err) {
      if (err instanceof RoutineTriggerError) return json({ error: err.message }, 400)
      throw err
    }
  }

  const routine = await updateRoutine(event.params.id, userId, patch)
  if (!routine) return json({ error: 'Routine not found' }, 404)
  return json({ routine: toRoutineDto(routine) })
}

export async function DELETE(event: APIEvent) {
  let userId: string
  try {
    userId = await requireUserId()
  } catch {
    return json({ error: 'Unauthorized' }, 401)
  }

  const deleted = await deleteRoutine(event.params.id, userId)
  if (!deleted) return json({ error: 'Routine not found' }, 404)
  return json({ deleted: true })
}
