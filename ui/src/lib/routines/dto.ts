/**
 * Wire shape for the routines API (#131).
 *
 * Flattens the stored row: `trigger` becomes the kind string and the
 * kind-specific parameters ride alongside in `triggerConfig`, which is exactly
 * the shape `POST /api/routines` accepts — so a client can round-trip a
 * routine without knowing the union's internals. Dates go out as ISO strings
 * (a `Date` doesn't survive JSON).
 */

import { serializeTrigger, type RoutineTriggerKind } from './triggers'

export interface RoutineDto {
  id: string
  agentId: string
  trigger: RoutineTriggerKind
  triggerConfig: Record<string, unknown>
  input: string
  label: string | null
  enabled: boolean
  lastRunAt: string | null
  createdAt: string
}

/** Minimal row shape this mapper needs (structurally satisfied by RoutineRow). */
interface RoutineLike {
  id: string
  agentId: string
  trigger: Parameters<typeof serializeTrigger>[0]
  input: string
  label: string | null
  enabled: boolean
  lastRunAt: Date | null
  createdAt: Date
}

export function toRoutineDto(routine: RoutineLike): RoutineDto {
  return {
    id: routine.id,
    agentId: routine.agentId,
    trigger: routine.trigger.kind,
    triggerConfig: serializeTrigger(routine.trigger),
    input: routine.input,
    label: routine.label,
    enabled: routine.enabled,
    lastRunAt: routine.lastRunAt?.toISOString() ?? null,
    createdAt: routine.createdAt.toISOString(),
  }
}
