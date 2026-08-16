/**
 * Postgres Pool Singleton — Server Only
 *
 * Lazy connection pool + idempotent schema bootstrap. The pool is created on
 * first query, so importing this module is cheap and won't fail server boot
 * if Postgres is briefly unreachable.
 */

import { assertServerOnImport } from '../harness-patterns/assert.server'
import pg from 'pg'

assertServerOnImport()

const { Pool } = pg

const DEFAULT_DATABASE_URL = 'postgresql://postgres:password@localhost:5432/kgagent'

let _pool: pg.Pool | null = null
let _initPromise: Promise<void> | null = null

function getPool(): pg.Pool {
  if (!_pool) {
    const connectionString = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL
    _pool = new Pool({ connectionString })
    _pool.on('error', (err) => {
      console.error('[db] idle client error:', err)
    })
  }
  return _pool
}

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS conversations (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL,
    agent_id     TEXT NOT NULL,
    title        TEXT,
    context      JSONB NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE INDEX IF NOT EXISTS conversations_user_updated_idx
    ON conversations (user_id, updated_at DESC);

  -- Agent-trigger endpoint: a row is either a chat 'conversation' or a
  -- POST-triggered 'action'. These columns are added via ALTER (not in the
  -- CREATE above) so EXISTING databases pick them up too — the CREATE only runs
  -- when the table is absent. The defaults backfill existing rows correctly:
  -- everything created before this migration is a completed chat conversation.
  --   kind    — mutable; promotion flips 'action' -> 'conversation'.
  --   source  — immutable provenance ('chat' | 'post' | 'routine').
  --   status  — copy of UnifiedContext.status, for cheap list filtering + badge.
  ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS kind   TEXT NOT NULL DEFAULT 'conversation';
  ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'chat';
  ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'done';
  CREATE INDEX IF NOT EXISTS conversations_user_kind_updated_idx
    ON conversations (user_id, kind, updated_at DESC);

  -- Session ownership claims. A Data Stash upload can arrive before the
  -- session has any conversation row (a file dropped before the first chat
  -- message), so there is a window in which \`conversations.user_id\` cannot
  -- answer "who owns this session?". This table records the owner at first
  -- touch instead: the primary key makes the insert a first-toucher-wins
  -- race, and \`expires_at\` mirrors the Data Stash document TTL so a claim
  -- never outlives the documents it scopes. See \`lib/stash/ownership.server.ts\`.
  CREATE TABLE IF NOT EXISTS session_claims (
    session_id  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ NOT NULL
  );
  CREATE INDEX IF NOT EXISTS session_claims_expires_idx
    ON session_claims (expires_at);
`

async function initSchema(): Promise<void> {
  await getPool().query(SCHEMA_SQL)
  console.log('[db] schema ready')
}

/**
 * Run a query, ensuring the schema has been bootstrapped first. The schema
 * init runs at most once per process; concurrent callers share the same
 * promise.
 */
export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<R>> {
  if (!_initPromise) {
    _initPromise = initSchema().catch((err) => {
      _initPromise = null // allow retry on next call
      throw err
    })
  }
  await _initPromise
  return getPool().query<R>(text, params as never[])
}

/**
 * Close the pool (test teardown only).
 */
export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end()
    _pool = null
    _initPromise = null
  }
}
