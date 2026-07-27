/**
 * Auth session store (Postgres) — Server Only.
 *
 * The durable server-side session for Entra SSO (#119). The browser holds only
 * an opaque, unguessable session id in an HttpOnly cookie; everything else
 * lives in the `auth_sessions` row. This buys us:
 *   - server-side revocation (logout / admin kill deletes the row), and
 *   - a place to persist the MSAL token cache per session so the future OBO
 *     exchange (#110) has the user's refresh token. We PERSIST the cache here;
 *     we do NOT perform the OBO grant yet (that's #110).
 *
 * Schema is bootstrapped idempotently on first use (mirrors
 * `db/client.server.ts`), so no shared migration file is touched.
 */
import { assertServerOnImport } from "../harness-patterns/assert.server";
import { query } from "../db/client.server";
import { newOpaqueId } from "./cookie-signing.server";

assertServerOnImport();

/** Default session lifetime (8h). Refresh/renewal is deferred to #110. */
export const DEFAULT_SESSION_TTL_SECONDS = 8 * 60 * 60;

export interface SessionClaims {
  /** Entra `oid` — the stable per-user id we key everything on. */
  userId: string;
  email: string;
  displayName: string | null;
  /** MSAL account key (`homeAccountId`), for token-cache lookup during OBO. */
  homeAccountId: string | null;
}

export interface SessionRecord extends SessionClaims {
  id: string;
  createdAt: Date;
  expiresAt: Date;
}

interface DbRow {
  id: string;
  user_id: string;
  email: string;
  display_name: string | null;
  home_account_id: string | null;
  created_at: Date;
  expires_at: Date;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS auth_sessions (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL,
    email            TEXT NOT NULL,
    display_name     TEXT,
    home_account_id  TEXT,
    -- NOTE: the MSAL token cache is NOT stored here. It lives encrypted and
    -- per-user in user_tokens (see user-tokens.server.ts, #110) so that runs
    -- without a live session (agent-trigger) can still act for the user. The
    -- legacy plaintext token_cache column may still exist on databases created
    -- by #119; it is no longer written, and dropping it is post-merge cleanup
    -- (doing it here would break main's code, which still writes it).
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at       TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS auth_sessions_user_idx
    ON auth_sessions (user_id);
  CREATE INDEX IF NOT EXISTS auth_sessions_expires_idx
    ON auth_sessions (expires_at);
`;

let _schemaReady: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  if (!_schemaReady) {
    _schemaReady = query(SCHEMA_SQL)
      .then(() => undefined)
      .catch((err) => {
        _schemaReady = null; // allow retry on next call
        throw err;
      });
  }
  return _schemaReady;
}

function toRecord(row: DbRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    email: row.email,
    displayName: row.display_name,
    homeAccountId: row.home_account_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

/**
 * Create a session row and return its opaque id (to be set as the cookie).
 * The MSAL token cache is persisted separately, per-user and encrypted, by
 * `user-tokens.server.ts` (#110) — not on the session row.
 */
export async function createSession(
  claims: SessionClaims,
  opts: { ttlSeconds?: number } = {},
): Promise<string> {
  await ensureSchema();
  const id = newOpaqueId();
  const ttl = opts.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  await query(
    `INSERT INTO auth_sessions
       (id, user_id, email, display_name, home_account_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' seconds')::interval)`,
    [
      id,
      claims.userId,
      claims.email,
      claims.displayName,
      claims.homeAccountId,
      String(ttl),
    ],
  );
  return id;
}

/**
 * Load a session by id. Returns `null` when unknown or expired; an expired row
 * is deleted lazily so the table self-prunes on access.
 */
export async function getSession(id: string | null | undefined): Promise<SessionRecord | null> {
  if (!id) return null;
  await ensureSchema();
  const { rows } = await query<DbRow>(
    `SELECT id, user_id, email, display_name, home_account_id, created_at, expires_at
       FROM auth_sessions WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  if (row.expires_at.getTime() <= Date.now()) {
    await deleteSession(id).catch(() => {});
    return null;
  }
  return toRecord(row);
}

/** Delete a session (logout / revocation). Idempotent. */
export async function deleteSession(id: string): Promise<void> {
  await ensureSchema();
  await query(`DELETE FROM auth_sessions WHERE id = $1`, [id]);
}

/** Housekeeping: drop expired rows. Returns the number removed. */
export async function deleteExpiredSessions(): Promise<number> {
  await ensureSchema();
  const { rowCount } = await query(
    `DELETE FROM auth_sessions WHERE expires_at <= NOW()`,
  );
  return rowCount ?? 0;
}
