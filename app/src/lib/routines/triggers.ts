/**
 * Routine Triggers — the extensible trigger registry (#131).
 *
 * A routine is "run this agent, with this input, when X happens". `X` is a
 * *trigger*: a discriminated union whose members are declared once, here, in
 * {@link TRIGGER_SPECS}. Everything downstream (store, scheduler, session
 * hooks, API routes, UI) dispatches through the registry rather than switching
 * on the kind — so adding `webhook` or `threshold` later is one entry in this
 * file plus whatever fires it, and zero edits to the modules below.
 *
 * Two firing modes, declared per kind via `fires`:
 *   - `'schedule'` — the interval scheduler evaluates `nextDueAt()` on each
 *     tick and fires when it comes due (`interval`; a future `cron` fits here).
 *   - `'event'`    — something else calls the dispatcher with the kind
 *     (`session_start` / `session_end`; a future `webhook` fits here).
 *     `nextDueAt()` returns `null` so the scheduler never touches them.
 *
 * Persistence shape: the kind lives in its own `trigger_kind` column (so the
 * scheduler and the hooks can filter in SQL) and the kind-specific parameters
 * live in a `trigger_config` JSONB blob, produced by `serialize()` and read
 * back by `parse()`. A new kind therefore needs no migration.
 *
 * This module is deliberately dependency-free (no `.server` imports) so the
 * API routes, the store, and any future client-side form can all share it.
 */

// ============================================================================
// The union
// ============================================================================

/** Fires every `intervalSeconds`, measured from the last run (or creation). */
export interface IntervalTrigger {
  kind: 'interval'
  intervalSeconds: number
}

/** Fires when the owning user signs in (a new `auth_sessions` row). */
export interface SessionStartTrigger {
  kind: 'session_start'
}

/** Fires when the owning user signs out (their `auth_sessions` row is deleted). */
export interface SessionEndTrigger {
  kind: 'session_end'
}

export type RoutineTrigger = IntervalTrigger | SessionStartTrigger | SessionEndTrigger

export type RoutineTriggerKind = RoutineTrigger['kind']

/** How a trigger reaches the dispatcher. */
export type TriggerFiring = 'schedule' | 'event'

/** Thrown by {@link parseTrigger} on an unknown kind or invalid config. */
export class RoutineTriggerError extends Error {}

// ============================================================================
// Registry
// ============================================================================

/**
 * One entry per trigger kind. `parse`/`serialize`/`nextDueAt` all take and
 * return the full union (rather than the narrowed member) so the registry is
 * a plain, non-generic record — callers can look up a spec by a runtime kind
 * without variance gymnastics. Each implementation narrows internally.
 */
export interface TriggerSpec {
  readonly kind: RoutineTriggerKind
  /** Human label for the management UI / API. */
  readonly label: string
  readonly fires: TriggerFiring
  /** Build the typed trigger from a persisted `trigger_config` blob. */
  parse(config: unknown): RoutineTrigger
  /** The JSON to persist in `trigger_config`. Inverse of {@link parse}. */
  serialize(trigger: RoutineTrigger): Record<string, unknown>
  /**
   * Epoch-ms at which this trigger next comes due, given `since` — the last
   * run's timestamp, or the routine's creation time when it has never run.
   * `null` means "never fires from the scheduler" (every `'event'` kind).
   */
  nextDueAt(trigger: RoutineTrigger, since: number): number | null
}

/**
 * Floor on `intervalSeconds`. A harness run is expensive (LLM calls, tools),
 * so anything sub-minute is a mistake rather than a use case — and the tick
 * itself only runs twice a minute, so a smaller value wouldn't be honoured.
 */
export const MIN_INTERVAL_SECONDS = 60

function asRecord(config: unknown): Record<string, unknown> {
  if (config == null) return {}
  if (typeof config !== 'object' || Array.isArray(config)) {
    throw new RoutineTriggerError('trigger config must be an object')
  }
  return config as Record<string, unknown>
}

/** Shared spec body for the event-driven kinds — no config, never scheduled. */
function eventSpec(kind: RoutineTriggerKind, label: string): TriggerSpec {
  return {
    kind,
    label,
    fires: 'event',
    parse: () => ({ kind }) as RoutineTrigger,
    serialize: () => ({}),
    nextDueAt: () => null,
  }
}

export const TRIGGER_SPECS: Readonly<Record<RoutineTriggerKind, TriggerSpec>> = {
  interval: {
    kind: 'interval',
    label: 'Every N seconds',
    fires: 'schedule',
    parse(config) {
      const raw = asRecord(config).intervalSeconds
      const seconds = typeof raw === 'string' ? Number(raw) : raw
      if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
        throw new RoutineTriggerError('interval trigger requires a numeric intervalSeconds')
      }
      const rounded = Math.floor(seconds)
      if (rounded < MIN_INTERVAL_SECONDS) {
        throw new RoutineTriggerError(`intervalSeconds must be at least ${MIN_INTERVAL_SECONDS}`)
      }
      return { kind: 'interval', intervalSeconds: rounded }
    },
    serialize(trigger) {
      return trigger.kind === 'interval' ? { intervalSeconds: trigger.intervalSeconds } : {}
    },
    nextDueAt(trigger, since) {
      if (trigger.kind !== 'interval') return null
      return since + trigger.intervalSeconds * 1000
    },
  },
  session_start: eventSpec('session_start', 'When I sign in'),
  session_end: eventSpec('session_end', 'When I sign out'),
}

/** Every registered kind, in declaration order. */
export const TRIGGER_KINDS = Object.keys(TRIGGER_SPECS) as RoutineTriggerKind[]

export function isTriggerKind(value: unknown): value is RoutineTriggerKind {
  return typeof value === 'string' && value in TRIGGER_SPECS
}

/**
 * Look up a spec by a runtime kind. Throws {@link RoutineTriggerError} for an
 * unregistered kind — which is what a row written by a *newer* build (a kind
 * this process doesn't know) looks like; callers that iterate stored rows are
 * expected to skip-and-log rather than crash.
 */
export function getTriggerSpec(kind: string): TriggerSpec {
  if (!isTriggerKind(kind)) {
    throw new RoutineTriggerError(`Unknown routine trigger kind: ${kind}`)
  }
  return TRIGGER_SPECS[kind]
}

/** Rehydrate a persisted `(trigger_kind, trigger_config)` pair. */
export function parseTrigger(kind: string, config: unknown): RoutineTrigger {
  return getTriggerSpec(kind).parse(config)
}

/** The `trigger_config` blob for a trigger. */
export function serializeTrigger(trigger: RoutineTrigger): Record<string, unknown> {
  return getTriggerSpec(trigger.kind).serialize(trigger)
}

/** See {@link TriggerSpec.nextDueAt}. */
export function nextDueAt(trigger: RoutineTrigger, since: number): number | null {
  return getTriggerSpec(trigger.kind).nextDueAt(trigger, since)
}

/** True when the interval scheduler owns this kind. */
export function isScheduled(trigger: RoutineTrigger): boolean {
  return getTriggerSpec(trigger.kind).fires === 'schedule'
}
