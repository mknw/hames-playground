/**
 * Backfill: encrypt rows written before at-rest encryption existed — Server Only.
 *
 * ## Trigger
 *
 * Called from `client.server.ts`'s `initSchema()`, i.e. once per process on the
 * first `query()` — the same schema-ensure path that owns every other
 * idempotent DDL step, so there is no separate script an operator can forget to
 * run. That choice is what discharges "boot must never eat plaintext rows
 * silently": the alternative (encrypt-on-write only) leaves a table that is
 * half ciphertext for as long as nobody re-saves the old rows, and nothing in
 * the system ever says so.
 *
 * ## Idempotence
 *
 * The version prefix is the whole mechanism. A TEXT column is due when it is
 * `NOT NULL AND NOT LIKE 'v1.%'`; a JSONB column is due when
 * `jsonb_typeof(col) <> 'string'` (an envelope is stored as a JSON string
 * scalar, a legacy blob is an object). After the first pass every predicate
 * matches zero rows, so a boot costs one cheap `SELECT ... LIMIT` per table.
 * Each `UPDATE` re-checks the same predicate in its `WHERE`, so two processes
 * booting at once cannot double-encrypt: the loser's write affects no rows.
 *
 * ## Table discovery
 *
 * Every table is guarded by `to_regclass`, because the auth and routine
 * schemas bootstrap lazily from their own modules — at the moment this runs,
 * `users` / `auth_sessions` / `routines` may not exist yet in a fresh
 * database. When a table is absent it is also, necessarily, empty of legacy
 * rows: this build always encrypts on write, so a table created after this
 * point never needs a backfill.
 *
 * ## The runner argument
 *
 * These functions take a query runner instead of importing `query()` from
 * `client.server.ts`. That is not decoration: `query()` awaits the schema-init
 * promise, and this code runs *inside* that promise, so calling it would
 * deadlock the pool on itself. `client.server.ts` hands in a direct
 * `pool.query` binding.
 */
import { assertServerOnImport } from '../harness-patterns/assert.server'
import {
  DATA_KEY_ENV,
  DataDecryptionError,
  ENCRYPTED_SQL,
  NOT_ENCRYPTED_SQL,
  decryptField,
  encryptField,
  encryptJsonb,
  hasDataEncryptionKey,
  looksEncrypted,
} from './crypto.server'

assertServerOnImport()

/**
 * A boot gate said no: the key is missing with ciphertext present, or it does
 * not open what is stored.
 *
 * Typed so `client.server.ts` can tell it apart from a transient init failure.
 * Nothing about a key mismatch fixes itself on the next request, so this one is
 * **not** retried — see the comment on `_initPromise`.
 */
export class EncryptionBootError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EncryptionBootError'
  }
}

/** Minimal shape of `pg.Pool#query` this module needs. */
export type QueryRunner = (
  text: string,
  params?: unknown[],
) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>

/** How many rows are converted per round trip. */
export const MIGRATION_BATCH_SIZE = 100

/**
 * Upper bound on batches per table per boot. A batch that selected rows always
 * writes them (the SQL predicate and the encrypt step agree on what is due), so
 * this can only be reached by a genuinely large legacy table — in which case
 * the next boot continues. It exists so a predicate bug degrades into a logged
 * stall instead of an unbounded loop holding up boot.
 */
export const MIGRATION_MAX_BATCHES = 500

interface TableSpec {
  table: string
  /** Primary key column, used to address rows for the UPDATE. */
  pk: string
  /** TEXT columns holding a `v1.` envelope. */
  textColumns: string[]
  /** JSONB columns holding the envelope as a JSON string scalar. */
  jsonbColumns: string[]
}

/**
 * What gets encrypted, and nothing else. The rationale per column lives in the
 * PR's inventory table; the short version is that everything absent here is
 * either an identifier a join or index needs in the clear (`user_id`,
 * `session_id`, the opaque session `id`), an enum the app filters on in SQL
 * (`kind`, `source`, `status`, `trigger_kind`, `enabled`), a timestamp, or a
 * value that is not personal data (`agent_id`, `tid`).
 */
export const ENCRYPTED_TABLES: readonly TableSpec[] = [
  { table: 'conversations', pk: 'id', textColumns: ['title'], jsonbColumns: ['context'] },
  { table: 'auth_sessions', pk: 'id', textColumns: ['email', 'display_name'], jsonbColumns: [] },
  { table: 'users', pk: 'id', textColumns: ['email', 'display_name'], jsonbColumns: [] },
  { table: 'routines', pk: 'id', textColumns: ['input', 'label'], jsonbColumns: [] },
]

/** Per-table outcome. `absent` tables were skipped, not counted. */
export interface TableMigrationResult {
  table: string
  absent: boolean
  rowsEncrypted: number
  batches: number
  /** True when the batch ceiling was hit and rows remain for the next boot. */
  incomplete: boolean
}

export interface EncryptionMigrationReport {
  tables: TableMigrationResult[]
  totalRowsEncrypted: number
}

/** Not-an-envelope for TEXT (see `NOT_ENCRYPTED_SQL`), `jsonb_typeof <> 'string'` for JSONB. */
function duePredicate(spec: TableSpec): string {
  const clauses = [
    ...spec.textColumns.map((c) => `(${NOT_ENCRYPTED_SQL(c)})`),
    ...spec.jsonbColumns.map((c) => `(jsonb_typeof(${c}) <> 'string')`),
  ]
  return clauses.join(' OR ')
}

async function tableExists(run: QueryRunner, table: string): Promise<boolean> {
  const { rows } = await run(`SELECT to_regclass($1) AS oid`, [`public.${table}`])
  return rows[0]?.oid != null
}

async function migrateTable(run: QueryRunner, spec: TableSpec): Promise<TableMigrationResult> {
  const result: TableMigrationResult = {
    table: spec.table,
    absent: false,
    rowsEncrypted: 0,
    batches: 0,
    incomplete: false,
  }
  if (!(await tableExists(run, spec.table))) {
    result.absent = true
    return result
  }

  const due = duePredicate(spec)
  // `jsonb_typeof` comes along so SQL NULL and JSON `null` stay distinguishable:
  // `pg` hands both to JavaScript as `null`, and encrypting the second over the
  // first would write `"null"` on top of an absent value. Unreachable today
  // (`context` is `NOT NULL`), and selected rather than reasoned about so the
  // first nullable JSONB column added here does not have to rediscover it.
  const selectColumns = [
    spec.pk,
    ...spec.textColumns,
    ...spec.jsonbColumns.flatMap((c) => [c, `jsonb_typeof(${c}) AS "${c}__type"`]),
  ].join(', ')

  for (let batch = 0; batch < MIGRATION_MAX_BATCHES; batch++) {
    const { rows } = await run(
      `SELECT ${selectColumns} FROM ${spec.table} WHERE ${due} LIMIT ${MIGRATION_BATCH_SIZE}`,
    )
    if (rows.length === 0) return result
    result.batches++
    let attempted = 0

    for (const row of rows) {
      const sets: string[] = []
      const params: unknown[] = [row[spec.pk]]
      for (const col of spec.textColumns) {
        const value = row[col]
        if (typeof value !== 'string' || looksEncrypted(value)) continue
        params.push(encryptField(value))
        sets.push(`${col} = $${params.length}`)
      }
      for (const col of spec.jsonbColumns) {
        const jsonType = row[`${col}__type`]
        // SQL NULL (no `jsonb_typeof`) is absent, not empty — leave it alone.
        // A JSON string is already an envelope.
        if (jsonType == null || jsonType === 'string') continue
        params.push(encryptJsonb(JSON.stringify(row[col] ?? null)))
        sets.push(`${col} = $${params.length}::jsonb`)
      }
      if (sets.length === 0) continue
      attempted++
      // Predicate repeated in the WHERE so a concurrent booter's write wins
      // once rather than both of us encrypting the same row.
      const { rowCount } = await run(
        `UPDATE ${spec.table} SET ${sets.join(', ')} WHERE ${spec.pk} = $1 AND (${due})`,
        params,
      )
      result.rowsEncrypted += rowCount ?? 0
    }

    // A batch that selected rows and wrote none of them means the SQL predicate
    // and the JS skip have stopped agreeing — the one way this loop could spin
    // until the ceiling. Counted as *writes attempted*, not rows changed, so a
    // concurrent booter winning every row (a 0-row UPDATE, by design) is not
    // mistaken for it. Stop on the first such batch and say so, instead of
    // re-reading the same 100 rows 500 times.
    if (attempted === 0) {
      console.warn(
        `[db] ${spec.table}: ${rows.length} row(s) match the backfill predicate but none were ` +
          'convertible — stopping this table. The SQL predicate and the encrypted-shape check ' +
          'disagree; this is a bug in crypto.server.ts, not a data problem.',
      )
      result.incomplete = true
      return result
    }
  }
  result.incomplete = true
  return result
}

/**
 * Encrypt every legacy plaintext value in {@link ENCRYPTED_TABLES}. Requires a
 * key; call {@link hasDataEncryptionKey} first if that is in doubt.
 */
export async function encryptExistingRows(run: QueryRunner): Promise<EncryptionMigrationReport> {
  const tables: TableMigrationResult[] = []
  for (const spec of ENCRYPTED_TABLES) {
    tables.push(await migrateTable(run, spec))
  }
  const totalRowsEncrypted = tables.reduce((n, t) => n + t.rowsEncrypted, 0)
  return { tables, totalRowsEncrypted }
}

/** One stored envelope per encrypted column, for the boot probes. */
export interface EncryptedSample {
  /** `table.column`. */
  where: string
  /** The envelope as stored. */
  value: string
}

/**
 * Sample one envelope from every encrypted column that currently holds any.
 *
 * A JSONB envelope is selected as the column, not via `#>> '{}'`, and comes back
 * as a JS string because `pg` parses a JSONB string scalar that way — the same
 * property the read path in `crypto.server.ts` already relies on. Extracting it
 * as text here instead would make the probe *more* tolerant than the reads it is
 * gating, so a driver-level change would pass the boot gate and then fail every
 * request. Sharing the assumption means the gate fails whenever the reads would.
 */
export async function sampleEncryptedColumns(run: QueryRunner): Promise<EncryptedSample[]> {
  const found: EncryptedSample[] = []
  for (const spec of ENCRYPTED_TABLES) {
    if (!(await tableExists(run, spec.table))) continue
    for (const col of spec.textColumns) {
      const { rows } = await run(
        `SELECT ${col} AS sample FROM ${spec.table}
          WHERE ${ENCRYPTED_SQL(col)} LIMIT 1`,
      )
      const sample = rows[0]?.sample
      // Structural on both sides: SQL selects by the envelope's shape and JS
      // confirms with the same rule, so a plaintext title that merely starts
      // `v1.` is not reported as stored ciphertext. That false positive told an
      // operator to restore a key that had never existed.
      if (looksEncrypted(sample)) found.push({ where: `${spec.table}.${col}`, value: sample })
    }
    for (const col of spec.jsonbColumns) {
      const { rows } = await run(
        `SELECT ${col} AS sample FROM ${spec.table}
          WHERE jsonb_typeof(${col}) = 'string' LIMIT 1`,
      )
      const sample = rows[0]?.sample
      if (looksEncrypted(sample)) found.push({ where: `${spec.table}.${col}`, value: sample })
    }
  }
  return found
}

/** `table.column` pairs that currently hold at least one envelope. */
export async function findEncryptedColumns(run: QueryRunner): Promise<string[]> {
  return (await sampleEncryptedColumns(run)).map((s) => s.where)
}

/**
 * Boot probe: does the configured key actually open what is stored?
 *
 * Without this, a wrong or rotated key is discovered per request, and one of
 * those requests is the session read — which sits behind two deliberately
 * non-throwing wrappers (`getSessionUser`, and `listConversations`'s
 * `requireUser` catch), so it would present as "you are signed out" rather than
 * as a key problem. Sampling one row per column at startup converts that into
 * the outage it actually is. It runs BEFORE the backfill, so a wrong key cannot
 * first re-encrypt legacy plaintext rows under itself and thereby hide the
 * mismatch it was about to cause.
 *
 * **It is a key check, not an integrity check.** The sample is `LIMIT 1` with no
 * `ORDER BY`, so it proves the key opens *a* row of that column — deliberately:
 * scanning every row of every encrypted column on each boot is a different
 * feature with a different cost. A single tampered row passes this gate and
 * fails at read time, which is the right place for it.
 */
export async function assertKeyOpensStoredData(run: QueryRunner): Promise<void> {
  for (const { where, value } of await sampleEncryptedColumns(run)) {
    try {
      decryptField(value, where)
    } catch (err) {
      if (!(err instanceof DataDecryptionError)) throw err
      throw bootFailure(
        `[db] the configured ${DATA_KEY_ENV} does not decrypt existing data in ${where}. ` +
          'Refusing to serve: this is the wrong key (or a rotated one with no re-encryption ' +
          'pass). Continuing would fail every read of that column and, on the session table, ' +
          'would look like every user being signed out.',
      )
    }
  }
}

/**
 * Build the boot failure **and put it in the log on the way past**.
 *
 * Throwing alone was not enough. `initSchema()` is lazy, so the process starts
 * and serves HTTP; `query()` re-throws without logging; and the two callers that
 * matter here (`auth/server.ts`'s `getSessionUser` and
 * `harness-client/actions.server.ts`'s `listConversations`) both swallow the
 * error by design. The measured symptom of a wrong key was therefore a sign-in
 * screen and an empty sidebar — indistinguishable from a session problem, and
 * the exact silent degradation this gate exists to prevent. The message reaching
 * the log from the encryption layer itself is what makes it diagnosable, rather
 * than depending on whichever unrelated subsystem happens to have a catch-all.
 */
function bootFailure(message: string): EncryptionBootError {
  console.error(message)
  return new EncryptionBootError(message)
}

/**
 * The boot gate. Runs inside the schema init, so everything it throws takes the
 * whole process's first query down with a message that names the fix.
 *
 * What "takes down" means, precisely, because the runbook used to overstate it:
 * the schema init is lazy, so the process is already listening. An
 * {@link EncryptionBootError} is **not** retried (`client.server.ts` keeps the
 * rejected init promise), so every query from then on fails immediately with
 * this message and the app serves nothing but errors — but it does not exit,
 * and `systemctl is-active` still reports `active`. Verify a deploy by the log,
 * not by the unit state.
 *
 * Two outcomes when no key is configured, and the difference matters:
 *   - encrypted rows already present -> **throw**. Serving would mean either
 *     garbage or an empty result, and an empty result is worse than an outage
 *     because the next save overwrites the row.
 *   - no encrypted rows -> **warn**, loudly, and continue. This is a fresh or
 *     never-encrypted database; the app still refuses to write (every
 *     encrypting path throws), so nothing lands in plaintext, but a developer
 *     who has not set the key yet gets a startup message rather than a boot
 *     failure with no rows at risk.
 */
export async function ensureEncryptionReady(run: QueryRunner): Promise<void> {
  if (!hasDataEncryptionKey()) {
    const encrypted = await findEncryptedColumns(run)
    if (encrypted.length > 0) {
      throw bootFailure(
        `[db] ${DATA_KEY_ENV} is not set, but encrypted data is already stored in ` +
          `${encrypted.join(', ')}. Refusing to serve: without the key these rows cannot be ` +
          'read, and continuing would serve empty conversations that the next write would ' +
          'destroy. Restore the key (it is NOT recoverable from the database) and restart.',
      )
    }
    console.warn(
      `[db] ${DATA_KEY_ENV} is not set. No encrypted rows exist yet, so startup continues, ` +
        'but every write of conversation content or personal data will fail until it is set. ' +
        'Generate one with `openssl rand -base64 32`.',
    )
    return
  }

  await assertKeyOpensStoredData(run)

  const report = await encryptExistingRows(run)
  if (report.totalRowsEncrypted > 0) {
    const detail = report.tables
      .filter((t) => t.rowsEncrypted > 0)
      .map((t) => `${t.table}:${t.rowsEncrypted}`)
      .join(' ')
    console.log(`[db] encrypted ${report.totalRowsEncrypted} legacy plaintext row(s) — ${detail}`)
  }
  for (const t of report.tables.filter((t) => t.incomplete)) {
    console.warn(
      `[db] ${t.table}: hit the ${MIGRATION_MAX_BATCHES}-batch ceiling with rows still ` +
        'unencrypted; the next boot continues where this one stopped.',
    )
  }
}
