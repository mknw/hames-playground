/**
 * Users repository (Postgres) — Server Only.
 *
 * The durable record of everyone who has ever signed in via Entra (#119).
 * Entra stays the source of truth for *identity* (and, later, App-role tiers
 * for #108); this table records what the app has *observed*: profile snapshot
 * + first/last sign-in. Upserted by `/api/auth/callback` on every successful
 * sign-in, so `last_login` is activity tracking for free — Entra's own
 * sign-in logs need premium licensing + audit scopes we don't want.
 *
 * Schema bootstraps idempotently on first use (mirrors
 * `session-store.server.ts`), so no shared migration file is touched.
 *
 * `email` and `display_name` are encrypted at rest (`db/crypto.server.ts`).
 * `id` (the Entra `oid`) stays plaintext because every other table joins on
 * it, and `tid` because a tenant id identifies the organisation, not a person.
 * Nothing queries this table by email, so encrypting it costs no lookup.
 */
import { assertServerOnImport } from '../harness-patterns/assert.server'
import { query } from '../db/client.server'
import {
  decryptField,
  decryptFieldOrNull,
  encryptField,
  encryptFieldOrNull,
} from '../db/crypto.server'

assertServerOnImport()

export interface UserRecord {
  /** Entra `oid` — the stable per-user id everything keys on. */
  id: string
  email: string
  displayName: string | null
  /** Entra tenant id (`tid` claim). */
  tenantId: string | null
  firstLogin: Date
  lastLogin: Date
}

interface DbRow {
  id: string
  email: string
  display_name: string | null
  tid: string | null
  first_login: Date
  last_login: Date
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL,
    display_name  TEXT,
    tid           TEXT,
    first_login   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_login    TIMESTAMPTZ NOT NULL DEFAULT NOW()
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

function toRecord(row: DbRow): UserRecord {
  return {
    id: row.id,
    email: decryptField(row.email, 'users.email'),
    displayName: decryptFieldOrNull(row.display_name, 'users.display_name'),
    tenantId: row.tid,
    firstLogin: row.first_login,
    lastLogin: row.last_login,
  }
}

/**
 * Record a sign-in: insert on first login, else refresh the profile snapshot
 * (email/display name can change in Entra) and bump `last_login`.
 * `first_login` is never touched after the initial insert.
 */
export async function upsertUser(user: {
  id: string
  email: string
  displayName: string | null
  tenantId: string | null
}): Promise<void> {
  await ensureSchema()
  await query(
    `INSERT INTO users (id, email, display_name, tid)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (id) DO UPDATE SET
       email        = EXCLUDED.email,
       display_name = EXCLUDED.display_name,
       tid          = EXCLUDED.tid,
       last_login   = NOW()`,
    [user.id, encryptField(user.email), encryptFieldOrNull(user.displayName), user.tenantId],
  )
}

/** Load a user by oid, or null when they have never signed in. */
export async function getUser(id: string): Promise<UserRecord | null> {
  await ensureSchema()
  const { rows } = await query<DbRow>(
    `SELECT id, email, display_name, tid, first_login, last_login
       FROM users WHERE id = $1`,
    [id],
  )
  return rows[0] ? toRecord(rows[0]) : null
}

/** All known users, most recently active first (admin listing). */
export async function listUsers(): Promise<UserRecord[]> {
  await ensureSchema()
  const { rows } = await query<DbRow>(
    `SELECT id, email, display_name, tid, first_login, last_login
       FROM users ORDER BY last_login DESC`,
  )
  return rows.map(toRecord)
}
