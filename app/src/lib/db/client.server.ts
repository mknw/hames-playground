/**
 * Postgres Pool Singleton — Server Only
 *
 * Lazy connection pool + idempotent schema bootstrap. The pool is created on
 * first query, so importing this module is cheap and won't fail server boot
 * if Postgres is briefly unreachable.
 */

import { assertServerOnImport } from '../harness-patterns/assert.server'
import {
  EncryptionBootError,
  ensureEncryptionReady,
  type QueryRunner,
} from './migrate-encryption.server'
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

  -- Recency alone, with NO leading user_id. The two composite indexes above
  -- cannot seek on \`updated_at\` — it is never their leading column — so the
  -- preview header's active-user count (\`metrics/preview-counters.server.ts\`,
  -- polled every 15s by every open tab on every route) degraded to an
  -- index-ONLY scan of the whole table: measured on 200k rows, 808 buffers /
  -- cost 4824 to return 14 rows, against 4 buffers / cost 9 with this index.
  -- It is O(the window) instead of O(every conversation ever), and being one
  -- column narrower it is also SMALLER than the index it stops scanning.
  CREATE INDEX IF NOT EXISTS conversations_updated_idx
    ON conversations (updated_at DESC);

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

  -- Which inference tier this conversation's turns run on ('verda' | 'anthropic').
  -- A lifted enum like kind/source/status, and plaintext for the same reason:
  -- it is scoped/filtered in SQL and says nothing about what was said. See the
  -- doctrine in \`crypto.server.ts\`; \`encryption-coverage.test.ts\` pins it.
  --
  -- NULLABLE, unlike its three neighbours, and that is the whole design: NULL
  -- means "this row has no tier of its own", which resolves through the user's
  -- last-used tier and then the deployment default
  -- (\`lib/inference/tier.server.ts\`). A NOT NULL DEFAULT would have claimed
  -- every pre-existing conversation ran on whichever literal was chosen here,
  -- which is a statement about runs nobody observed. The backfill below writes
  -- the tier only where the user actually recorded one.
  ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS inference_tier TEXT;

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

/**
 * A runner that talks to the pool directly, bypassing {@link query}.
 *
 * The backfill and the key check run *inside* `initSchema`, and `query()` awaits
 * the schema-init promise before touching the pool — so routing them through it
 * would make the init promise wait on itself.
 */
const directRunner: QueryRunner = (text, params) =>
  getPool().query(text, params as never[]) as never

async function initSchema(): Promise<void> {
  await getPool().query(SCHEMA_SQL)
  // At-rest encryption (see crypto.server.ts): verify the key against what is
  // already stored, then backfill any rows written before encryption existed.
  // Deliberately part of schema-ensure rather than a separate script — a
  // migration an operator can forget leaves a table half in plaintext. This
  // throws (and so fails every query in the process, permanently — see the
  // catch below) when encrypted rows exist without a key, after logging the
  // reason itself; that is the intended loud failure, not a bug to soften.
  await ensureEncryptionReady(directRunner)
  // Give pre-existing conversations the tier their turns actually ran under.
  //
  // The statement lives in the repository that owns SQL against
  // `conversations` — the #260 seam `encryption-coverage.test.ts` pins — and is
  // handed the direct runner for the same reason the encryption backfill is:
  // `query()` awaits this promise, so routing it through `query()` would make
  // the init wait on itself.
  //
  // Imported HERE rather than at the top of the file because that repository
  // imports `query` from this module: a static import back would make the two
  // modules a cycle, which ESM tolerates and nothing about this call needs. By
  // the time any schema init runs, the module is already loaded in every real
  // process.
  const { backfillConversationInferenceTier } = await import('./conversations.server')
  await backfillConversationInferenceTier(directRunner)
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
      // A transient failure (Postgres briefly unreachable) is retried on the
      // next call. A key failure is not: nothing about a missing or wrong
      // DATA_ENCRYPTION_KEY fixes itself while the process runs, and retrying
      // re-ran the whole DDL + probe set on *every* subsequent request. Keeping
      // the rejected promise makes the outage what the runbook says it is —
      // permanent until a restart — at the cost of one log line, not one per
      // request. `closePool()` clears it for tests.
      if (!(err instanceof EncryptionBootError)) _initPromise = null
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
