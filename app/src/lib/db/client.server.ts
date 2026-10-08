/**
 * Postgres Pool Singleton — Server Only
 *
 * Lazy connection pool + idempotent schema bootstrap. The pool is created on
 * first query, so importing this module is cheap and won't fail server boot
 * if Postgres is briefly unreachable.
 */

import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import {
  EncryptionBootError,
  ensureEncryptionReady,
  type QueryRunner,
} from './migrate-encryption.server'
import pg from 'pg'
import { localDatabaseUrl } from '../config/compose-credentials.server'

assertServerOnImport()

const { Pool } = pg

let _pool: pg.Pool | null = null
let _initPromise: Promise<void> | null = null

/** The connection string every pool of this app uses — the main one here and
 *  the memory-write pool in `memories.server.ts`, so the two can never point
 *  at different databases. Unset: the compose Postgres on localhost, with the
 *  repo-root .env password. */
export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? localDatabaseUrl('hames')
}

function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new Pool({ connectionString: databaseUrl() })
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
  -- Current run's origin, not conversation creation source (a promoted action
  -- can have interactive runs). Plaintext lifted enum; NULL records no fact.
  -- No backfill: legacy paused runs remain excluded from memory settlement.
  ALTER TABLE conversations ADD COLUMN IF NOT EXISTS memory_run_origin TEXT
    CHECK (memory_run_origin IN ('interactive', 'triggered'));
  -- When the user pinned this conversation to the top of the sidebar, or NULL
  -- for the overwhelming majority that are not pinned. A lifted, plaintext
  -- column for the same reason as kind/source/status: the list ORDER BY reads
  -- it in SQL, and a timestamp says nothing about what was said. The doctrine
  -- is in \`crypto.server.ts\`; \`encryption-coverage.test.ts\` pins that only
  -- the repository module names this table.
  --
  -- NULLABLE with no DEFAULT, and there is no backfill: "not pinned" is the
  -- truthful state of every row written before pinning existed, so the absent
  -- value is already the right answer. Ordering pinned rows by this timestamp
  -- (most recently pinned first) is what makes a pin a stack rather than a set
  -- — see \`listConversations\` and \`CONVERSATION_PIN_LIMIT\`.
  --
  -- No index of its own. The list query filters on \`user_id\` and sorts the
  -- rows it finds; it already sorted by \`created_at\`, which has no index
  -- either, so this adds sort keys to an in-memory sort of one user's rows
  -- rather than a scan. Adding a partial index here would be speculative.
  ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ;

  -- Share-by-link. ONE column carries the whole sharing state: a row is
  -- public-with-link exactly when \`share_token\` IS NOT NULL. A separate
  -- boolean flag was the obvious alternative and is the worse one — a flag and
  -- a token are two facts that can disagree, and the disagreement that matters
  -- (flag off, token still resolving) is an unrevoked share that reads as
  -- revoked everywhere in the UI.
  --
  -- Plaintext, deliberately, like \`kind\`/\`source\`/\`status\` and every
  -- timestamp: SQL has to look the token UP, so an encrypted column could not
  -- be indexed or compared. \`title\` and \`context\` stay encrypted — sharing
  -- changes who may ask for a conversation, never how it is stored.
  --
  -- The index is UNIQUE and PARTIAL. Unique because a token is an
  -- authenticator and two rows answering to one value is a bug that would
  -- otherwise surface as "someone else's conversation"; partial because
  -- unshared rows are the overwhelming majority and NULLs do not belong in an
  -- authenticator's index. It is also what makes the public lookup an index
  -- seek rather than a scan of every conversation ever.
  ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS share_token TEXT;
  ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS shared_at   TIMESTAMPTZ;
  CREATE UNIQUE INDEX IF NOT EXISTS conversations_share_token_idx
    ON conversations (share_token) WHERE share_token IS NOT NULL;

  -- One writer at a time on \`context\` (#458). Both plaintext, for the reason
  -- kind/status are: SQL compares them, and neither says anything about what
  -- was said. \`conversations.server.ts\` carries the whole design.
  --   context_version — moved on by every write of \`context\` and by every
  --     turn claim, and nothing else. Every save names the version it read
  --     and lands only if the row still has it. NOT \`xmin\`: that moves on a
  --     pin, a share, a tier flip or a title, all of which may happen mid-turn.
  --     Every new value, on insert as on update, comes from ONE sequence, so
  --     no value is ever handed out twice: a per-row counter restarts when a
  --     conversation is deleted and its id recreated (\`?c=<id>\` in a second
  --     tab), and a turn still holding the deleted row's number would then
  --     save into the new row (SD-11).
  --   turn_claimed_at — when the turn holding this row last renewed its
  --     claim, or NULL when none does. A claim older than the lease is dead.
  -- Existing rows keep 0, and no turn holds them; 0 is never drawn from the
  -- sequence, so it cannot collide with a new row's number.
  ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS context_version BIGINT NOT NULL DEFAULT 0;
  CREATE SEQUENCE IF NOT EXISTS conversations_context_version_seq;
  ALTER TABLE conversations
    ALTER COLUMN context_version SET DEFAULT nextval('conversations_context_version_seq');
  ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS turn_claimed_at TIMESTAMPTZ;

  -- When a chain-changed refusal terminally ended this conversation's HITL
  -- pause (#433 S7, owner item 1 on review 6004200697), or NULL. The refusal
  -- flips the lifted status to 'error' while the blob still says 'paused'
  -- (a refusal records nothing), so without a marker the m3 load-restore
  -- would resurrect 'paused' on every load and the row would oscillate
  -- error -> paused -> refused -> error. With it, that 'error' is DURABLE:
  -- the load exempts a marked row, and the person's way out is a new message
  -- (which supersedes the request). The conversation's next successful save
  -- clears it — that is the turn that moved it on. Plaintext like every
  -- timestamp (crypto.server.ts doctrine): it says nothing about what was
  -- said, and no SQL joins on it.
  ALTER TABLE conversations
    ADD COLUMN IF NOT EXISTS hitl_ended_at TIMESTAMPTZ;

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

  -- HITL transport and index (#433 S7). NEVER AUTHORITATIVE: the decision state
  -- is the conversation blob's hitl_* events (ADR-0009), and every answer this
  -- table holds is validated against readHitl(blob).pending before a resume
  -- consumes it — a row that is not pending is closed as superseded, never
  -- applied. Two roles: the ANSWER IN TRANSIT (the person answered; the resume
  -- that consumes the answer has not run yet, or failed and is retryable), and
  -- the PROPOSAL PAYLOAD of a non-blocking request (S11) whose payload may
  -- not ride an event. The payload — personal data the person has not chosen
  -- to save, and for proposals chose nothing about — is DELETED the moment the
  -- request is answered or expires (F20b): the skeleton (ids, kind, status,
  -- timestamps) stays for audit, with the payload and the answer's content
  -- the only encrypted columns. Retention of skeletons is inherited, SD-11.
  --
  -- Everything SQL filters on is plaintext, per the doctrine in
  -- crypto.server.ts: the lifted kind/status, the owner and session ids, the
  -- expiry the sweep reads. \`answer\` and \`payload\` are TEXT envelopes.
  CREATE TABLE IF NOT EXISTS hitl_requests (
    request_id  TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    session_id  TEXT NOT NULL,
    run_id      TEXT,
    kind        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    blocks_run  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at  TIMESTAMPTZ,
    answered_at TIMESTAMPTZ,
    answer      TEXT,
    payload     TEXT
  );
  CREATE INDEX IF NOT EXISTS hitl_requests_session_idx
    ON hitl_requests (user_id, session_id);
  -- The sweep's read: only rows that still hold a payload are due, and a
  -- partial index keeps it that shape when the answered majority (payload
  -- purged) grows.
  CREATE INDEX IF NOT EXISTS hitl_requests_expires_idx
    ON hitl_requests (expires_at) WHERE payload IS NOT NULL;

  -- The quarantine (#433 S7, F2): the raw file, the tier-0 copy, its findings
  -- (F20a) and the sender's FULL address (C2 — the stored summary and the
  -- disclaimer carry the domain only) of a document held for a provenance
  -- decision. App-only and Postgres, NEVER Redis: the gateway's redis server is
  -- a tool surface every agent holding tools.all can read, and a quarantine
  -- there fails P2 the moment anyone asks the agent about the held file
  -- (review F2). Agents have had no Postgres since #412 — pinned gateway-side
  -- by no-agent-postgres.test.ts and package-side by
  -- agent-postgres-tools.test.ts — so no tool can list or read this table.
  -- Owner scope gives erasure a path (SD-11): the row dies with its request
  -- (expires_at), and an expired request can only resolve to "not kept".
  -- Every content column is an encrypted envelope; the sweep reads only
  -- expires_at.
  CREATE TABLE IF NOT EXISTS hitl_quarantine (
    request_id     TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL,
    session_id     TEXT NOT NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at     TIMESTAMPTZ NOT NULL,
    raw_file       TEXT,
    tier0_copy     TEXT,
    findings       TEXT,
    sender_address TEXT
  );
  CREATE INDEX IF NOT EXISTS hitl_quarantine_expires_idx
    ON hitl_quarantine (expires_at);
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
  // Arm the HITL expiry sweep (#433 S7): a quarantine row or a request payload
  // past its `expires_at` must leave without anybody asking (F2, F20b, SD-11).
  // Dynamic import for the same cycle reason as the backfill above, and for
  // the sweep's own idempotence a second init cannot stack a second timer.
  const { startHitlSweepTimer } = await import('./hitl.server')
  startHitlSweepTimer()
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
  await ensureInit()
  return getPool().query<R>(text, params as never[])
}

/** The slice of a pooled connection a transaction body may use. */
export interface TxQuery {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<R>>
}

/**
 * Run `fn` in ONE transaction on ONE connection of the main pool: BEGIN, then
 * COMMIT if it resolved, ROLLBACK and rethrow if it threw. The connection is
 * released either way. For short multi-statement writes that must commit
 * together (a conversation delete and the memories it erases); a transaction
 * that waits on a model call belongs on `memories.server.ts`'s own pool, not
 * here.
 */
export async function withTransaction<R>(fn: (tx: TxQuery) => Promise<R>): Promise<R> {
  await ensureInit()
  const client = await getPool().connect()
  let broken = false
  // See memories.server.ts transaction(): checked-out clients need their own error listener.
  const onError = (err: Error) => {
    broken = true
    console.error('[db] connection lost mid-transaction:', err.message)
  }
  client.on('error', onError)
  try {
    await client.query('BEGIN')
    const out = await fn({ query: (text, params) => client.query(text, params as never[]) })
    await client.query('COMMIT')
    return out
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      broken = true // destroy the connection rather than return it to the pool
    }
    throw err
  } finally {
    client.off('error', onError)
    client.release(broken)
  }
}

async function ensureInit(): Promise<void> {
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
}

const _closers = new Set<() => Promise<void>>()

/** Register a sibling pool (the memory-write pool) to be closed with this one. */
export function onClosePool(closer: () => Promise<void>): void {
  _closers.add(closer)
}

/**
 * Close the pool (test teardown only) — and every sibling pool registered
 * through {@link onClosePool}.
 */
export async function closePool(): Promise<void> {
  for (const closer of _closers) await closer()
  if (_pool) {
    await _pool.end()
    _pool = null
    _initPromise = null
  }
}
