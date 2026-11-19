/**
 * Deployment-global GPU state (Postgres) — Server Only.
 *
 * One row, one boolean: is the self-deployed tier's keep-running switch ON
 * (#1047)? The switch is the owner's answer to a demo — "connect the modal GPU
 * on demand and keep it running" — and the property it needs is that it
 * outlives the browser: a reload, a closed tab, another machine entirely. So
 * the state lives here, in the same Postgres every other cross-process setting
 * of the app lives in, and not in a cookie, `localStorage` or a process-local
 * flag — a process-local switch would silently turn itself off on the next
 * deploy, which is the one outcome an "until I switch it off" control must
 * not have.
 *
 * Deployment-GLOBAL rather than per-user, on purpose: the box it keeps warm is
 * one shared deployment, so the switch is a fact about the deployment, not a
 * preference of whoever last clicked it. Any admin may flip it; every user's
 * turns see the same warm box either way.
 *
 * The row carries no user content, so nothing here is encrypted — the switch
 * and the timestamp are lifted plaintext values like `kind`/`status` elsewhere,
 * and the table is deliberately not in `ENCRYPTED_TABLES`. Who flipped the
 * switch is not recorded: the panel is admin-gated server-side, and an email
 * column would put PII on a table that needs none.
 *
 * Schema bootstraps idempotently on first use (mirrors `user-prefs.server.ts`
 * and `session-store.server.ts`), so no shared migration file is touched and
 * the release run needs no migration step.
 *
 * Deliberately NOT a `'use server'` module: both functions would be browser
 * RPCs, and the setter must sit behind the admin gate — the gate lives in
 * `harness-client/gpu-admin.server.ts`, which resolves the caller from the
 * session and refuses non-admins before anything here is reached.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { query } from './client.server'

assertServerOnImport()

const SCHEMA_SQL = `
  -- One row, ever: a deployment-global switch, not a per-user preference.
  -- The CHECK makes the "single row" property a schema constraint rather
  -- than a convention every writer has to remember.
  CREATE TABLE IF NOT EXISTS gpu_state (
    id             INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    keep_running   BOOLEAN NOT NULL DEFAULT FALSE,
    switched_on_at TIMESTAMPTZ,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
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

/** The switch and when it was last turned on. `switchedOnAt` is null when the
 *  switch is off — "running since" is a claim only an ON switch can make. */
export interface GpuState {
  keepRunning: boolean
  switchedOnAt: number | null
}

const NOT_RUNNING: GpuState = { keepRunning: false, switchedOnAt: null }

/** Read the deployment's switch. A missing row is OFF — the state a fresh
 *  database starts in, and the state a wiped table must degrade to rather
 *  than throw, because "off" is the behaviour that bills nobody. */
export async function getGpuState(): Promise<GpuState> {
  await ensureSchema()
  const { rows } = await query<{ keep_running: boolean; switched_on_at: Date | null }>(
    'SELECT keep_running, switched_on_at FROM gpu_state WHERE id = 1',
  )
  const row = rows[0]
  if (!row) return NOT_RUNNING
  return {
    keepRunning: row.keep_running === true,
    switchedOnAt: row.switched_on_at ? row.switched_on_at.getTime() : null,
  }
}

/**
 * Set the switch. Turning ON stamps `switched_on_at` (the "running since"
 * figure the admin panel shows); turning ON when it is already on keeps the
 * ORIGINAL stamp, so an idempotent re-flip does not reset the clock the cost
 * figure is derived from. Turning OFF clears the stamp — the panel shows
 * "running since" only while the switch is on, and a leftover timestamp on an
 * off row would read as a promise nobody is keeping.
 */
export async function setGpuState(keepRunning: boolean): Promise<GpuState> {
  await ensureSchema()
  const { rows } = await query<{ keep_running: boolean; switched_on_at: Date | null }>(
    `INSERT INTO gpu_state (id, keep_running, switched_on_at, updated_at)
     VALUES (1, $1, CASE WHEN $1 THEN NOW() ELSE NULL END, NOW())
     ON CONFLICT (id) DO UPDATE SET
       keep_running = EXCLUDED.keep_running,
       switched_on_at = CASE
         WHEN EXCLUDED.keep_running THEN COALESCE(gpu_state.switched_on_at, NOW())
         ELSE NULL
       END,
       updated_at = NOW()
     RETURNING keep_running, switched_on_at`,
    [keepRunning],
  )
  const row = rows[0]
  if (!row) return NOT_RUNNING
  return {
    keepRunning: row.keep_running === true,
    switchedOnAt: row.switched_on_at ? row.switched_on_at.getTime() : null,
  }
}
