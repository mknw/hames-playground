/**
 * Routines Repository — Server Only (#131)
 *
 * Persisted routine definitions: "run agent X with input Y when trigger Z
 * fires". One row per routine; the trigger is stored as a `trigger_kind`
 * column (so the scheduler and the session hooks can filter in SQL) plus a
 * `trigger_config` JSONB blob of kind-specific parameters. Adding a trigger
 * kind is a registry entry in `lib/routines/triggers.ts` — never a migration.
 *
 * Schema is bootstrapped idempotently on first use, mirroring
 * `auth/session-store.server.ts` rather than being appended to
 * `db/client.server.ts`'s conversations bootstrap: a new domain owns its own
 * DDL, and `query()` still runs the shared init first.
 */

import { assertServerOnImport } from '../harness-patterns/assert.server'
import { query } from './client.server'
import {
  parseTrigger,
  serializeTrigger,
  type RoutineTrigger,
  type RoutineTriggerKind,
} from '../routines/triggers'

assertServerOnImport()

// ============================================================================
// Types
// ============================================================================

export interface RoutineRow {
  id: string
  userId: string
  agentId: string
  /** Rehydrated discriminated union (see `lib/routines/triggers.ts`). */
  trigger: RoutineTrigger
  /** The harness input this routine sends on every run. */
  input: string
  /** Optional human label; also used as the run's sticky conversation title. */
  label: string | null
  enabled: boolean
  /** Last time the routine fired. Null until its first run. */
  lastRunAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface CreateRoutineInput {
  id: string
  userId: string
  agentId: string
  trigger: RoutineTrigger
  input: string
  label?: string | null
  enabled?: boolean
}

export interface UpdateRoutineInput {
  enabled?: boolean
  input?: string
  label?: string | null
  trigger?: RoutineTrigger
}

interface DbRow {
  id: string
  user_id: string
  agent_id: string
  trigger_kind: string
  /** pg returns JSONB columns as already-parsed JS objects. */
  trigger_config: unknown
  input: string
  label: string | null
  enabled: boolean
  last_run_at: Date | null
  created_at: Date
  updated_at: Date
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS routines (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL,
    agent_id       TEXT NOT NULL,
    -- Trigger kind is a plain TEXT column, NOT an enum/CHECK: a new kind must
    -- not require a migration (see lib/routines/triggers.ts). Rows carrying a
    -- kind this build doesn't know are skipped-and-logged on read.
    trigger_kind   TEXT NOT NULL,
    trigger_config JSONB NOT NULL DEFAULT '{}'::jsonb,
    input          TEXT NOT NULL,
    label          TEXT,
    enabled        BOOLEAN NOT NULL DEFAULT TRUE,
    last_run_at    TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS routines_user_created_idx
    ON routines (user_id, created_at DESC);
  -- Serves both the scheduler sweep (kind + enabled, cross-user) and the
  -- session hooks (kind + enabled, then filtered by user_id).
  CREATE INDEX IF NOT EXISTS routines_enabled_kind_idx
    ON routines (enabled, trigger_kind);
`

let _schemaReady: Promise<void> | null = null
function ensureSchema(): Promise<void> {
  if (!_schemaReady) {
    _schemaReady = query(SCHEMA_SQL)
      .then(() => undefined)
      .catch((err) => {
        _schemaReady = null // allow retry on next call
        throw err
      })
  }
  return _schemaReady
}

const SELECT_COLUMNS = `id, user_id, agent_id, trigger_kind, trigger_config, input, label,
                        enabled, last_run_at, created_at, updated_at`

function toRoutine(row: DbRow): RoutineRow {
  return {
    id: row.id,
    userId: row.user_id,
    agentId: row.agent_id,
    trigger: parseTrigger(row.trigger_kind, row.trigger_config),
    input: row.input,
    label: row.label,
    enabled: row.enabled,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/**
 * Map rows, dropping (and logging) any whose trigger this build can't parse.
 * That's an unknown `trigger_kind` written by a newer deploy, or a config blob
 * that no longer validates — neither should take down a whole listing.
 */
function toRoutines(rows: DbRow[]): RoutineRow[] {
  const out: RoutineRow[] = []
  for (const row of rows) {
    try {
      out.push(toRoutine(row))
    } catch (err) {
      console.warn(
        `[routines] skipping routine ${row.id} with unreadable trigger ` + `'${row.trigger_kind}':`,
        err instanceof Error ? err.message : err,
      )
    }
  }
  return out
}

// ============================================================================
// CRUD — user-scoped
// ============================================================================

export async function createRoutine(input: CreateRoutineInput): Promise<RoutineRow> {
  await ensureSchema()
  const { rows } = await query<DbRow>(
    `INSERT INTO routines
       (id, user_id, agent_id, trigger_kind, trigger_config, input, label, enabled)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
     RETURNING ${SELECT_COLUMNS}`,
    [
      input.id,
      input.userId,
      input.agentId,
      input.trigger.kind,
      JSON.stringify(serializeTrigger(input.trigger)),
      input.input,
      input.label ?? null,
      input.enabled ?? true,
    ],
  )
  return toRoutine(rows[0])
}

/** A user's routines, newest-created first. */
export async function listRoutines(userId: string): Promise<RoutineRow[]> {
  await ensureSchema()
  const { rows } = await query<DbRow>(
    `SELECT ${SELECT_COLUMNS} FROM routines WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200`,
    [userId],
  )
  return toRoutines(rows)
}

/** One routine, scoped to its owner. Null when unknown or someone else's. */
export async function getRoutine(id: string, userId: string): Promise<RoutineRow | null> {
  await ensureSchema()
  const { rows } = await query<DbRow>(
    `SELECT ${SELECT_COLUMNS} FROM routines WHERE id = $1 AND user_id = $2`,
    [id, userId],
  )
  return rows.length ? toRoutine(rows[0]) : null
}

/**
 * Patch a routine. Only the provided fields are written; an empty patch is a
 * no-op read. Scoped by `user_id`, so a wrong owner returns null rather than
 * mutating someone else's row. Returns the updated row.
 */
export async function updateRoutine(
  id: string,
  userId: string,
  patch: UpdateRoutineInput,
): Promise<RoutineRow | null> {
  await ensureSchema()

  const sets: string[] = []
  const params: unknown[] = [id, userId]
  const push = (clause: string, value: unknown): void => {
    params.push(value)
    sets.push(`${clause} = $${params.length}`)
  }

  if (patch.enabled !== undefined) push('enabled', patch.enabled)
  if (patch.input !== undefined) push('input', patch.input)
  if (patch.label !== undefined) push('label', patch.label)
  if (patch.trigger !== undefined) {
    push('trigger_kind', patch.trigger.kind)
    params.push(JSON.stringify(serializeTrigger(patch.trigger)))
    sets.push(`trigger_config = $${params.length}::jsonb`)
    // A changed schedule should take effect from now, not retroactively fire
    // for the window that elapsed under the old one.
    sets.push('last_run_at = NULL')
  }

  if (sets.length === 0) return getRoutine(id, userId)

  const { rows } = await query<DbRow>(
    `UPDATE routines SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $1 AND user_id = $2
     RETURNING ${SELECT_COLUMNS}`,
    params,
  )
  return rows.length ? toRoutine(rows[0]) : null
}

/** Delete a routine. Returns false when the id isn't the user's. */
export async function deleteRoutine(id: string, userId: string): Promise<boolean> {
  await ensureSchema()
  const { rowCount } = await query('DELETE FROM routines WHERE id = $1 AND user_id = $2', [
    id,
    userId,
  ])
  return (rowCount ?? 0) > 0
}

// ============================================================================
// Trigger evaluation — cross-user, callers are the scheduler + session hooks
// ============================================================================

/**
 * Every enabled routine, optionally narrowed to one trigger kind.
 *
 * Deliberately NOT user-scoped: the interval scheduler is a process-wide sweep
 * with no request identity. Each row carries its own `userId`, which is what
 * the run executes as — so no cross-user leakage follows from the wide read.
 * Never expose this through a route.
 */
export async function listEnabledRoutines(kind?: RoutineTriggerKind): Promise<RoutineRow[]> {
  await ensureSchema()
  const { rows } = kind
    ? await query<DbRow>(
        `SELECT ${SELECT_COLUMNS} FROM routines
         WHERE enabled = TRUE AND trigger_kind = $1 ORDER BY created_at`,
        [kind],
      )
    : await query<DbRow>(
        `SELECT ${SELECT_COLUMNS} FROM routines WHERE enabled = TRUE ORDER BY created_at`,
      )
  return toRoutines(rows)
}

/** Enabled routines of one kind belonging to one user (the session hooks). */
export async function listEnabledRoutinesForUser(
  userId: string,
  kind: RoutineTriggerKind,
): Promise<RoutineRow[]> {
  await ensureSchema()
  const { rows } = await query<DbRow>(
    `SELECT ${SELECT_COLUMNS} FROM routines
     WHERE enabled = TRUE AND user_id = $1 AND trigger_kind = $2 ORDER BY created_at`,
    [userId, kind],
  )
  return toRoutines(rows)
}

/**
 * Compare-and-set claim on a routine's `last_run_at`, taken immediately before
 * firing it. Returns false when the row moved underneath us — i.e. someone
 * else already fired this tick.
 *
 * This is what makes double-firing structurally impossible rather than merely
 * unlikely: a second app instance, an HMR reload that re-armed the timer, or
 * an overlapping tick all lose the CAS and skip. `IS NOT DISTINCT FROM` (not
 * `=`) so the NULL of a never-run routine compares correctly.
 *
 * The stored value is deliberately millisecond-precision, not raw `NOW()`.
 * Postgres keeps a TIMESTAMPTZ to the microsecond, but `pg` hands JavaScript a
 * `Date`, which only holds milliseconds — so a `last_run_at` read back through
 * a `RoutineRow` and passed here as `$2` never equals the microsecond value
 * still in the column, and the CAS could only ever match on the NULL of a
 * never-run routine. Every routine fired exactly once and then jammed. Storing
 * `date_trunc('milliseconds', ...)` makes the value survive the
 * Postgres -> JS -> Postgres round trip intact.
 *
 * `GREATEST(..., last_run_at + 1ms)` then forces the timestamp to advance
 * strictly, so two claimants that read the same value inside a single
 * millisecond still cannot both win. `GREATEST` ignores NULLs, so the
 * never-run case takes the truncated `NOW()`.
 */
export async function claimRoutineRun(id: string, lastRunAt: Date | null): Promise<boolean> {
  await ensureSchema()
  const { rowCount } = await query(
    `UPDATE routines
        SET last_run_at = GREATEST(date_trunc('milliseconds', NOW()),
                                   last_run_at + interval '1 millisecond'),
            updated_at = NOW()
      WHERE id = $1 AND enabled = TRUE AND last_run_at IS NOT DISTINCT FROM $2`,
    [id, lastRunAt],
  )
  return (rowCount ?? 0) > 0
}
