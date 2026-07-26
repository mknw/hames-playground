/**
 * Per-user MSAL token cache (encrypted, durable) — Server Only.
 *
 * Pattern C (#110): calling Microsoft Graph *as the user* needs that user's
 * tokens available server-side, including for runs with **no live session** —
 * the agent-trigger endpoint (`runAgentInBackground(runId, userId, …)`) has only
 * a `userId`. The #119 sign-in stored the MSAL cache on `auth_sessions`, which
 * has an 8h TTL and is deleted on logout, so it cannot serve that case.
 *
 * This store is therefore keyed by the Entra `oid` and outlives sessions. The
 * blob is MSAL's serialized cache (it contains the refresh token), so it is
 * encrypted at rest via `secret-crypto.server.ts` — #107/#110 both require an
 * encrypted cache. Kept in its own table rather than on `users` so secret
 * material stays separate from profile data (a `listUsers()` admin view can
 * never accidentally select it) and can be dropped/rotated independently.
 *
 * Written on every sign-in and re-written after each silent acquisition
 * (Entra rotates refresh tokens, so the fresh cache must replace the old one).
 */
import { assertServerOnImport } from "../harness-patterns/assert.server";
import { query } from "../db/client.server";
import { encryptSecret, decryptSecret } from "./secret-crypto.server";

assertServerOnImport();

export interface UserTokenCache {
  /** MSAL account key, for `getAccountByHomeId()` during silent acquisition. */
  homeAccountId: string | null;
  /** Decrypted, serialized MSAL token cache. */
  tokenCache: string;
  updatedAt: Date;
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS user_tokens (
    user_id          TEXT PRIMARY KEY,
    home_account_id  TEXT,
    -- AES-256-GCM envelope (see secret-crypto.server.ts) wrapping MSAL's
    -- serialized cache. NEVER stored or logged in plaintext.
    token_cache      TEXT NOT NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  -- #110: the session-scoped cache column from #119 is superseded by this
  -- table. Dropping it removes plaintext refresh tokens from any existing
  -- database; idempotent, so it is safe on every boot.
  ALTER TABLE IF EXISTS auth_sessions DROP COLUMN IF EXISTS token_cache;
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

/**
 * Upsert the user's token cache (encrypting before write). Call after sign-in
 * and after every silent acquisition that mutates the cache.
 */
export async function saveUserTokenCache(
  userId: string,
  tokenCache: string,
  homeAccountId: string | null,
): Promise<void> {
  await ensureSchema();
  await query(
    `INSERT INTO user_tokens (user_id, home_account_id, token_cache)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE SET
       home_account_id = EXCLUDED.home_account_id,
       token_cache     = EXCLUDED.token_cache,
       updated_at      = NOW()`,
    [userId, homeAccountId, encryptSecret(tokenCache)],
  );
}

/**
 * Load and decrypt the user's cache. Returns `null` when absent **or when
 * decryption fails** (rotated/incorrect key, tampered row) — the caller treats
 * that as "this user must sign in again" rather than crashing.
 */
export async function loadUserTokenCache(
  userId: string,
): Promise<UserTokenCache | null> {
  await ensureSchema();
  const { rows } = await query<{
    home_account_id: string | null;
    token_cache: string;
    updated_at: Date;
  }>(
    `SELECT home_account_id, token_cache, updated_at
       FROM user_tokens WHERE user_id = $1`,
    [userId],
  );
  const row = rows[0];
  if (!row) return null;

  const tokenCache = decryptSecret(row.token_cache);
  if (!tokenCache) {
    console.warn(
      `[user-tokens] could not decrypt token cache for user ${userId} — ` +
        "treating as absent (re-authentication required).",
    );
    return null;
  }
  return {
    homeAccountId: row.home_account_id,
    tokenCache,
    updatedAt: row.updated_at,
  };
}

/** True when the user has a usable cache (cheap existence check, no decrypt). */
export async function hasUserTokenCache(userId: string): Promise<boolean> {
  await ensureSchema();
  const { rows } = await query<{ one: number }>(
    `SELECT 1 AS one FROM user_tokens WHERE user_id = $1`,
    [userId],
  );
  return rows.length > 0;
}

/**
 * Forget a user's tokens — e.g. an explicit "disconnect Microsoft" action, or
 * after an unrecoverable auth failure. Idempotent.
 *
 * NOTE: deliberately NOT called on logout. Logout ends the browser session;
 * the durable cache is what lets background runs (#106 agent-trigger) keep
 * acting for the user afterwards.
 */
export async function deleteUserTokenCache(userId: string): Promise<void> {
  await ensureSchema();
  await query(`DELETE FROM user_tokens WHERE user_id = $1`, [userId]);
}
