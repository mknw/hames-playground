/**
 * Routine Dispatch — Server Only (#131)
 *
 * Turns "this routine should run now" into an actual run. Execution goes
 * through the *existing* agent-trigger path — `seedActionRow` +
 * `runAgentInBackground` from `harness-client/action-runner.server.ts` — so a
 * routine run is an ordinary `kind='action'` conversation row (with
 * `source='routine'`), emits ordinary harness events, and shows up in the
 * sidebar's Actions filter with the usual status badge. There is no second
 * execution path to keep in sync. See docs/AGENT_TRIGGER.md and docs/ROUTINES.md.
 *
 * Two entry points, matching the two firing modes in `triggers.ts`:
 *   - {@link fireRoutine}          — one routine, already known to be due
 *     (the scheduler's per-tick call).
 *   - {@link fireRoutinesForEvent} — every enabled routine of an `'event'`
 *     kind belonging to one user (the session-lifecycle hooks).
 *
 * Both are claim-first: `claimRoutineRun` is a compare-and-set on
 * `last_run_at`, so an overlapping tick, a second app instance, or an HMR
 * re-arm can't double-fire the same routine.
 *
 * Deliberately NOT a `"use server"` module: these functions take a `userId`
 * (from the routine row, not from the request), and exposing them as client
 * RPCs would let a caller run an agent as any user — the same reasoning that
 * keeps `action-runner.server.ts` off the RPC surface.
 */

import { assertServerOnImport } from '../harness-patterns/assert.server'
import { newSessionId } from '../session-id'
import { claimRoutineRun, listEnabledRoutinesForUser, type RoutineRow } from '../db/routines.server'
import type { RoutineTriggerKind } from './triggers'

assertServerOnImport()

/** Cap on how many routines one event hook fans out to, as a runaway guard. */
const MAX_ROUTINES_PER_EVENT = 20

/**
 * Default sticky title for a routine run when the routine has no label — the
 * trigger kind plus a truncated input, so the sidebar row is identifiable.
 */
function runTitle(routine: RoutineRow): string {
  if (routine.label?.trim()) return routine.label.trim()
  const input = routine.input.replace(/\s+/g, ' ').trim()
  const head = input.length > 40 ? `${input.slice(0, 40)}…` : input
  return `[${routine.trigger.kind}] ${head}`
}

/**
 * Claim and run one routine. Returns the run id (== conversation row id ==
 * sessionId) when it fired, or null when the claim was lost or the routine
 * couldn't run.
 *
 * The harness run itself is fire-and-forget: this resolves as soon as the row
 * is seeded, so a slow agent never stalls a scheduler tick or a sign-in
 * redirect. The run persists its own result and status on completion.
 */
export async function fireRoutine(routine: RoutineRow): Promise<string | null> {
  // The registry + action-runner imports below are dynamic on purpose. This
  // module is reachable from `src/middleware.ts` (which arms the scheduler at
  // server boot), and a static import would drag the whole harness — every
  // registered agent, BAML clients, MCP tooling — into the middleware's
  // boot-time graph. Loading it lazily, on the first routine that actually
  // fires, keeps boot to the store + the trigger registry.

  // Resolve the agent before claiming: a routine pointing at an agent that was
  // renamed or removed should be a loud no-op, not an action row that can
  // never complete.
  const { getAgent } = await import('../harness-client/registry.server')
  if (!getAgent(routine.agentId)) {
    console.warn(
      `[routines] routine ${routine.id} references unknown agent '${routine.agentId}' — skipping`,
    )
    return null
  }

  const claimed = await claimRoutineRun(routine.id, routine.lastRunAt)
  if (!claimed) return null

  const { seedActionRow, runAgentInBackground } =
    await import('../harness-client/action-runner.server')

  const runId = newSessionId()
  const trigger = {
    transcribedCommand: routine.input,
    shortDescription: runTitle(routine),
    routine: { id: routine.id, trigger: routine.trigger.kind },
  }

  try {
    await seedActionRow(runId, routine.userId, routine.agentId, trigger, 'routine')
  } catch (err) {
    console.error(`[routines] failed to seed run row for routine ${routine.id}:`, err)
    return null
  }

  // Not awaited — same contract as the POST endpoint's background run.
  void runAgentInBackground(runId, routine.userId, routine.input, routine.agentId, trigger)

  console.log(
    `[routines] fired ${routine.trigger.kind} routine ${routine.id} ` +
      `(agent=${routine.agentId}) as run ${runId}`,
  )
  return runId
}

/**
 * Fire every enabled routine of an `'event'` trigger kind owned by `userId`.
 * Returns the run ids that started.
 *
 * Never throws: a routine that fails to fire is logged and the rest still run,
 * because the callers are auth flows (sign-in / sign-out) where a routine
 * problem must not cost the user their session.
 */
export async function fireRoutinesForEvent(
  kind: RoutineTriggerKind,
  userId: string,
): Promise<string[]> {
  let routines: RoutineRow[]
  try {
    routines = await listEnabledRoutinesForUser(userId, kind)
  } catch (err) {
    console.error(`[routines] could not list ${kind} routines for ${userId}:`, err)
    return []
  }
  if (routines.length === 0) return []

  if (routines.length > MAX_ROUTINES_PER_EVENT) {
    console.warn(
      `[routines] ${routines.length} ${kind} routines for ${userId}; ` +
        `firing the first ${MAX_ROUTINES_PER_EVENT}`,
    )
    routines = routines.slice(0, MAX_ROUTINES_PER_EVENT)
  }

  const runIds: string[] = []
  for (const routine of routines) {
    try {
      const runId = await fireRoutine(routine)
      if (runId) runIds.push(runId)
    } catch (err) {
      console.error(`[routines] ${kind} routine ${routine.id} failed to fire:`, err)
    }
  }
  return runIds
}

// ============================================================================
// Session lifecycle hooks
// ============================================================================
//
// Called from the auth routes at the two points where a *user session* really
// begins and ends: the `auth_sessions` row being minted in
// `/api/auth/callback`, and deleted in `/api/auth/logout`. Both wrappers are
// synchronous fire-and-forget — the sign-in redirect must not wait on a
// harness, and a routine failure must never break auth.
//
// Note for dev: with `VITE_DEV_BYPASS_AUTH=true` there is no sign-in or
// sign-out flow, so these hooks never fire. Exercise them against a real
// Entra session (or call `fireRoutinesForEvent` directly).

/** Fire the user's `session_start` routines. Never throws, never awaited. */
export function onSessionStart(userId: string): void {
  void fireRoutinesForEvent('session_start', userId).catch((err) =>
    console.error('[routines] session_start hook failed:', err),
  )
}

/** Fire the user's `session_end` routines. Never throws, never awaited. */
export function onSessionEnd(userId: string): void {
  void fireRoutinesForEvent('session_end', userId).catch((err) =>
    console.error('[routines] session_end hook failed:', err),
  )
}
