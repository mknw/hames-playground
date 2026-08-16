/**
 * Routine Scheduler — Server Only (#131)
 *
 * A single process-wide timer that, every tick, asks the trigger registry
 * which enabled routines have come due and fires them. Follows the sweep-timer
 * shape already used by the sandbox idle sweep (#82,
 * `sandbox/attachment-table.server.ts`) and the one-shot startup reaper (#97,
 * `sandbox/with-sandbox.server.ts`): idempotent arming, an `unref()`'d timer so
 * it never keeps the process alive on its own, and a `stop` for teardown.
 *
 * Armed from `src/middleware.ts`, which is imported once when the server
 * handler graph loads — i.e. at server boot, before any request is served.
 *
 * The tick is *kind-agnostic*. It never mentions `'interval'`: it asks
 * `nextDueAt()` per routine, and any trigger kind that returns a timestamp
 * (a future `cron`, say) is scheduled by this same loop with no edit here.
 * `'event'` kinds return null and are skipped — they arrive via
 * `dispatch.server.ts`'s hooks instead.
 *
 * Assumes a persistent node server, exactly like the agent-trigger endpoint it
 * builds on (docs/AGENT_TRIGGER.md). Missed ticks are not backfilled: an
 * interval routine fires at most once per tick, so a process that was down for
 * an hour fires once on the way back up, not sixty times.
 */

import { assertServerOnImport } from '../harness-patterns/assert.server'
import { listEnabledRoutines, type RoutineRow } from '../db/routines.server'
import { nextDueAt } from './triggers'
import { fireRoutine } from './dispatch.server'

assertServerOnImport()

/**
 * How often the sweep runs. Well under the 60s `MIN_INTERVAL_SECONDS` floor so
 * a minute-granularity routine drifts by at most half a tick, and cheap enough
 * (one indexed SELECT) to run indefinitely on an idle server.
 */
export const ROUTINE_TICK_INTERVAL_MS = 30_000

/**
 * The armed timer, parked on `globalThis` rather than in a module-level `let`.
 *
 * Vite's HMR re-evaluates a changed module with fresh module state, so a
 * module-scoped handle is lost on every edit and the old interval keeps
 * running — one extra timer per save. A global key survives re-evaluation, so
 * the guard actually guards.
 */
const ARMED_KEY = Symbol.for('kg-agent.routines.scheduler')

interface ArmedTimer {
  timer: ReturnType<typeof setInterval>
}

type SchedulerGlobal = typeof globalThis & { [ARMED_KEY]?: ArmedTimer }

/**
 * Arm the periodic sweep. Idempotent — a second call (a second import, an HMR
 * reload, a test) is a no-op rather than a second timer.
 */
export function startRoutineScheduler(intervalMs: number = ROUTINE_TICK_INTERVAL_MS): void {
  const g = globalThis as SchedulerGlobal
  if (g[ARMED_KEY]) return

  const timer = setInterval(() => {
    void runRoutineTick().catch((err) => console.error('[routines] tick failed:', err))
  }, intervalMs)
  // Node's Timeout has unref(); guard in case the runtime's return type differs.
  timer.unref?.()
  g[ARMED_KEY] = { timer }
  console.log(`[routines] scheduler armed (tick every ${Math.round(intervalMs / 1000)}s)`)
}

/** Disarm the sweep (idempotent). Teardown / tests. */
export function stopRoutineScheduler(): void {
  const g = globalThis as SchedulerGlobal
  const armed = g[ARMED_KEY]
  if (!armed) return
  clearInterval(armed.timer)
  delete g[ARMED_KEY]
}

/** Whether the sweep is currently armed. */
export function isRoutineSchedulerArmed(): boolean {
  return Boolean((globalThis as SchedulerGlobal)[ARMED_KEY])
}

/**
 * True when this routine's trigger has come due at `now`.
 *
 * The clock starts at `lastRunAt`, falling back to `createdAt` — so a freshly
 * created hourly routine waits an hour rather than firing immediately. A
 * trigger with no schedule (`'event'` kinds) is never due.
 */
export function isDue(routine: RoutineRow, now: number): boolean {
  const since = (routine.lastRunAt ?? routine.createdAt).getTime()
  const due = nextDueAt(routine.trigger, since)
  return due !== null && due <= now
}

/**
 * One sweep: fire every enabled routine that has come due. Returns the run ids
 * started, for tests and logging.
 *
 * Exported so tests can drive it directly under fake timers instead of waiting
 * on the interval. Never throws — a routine that fails is logged and the sweep
 * continues, so one bad row can't stop the scheduler for everyone.
 */
export async function runRoutineTick(now: number = Date.now()): Promise<string[]> {
  let routines: RoutineRow[]
  try {
    routines = await listEnabledRoutines()
  } catch (err) {
    console.error('[routines] could not list routines for this tick:', err)
    return []
  }

  const runIds: string[] = []
  for (const routine of routines) {
    let due: boolean
    try {
      due = isDue(routine, now)
    } catch (err) {
      console.warn(`[routines] routine ${routine.id} has an unusable trigger:`, err)
      continue
    }
    if (!due) continue
    try {
      const runId = await fireRoutine(routine)
      if (runId) runIds.push(runId)
    } catch (err) {
      console.error(`[routines] routine ${routine.id} failed to fire:`, err)
    }
  }
  return runIds
}
