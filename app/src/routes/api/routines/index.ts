/**
 * Routines Management API — list + create (#131)
 *
 *   GET  /api/routines   → { routines: RoutineDto[], triggers: [{kind,label,fires}] }
 *   POST /api/routines   → 201 { routine: RoutineDto }
 *     body: { agentId, trigger, triggerConfig?, input, label?, enabled? }
 *
 * Deliberately minimal — the issue scopes management UI polish out, so this
 * pair plus `PATCH`/`DELETE` on `[id].ts` is the whole surface for defining
 * routines. Authenticated as the current Entra user (or the dev bypass) like
 * every other API route: a routine always belongs to, and runs as, its creator.
 *
 * The route never switches on the trigger kind — validation is delegated to
 * `parseTrigger`, so a new kind in `lib/routines/triggers.ts` is accepted here
 * with no edit.
 */

import type { APIEvent } from '@solidjs/start/server'
import { getAuthenticatedUser } from '../../../lib/auth/server'
import { BYPASS_USER, isBypassEnabled } from '../../../lib/auth/dev-bypass'
import { getAgent } from '../../../lib/harness-client/registry.server'
import { createRoutine, listRoutines } from '../../../lib/db/routines.server'
import {
  parseTrigger,
  RoutineTriggerError,
  TRIGGER_KINDS,
  TRIGGER_SPECS,
  type RoutineTrigger,
} from '../../../lib/routines/triggers'
import { toRoutineDto } from '../../../lib/routines/dto'
import { newSessionId } from '../../../lib/session-id'

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

export async function GET() {
  let userId: string
  try {
    userId = await requireUserId()
  } catch {
    return json({ error: 'Unauthorized' }, 401)
  }

  const routines = await listRoutines(userId)
  return json({
    routines: routines.map(toRoutineDto),
    // The kinds this build understands, so a form can be built without the
    // client hardcoding the union.
    triggers: TRIGGER_KINDS.map((kind) => ({
      kind,
      label: TRIGGER_SPECS[kind].label,
      fires: TRIGGER_SPECS[kind].fires,
    })),
  })
}

export async function POST(event: APIEvent) {
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

  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() : ''
  const input = typeof body.input === 'string' ? body.input.trim() : ''
  const label = typeof body.label === 'string' ? body.label.trim() || null : null

  if (!agentId) return json({ error: 'agentId is required' }, 400)
  if (!input) return json({ error: 'input is required' }, 400)
  if (!getAgent(agentId)) return json({ error: `Unknown agent: ${agentId}` }, 400)

  let trigger: RoutineTrigger
  try {
    trigger = parseTrigger(String(body.trigger ?? ''), body.triggerConfig)
  } catch (err) {
    if (err instanceof RoutineTriggerError) return json({ error: err.message }, 400)
    throw err
  }

  const routine = await createRoutine({
    id: newSessionId(),
    userId,
    agentId,
    trigger,
    input,
    label,
    enabled: body.enabled === undefined ? true : Boolean(body.enabled),
  })
  return json({ routine: toRoutineDto(routine) }, 201)
}
