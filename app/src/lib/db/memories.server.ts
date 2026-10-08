/**
 * Memories repository — Server Only.
 *
 * SQL for the two tables the memory feature (#419) stores rows in: `memories`
 * (one row per stored memory) and `memory_sources` (which conversation events
 * each memory was built from). This module is the ONE place production code
 * runs SQL against them — `encryption-coverage.test.ts` pins that — so
 * encrypt-on-write and decrypt-on-read for both tables live here and nowhere
 * else.
 *
 * ## Why the schema is ensured HERE, not in `client.server.ts`
 *
 * Every other table's DDL bootstraps from `client.server.ts`'s `SCHEMA_SQL`.
 * These two cannot, because their DDL starts with `CREATE EXTENSION IF NOT
 * EXISTS vector` (the `embedding` column is a `vector(1024)`, and the type
 * comes from the pgvector extension). That statement is the one DDL in the
 * app that can fail for an ENVIRONMENT reason rather than a schema reason:
 * the Postgres image may simply not have the extension installed (the compose
 * image is plain `postgres:16` until #419 M8 moves it to `pgvector/pgvector`;
 * CI's `test · postgres` service already uses the pgvector image, and the
 * private-Postgres guidance in `docs/testing/pyramid.md` points at it too).
 * Running it from the shared init would take the whole database down with it.
 *
 * ## The missing-extension fail policy (named, per the spec)
 *
 * **A missing extension disables memory, not the database.** Concretely:
 *
 * - {@link ensureMemoriesSchema} attempts `CREATE EXTENSION` first. If it
 *   fails, the reason is logged once, the module marks memory **unavailable
 *   for this process**, and the promise still RESOLVES — nothing throws out
 *   of the ensure, and no `CREATE TABLE` is attempted (the `vector` type
 *   would not resolve anyway).
 * - Every row operation calls the ensure first and throws
 *   {@link MemoryUnavailableError} while the mark is set. The error is named
 *   so a caller (the recall step, the store pipeline) can tell "memory is
 *   switched off here" apart from a storage fault, per the spec's rule that
 *   memory is opportunistic: its failure must never fail the turn.
 * - The mark is deliberately STICKY for the process: retrying would re-run
 *   `CREATE EXTENSION` (and re-log the failure) on every memory operation,
 *   which on a vector-less host is one log line per recalled turn. A restart
 *   after installing the extension retries naturally. Tests reset the mark
 *   with {@link resetMemoriesSchemaForTests}.
 *
 * ## Encryption at rest
 *
 * `content` and `evidence` are AES-256-GCM envelopes under
 * `DATA_ENCRYPTION_KEY` (`crypto.server.ts`); the table is registered in
 * `migrate-encryption.server.ts`'s `ENCRYPTED_TABLES`, so the boot gate and
 * the legacy-plaintext backfill cover it from day one. **`embedding` is a
 * declared exception** — the owner decided embeddings are not encrypted
 * (#419 comment 5962687047: the app's hardening rounds and restricted access
 * make the ciphertext cost unjustified for derived vectors). The exception is
 * declared in {@link COLUMN_CLASSIFICATION} below, and
 * `memories.test.ts`'s column-classification pin fails if a column appears in
 * the DDL without a classification, or if the exception grows beyond that one
 * column.
 *
 * ## Owner scope
 *
 * Every statement is scoped by `user_id`, like every repository here: a
 * foreign id is a no-op, never a probe for whether an id exists.
 * {@link deleteAllMemoriesForUser} takes a `userId` argument and is therefore
 * NEVER a `'use server'` export — the caller would choose the owner (SD-13);
 * the browser-reachable RPCs that wrap it land in M7's
 * `lib/memory/actions.server.ts`, which re-resolves the user server-side.
 *
 * This slice (M4) lays down the schema, the fail policy and the minimal row
 * surface the later slices build on: the recall step (M1) reads
 * {@link listMemoriesForUser}; the store pipeline (M2) writes through
 * {@link insertMemory} / {@link insertMemorySource}; erasure (M7) calls
 * {@link deleteAllMemoriesForUser}.
 *
 * M5b adds the DB-backed stores the host binds ({@link createMemoryDbStore}:
 * recall's read side and the write transaction, on their own small pool —
 * owner decision (c)), `evidence_event_id`, and the whole-memory erase both
 * conversation deletes run in their own transaction
 * ({@link deleteMemoriesForConversations}, #531).
 */
import pg from 'pg'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import type {
  MemoryCandidate,
  MemoryInsertRow,
  MemoryNeighbor,
  MemorySourceRow,
  MemoryStore,
  MemoryWriteStore,
  MemoryWriteTx,
} from '@hames-ai/harness-patterns/types'
import { decryptField, encryptField } from './crypto.server'
import { databaseUrl, onClosePool, query, type TxQuery } from './client.server'

assertServerOnImport()

/** The four memory kinds the store gate may produce (spec §3, closed set). */
export type MemoryKind = 'episodic' | 'semantic' | 'preference' | 'trait'

/** The inference tier a memory was written under (D8: tiers never mix). */
export type MemoryTier = 'verda' | 'anthropic'

/**
 * Every column of both tables, classified — the data the
 * `column-classification` pin reads. Exactly three values:
 *
 * - `'plaintext'` — identifiers, lifted enums, timestamps and counters SQL
 *   filters, joins or orders on; none of them says anything about what was
 *   said (the doctrine in `crypto.server.ts`).
 * - `'encrypted'` — personal content, written and read only as envelopes.
 * - `'declared-exception'` — `embedding`, the ONE column the owner exempted
 *   (above). The pin asserts it stays exactly one, so a second plaintext
 *   content column cannot arrive unannounced.
 */
export const COLUMN_CLASSIFICATION = {
  memories: {
    id: 'plaintext',
    user_id: 'plaintext',
    kind: 'plaintext',
    tier: 'plaintext',
    content: 'encrypted',
    evidence: 'encrypted',
    // Declared exception (D2, owner #419 comment 5962687047): embeddings are
    // derived vectors, not user content, and are NOT encrypted. Carried in
    // every nightly pg_dump for that backup's retention — recorded in the
    // data map (M8).
    embedding: 'declared-exception',
    embed_space: 'plaintext',
    // The id of the conversation event `evidence` quotes (owner decision (b),
    // #419): an identifier, like `memory_sources.event_id`. NULL on a row
    // written before the column existed and on a host that supplied none.
    evidence_event_id: 'plaintext',
    evidence_count: 'plaintext',
    compacted_from: 'plaintext',
    created_at: 'plaintext',
    last_seen_at: 'plaintext',
  },
  memory_sources: {
    user_id: 'plaintext',
    event_id: 'plaintext',
    ordinal: 'plaintext',
    memory_id: 'plaintext',
    conversation_id: 'plaintext',
    created_at: 'plaintext',
  },
} as const satisfies Record<
  string,
  Record<string, 'plaintext' | 'encrypted' | 'declared-exception'>
>

/**
 * The DDL, run by {@link ensureMemoriesSchema} only after `CREATE EXTENSION`
 * has succeeded — the `vector` type does not exist before it.
 *
 * No `tsvector` and no HNSW/IVFFlat index (spec §5): recall's lexical half
 * runs in the app over decrypted rows, and the semantic half does an exact
 * sequential scan over one user's few hundred rows, so an index would be
 * infrastructure for a problem this table size cannot have. The column-classification
 * pin fails if a column is added here without joining {@link COLUMN_CLASSIFICATION}.
 */
const MEMORY_DDL = `
  CREATE TABLE IF NOT EXISTS memories (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL,
    kind           TEXT NOT NULL CHECK (kind IN ('episodic','semantic','preference','trait')),
    tier           TEXT NOT NULL CHECK (tier IN ('verda','anthropic')),
    content        TEXT NOT NULL,
    evidence       TEXT NOT NULL,
    embedding      vector(1024) NOT NULL,
    embed_space    TEXT NOT NULL,
    evidence_event_id TEXT,
    evidence_count INTEGER NOT NULL DEFAULT 1,
    compacted_from INTEGER NOT NULL DEFAULT 1,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  -- The CREATE above only runs when the table is absent, so a database that
  -- already has it picks the column up here (idempotent; no backfill: NULL is
  -- the truthful value for a row nobody recorded an event for).
  ALTER TABLE memories ADD COLUMN IF NOT EXISTS evidence_event_id TEXT;
  CREATE INDEX IF NOT EXISTS memories_user_idx ON memories (user_id, tier, kind);

  -- One row per (source event, candidate ordinal). The primary key is the
  -- idempotency mechanism (spec §3 step 6 / review F9, wired in M2): a
  -- candidate whose source row already exists skips its whole write, so a
  -- partial re-run can never leave a memory without its source row.
  CREATE TABLE IF NOT EXISTS memory_sources (
    user_id         TEXT NOT NULL,
    event_id        TEXT NOT NULL,
    ordinal         SMALLINT NOT NULL,
    memory_id       TEXT NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, event_id, ordinal)
  );

  -- A source row must name a conversation that EXISTS (#531). NO ACTION, not
  -- CASCADE, and that is the design: a cascade would drop the source rows of a
  -- deleted conversation and leave the memory standing on its other sources,
  -- which is the exact outcome owner decision (b) forbids. The conversation
  -- delete erases whole memories FIRST, in its own transaction
  -- (\`deleteMemoriesForConversations\`), so by the time the conversation row
  -- goes no source points at it; this constraint is the tripwire for a path
  -- that forgot, and it closes the race a cascade would also leave open: a
  -- settle already in flight cannot insert a source for a conversation that
  -- has just been deleted (the insert fails, its transaction rolls back, no
  -- ghost memory). NOT VALID: new rows are checked, rows from before this
  -- constraint are not scanned (nothing wrote memory rows before M5c).
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_sources_conversation_fk') THEN
      ALTER TABLE memory_sources
        ADD CONSTRAINT memory_sources_conversation_fk
        FOREIGN KEY (conversation_id) REFERENCES conversations (id) NOT VALID;
    END IF;
  END $$;
`

/** Thrown by every row operation while the pgvector extension is unavailable. */
export class MemoryUnavailableError extends Error {
  constructor(cause: unknown) {
    super(
      '[memories] the pgvector extension is not available on this Postgres, so memory is ' +
        'disabled for this process (the database itself is unaffected). Install an image ' +
        'with the extension — pgvector/pgvector — and restart. Underlying error: ' +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    )
    this.name = 'MemoryUnavailableError'
  }
}

let _ensurePromise: Promise<void> | null = null
let _available = false

/**
 * Create the extension and both tables, once per process. Resolves whatever
 * the extension verdict was — a missing extension is the environment, not an
 * error (the fail policy, above). Only a failure of the DDL itself rejects,
 * and that rejects with a reset promise, so a transient outage retries on the
 * next call exactly like `client.server.ts`'s own ensure does.
 */
export async function ensureMemoriesSchema(): Promise<void> {
  if (!_ensurePromise) {
    _ensurePromise = (async () => {
      try {
        await query('CREATE EXTENSION IF NOT EXISTS vector')
      } catch (err) {
        // Fail policy: memory off, database stays up, one log line, sticky.
        _available = false
        console.warn(
          '[memories] memory is disabled: `CREATE EXTENSION vector` failed. ' +
            `${err instanceof Error ? err.message : String(err)}`,
        )
        return
      }
      await query(MEMORY_DDL)
      _available = true
    })().catch((err) => {
      _ensurePromise = null // allow retry on next call
      throw err
    })
  }
  return _ensurePromise
}

/** Whether the last ensure found the extension and created the tables. */
export function isMemoryAvailable(): boolean {
  return _available
}

/** Clear the memoised ensure and its availability mark (test teardown only). */
export function resetMemoriesSchemaForTests(): void {
  _ensurePromise = null
  _available = false
}

/** The ensure every row operation opens with, and the fail policy's gate. */
async function ready(): Promise<void> {
  await ensureMemoriesSchema()
  if (!_available) {
    // The ensure logged the reason already; this is the named error callers
    // branch on.
    throw new MemoryUnavailableError(new Error('CREATE EXTENSION vector did not succeed'))
  }
}

/** A memory as a caller sees it — decrypted, snake_case mapped to camelCase. */
export interface MemoryRow {
  readonly id: string
  readonly userId: string
  readonly kind: MemoryKind
  readonly tier: MemoryTier
  readonly content: string
  readonly evidence: string
  readonly embedSpace: string
  readonly evidenceEventId: string | null
  readonly evidenceCount: number
  readonly compactedFrom: number
  readonly createdAt: Date
  readonly lastSeenAt: Date
}

/** What {@link insertMemory} takes. `embedding` is a 1024-dim vector. */
export interface MemoryInsert {
  readonly id: string
  readonly userId: string
  readonly kind: MemoryKind
  readonly tier: MemoryTier
  readonly content: string
  readonly evidence: string
  readonly embedding: readonly number[]
  readonly embedSpace: string
  /** The conversation event `evidence` quotes. */
  readonly evidenceEventId?: string
}

/** A memory's provenance row: which conversation event it was built from. */
export interface MemorySourceInsert {
  readonly userId: string
  readonly eventId: string
  readonly ordinal: number
  readonly memoryId: string
  readonly conversationId: string
}

/** pgvector's text literal for a float array: `'[1,2,3]'`. */
function toVectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(',')}]`
}

/**
 * Insert one memory, encrypting `content` and `evidence` on the way in (the
 * embedding goes through as pgvector's own text literal — it is the declared
 * plaintext exception). The dedupe/merge machinery around this call — the
 * advisory lock, the same-transaction source row, the reinforce path — is M2's
 * pipeline; this is the row write it bottoms out in.
 */
export async function insertMemory(input: MemoryInsert): Promise<void> {
  await ready()
  await query(
    `INSERT INTO memories (id, user_id, kind, tier, content, evidence, embedding, embed_space, evidence_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, $9)`,
    [
      input.id,
      input.userId,
      input.kind,
      input.tier,
      encryptField(input.content),
      encryptField(input.evidence),
      toVectorLiteral(input.embedding),
      input.embedSpace,
      input.evidenceEventId ?? null,
    ],
  )
}

/**
 * Insert one provenance row. M2's pipeline puts this in the SAME transaction
 * as its memory (F9); this standalone form is the base the transaction wraps,
 * and what the cascade-delete test seeds with.
 */
export async function insertMemorySource(input: MemorySourceInsert): Promise<void> {
  await ready()
  await query(
    `INSERT INTO memory_sources (user_id, event_id, ordinal, memory_id, conversation_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [input.userId, input.eventId, input.ordinal, input.memoryId, input.conversationId],
  )
}

/**
 * Every memory `userId` owns, oldest first, decrypted. The tier filter is NOT
 * here: which tier's rows a turn may see is recall's rule (M1, the
 * `tier-filter` pin), and this read is the erasure/export surface (M7), which
 * sees all of the user's rows by design.
 */
export async function listMemoriesForUser(userId: string): Promise<MemoryRow[]> {
  await ready()
  const { rows } = await query<Record<string, unknown>>(
    `SELECT id, user_id, kind, tier, content, evidence, embed_space, evidence_event_id,
            evidence_count, compacted_from, created_at, last_seen_at
       FROM memories
      WHERE user_id = $1
      ORDER BY created_at`,
    [userId],
  )
  return rows.map((r) => ({
    id: r.id as string,
    userId: r.user_id as string,
    kind: r.kind as MemoryKind,
    tier: r.tier as MemoryTier,
    content: decryptField(r.content as string, 'memories.content'),
    evidence: decryptField(r.evidence as string, 'memories.evidence'),
    embedSpace: r.embed_space as string,
    evidenceEventId: (r.evidence_event_id as string | null) ?? null,
    evidenceCount: r.evidence_count as number,
    compactedFrom: r.compacted_from as number,
    createdAt: r.created_at as Date,
    lastSeenAt: r.last_seen_at as Date,
  }))
}

/**
 * Delete every memory and provenance row for `userId`, and return how many
 * memories died. The `memory_sources` rows go with them through the foreign
 * key's `ON DELETE CASCADE` — one statement, because a user's memory rows and
 * their sources are one fact. This is the erasure bottom (SD-11): the M7 RPC
 * reaches it after its own `requireUser()`, never the other way round. Takes
 * a `userId` argument, so it is NEVER a `'use server'` export (SD-13).
 */
export async function deleteAllMemoriesForUser(userId: string): Promise<number> {
  await ready()
  const { rowCount } = await query(`DELETE FROM memories WHERE user_id = $1`, [userId])
  return rowCount ?? 0
}

/**
 * Erase every memory that has a `memory_sources` row in any of
 * `conversationIds`, WHOLE — the memory and all its sources, including the
 * sources from other conversations (owner decision (b), #419: a memory that
 * ever drew on a conversation dies with it; #531). Returns how many memories
 * died.
 *
 * `tx` is REQUIRED and is the caller's open transaction: the erase and the
 * conversation delete it belongs to commit together or not at all, so a
 * failed erase never leaves the conversation gone and its memories alive, and
 * a failed conversation delete never leaves memories erased for a conversation
 * that still exists. Both conversation-delete paths in `conversations.server.ts`
 * call this; `deleteMemoriesForConversations` is NOT a `'use server'` export
 * (it takes a `userId`, SD-13).
 *
 * Owner-scoped twice — the memory's `user_id` and the source row's — so a
 * foreign user's rows that happen to name the same conversation id are never
 * touched. The `memory_sources` rows go through the memory_id FK's
 * `ON DELETE CASCADE`.
 *
 * A host without pgvector has no memory tables and nothing to erase: that is
 * NOT an error here (a conversation delete must work on a vector-less host),
 * unlike every row operation above.
 *
 * `SET LOCAL lock_timeout` applies to the rest of the caller's transaction,
 * the conversation DELETE included: that statement can wait on a settle that
 * holds a share lock on the conversation row through the FK, and the wait is
 * bounded instead of riding a model call.
 */
export async function deleteMemoriesForConversations(
  conversationIds: readonly string[],
  userId: string,
  tx: TxQuery,
): Promise<number> {
  if (conversationIds.length === 0) return 0
  await ensureMemoriesSchema()
  if (!_available) return 0
  await tx.query(`SET LOCAL lock_timeout = ${MEMORY_LOCK_TIMEOUT_MS}`)
  const { rowCount } = await tx.query(
    `DELETE FROM memories
      WHERE user_id = $2
        AND id IN (SELECT memory_id FROM memory_sources
                    WHERE user_id = $2 AND conversation_id = ANY($1))`,
    [conversationIds, userId],
  )
  return rowCount ?? 0
}

// ============================================================================
// The DB-backed stores the `withMemory` host binds (#419 M5b)
// ============================================================================

/**
 * `MemoryWriteTx.insert` / `update` carry the event id the evidence quotes
 * (owner decision (b)). Core's types gain these optional fields in #527;
 * declared here too so this module compiles against either side of that merge.
 */
type WithEvidenceEvent = { readonly evidenceEventId?: string }

/** Connections the memory-write pool may hold. Small on purpose: each one can
 *  sit idle-in-transaction across a model call (the merge decision), and a
 *  burst of settles must queue here, never starve the app's main pool. */
export const MEMORY_POOL_MAX = 2
/** How long a settle waits for one of those connections before failing. */
export const MEMORY_POOL_CONNECT_TIMEOUT_MS = 5_000
/** Bound on any lock wait inside a memory transaction (the owner's advisory
 *  lock, a row lock) and on the conversation-delete's FK wait. */
export const MEMORY_LOCK_TIMEOUT_MS = 5_000
/** Backstop for a transaction that holds its connection and never finishes
 *  (a host bug leaking one): the server ends it. Above the model-call budget
 *  the merge decision may legitimately spend inside a transaction. */
export const MEMORY_IDLE_IN_TX_TIMEOUT_MS = 300_000
/** The pool's `application_name`, so the pool a statement ran on is visible
 *  to the server (and to the pin that the pools are separate). */
export const MEMORY_POOL_APPLICATION_NAME = 'hames-memory'

let _memoryPool: pg.Pool | null = null

/** The dedicated pool for memory WRITES — never the main pool (owner decision
 *  (c), #419). Created on first use; closed with the main pool. */
export function getMemoryPool(): pg.Pool {
  if (!_memoryPool) {
    _memoryPool = new pg.Pool({
      connectionString: databaseUrl(),
      max: MEMORY_POOL_MAX,
      connectionTimeoutMillis: MEMORY_POOL_CONNECT_TIMEOUT_MS,
      idleTimeoutMillis: 30_000,
      application_name: MEMORY_POOL_APPLICATION_NAME,
      options: `-c idle_in_transaction_session_timeout=${MEMORY_IDLE_IN_TX_TIMEOUT_MS}`,
    })
    _memoryPool.on('error', (err) => {
      console.error('[memories] idle client error:', err)
    })
    onClosePool(closeMemoryPool)
  }
  return _memoryPool
}

/** Close the memory-write pool (test teardown; `closePool()` also calls it). */
export async function closeMemoryPool(): Promise<void> {
  if (_memoryPool) {
    const pool = _memoryPool
    _memoryPool = null
    await pool.end()
  }
}

/** The pg-protocol error code for a lock wait that hit `lock_timeout`. */
const LOCK_NOT_AVAILABLE = '55P03'

/** Whether `err` is a memory transaction giving up on a lock. */
export function isMemoryLockTimeout(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === LOCK_NOT_AVAILABLE
}

function decryptContent(raw: unknown): string {
  return decryptField(raw as string, 'memories.content')
}

/**
 * Recall's read side and the store pipeline's write side for ONE owner, as the
 * single object `MemoryConfig.store` takes. The owner is bound here — no
 * method names a user, so a call site cannot reach another one — and every
 * statement carries `user_id = $owner` anyway.
 *
 * Reads go through the main pool (short, and never held across a model call);
 * writes go through {@link getMemoryPool}.
 */
export function createMemoryDbStore(userId: string): MemoryStore & MemoryWriteStore {
  return {
    async count(tiers) {
      await ready()
      const { rows } = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM memories WHERE user_id = $1 AND tier = ANY($2)`,
        [userId, [...tiers]],
      )
      return rows[0]?.n ?? 0
    },

    async candidates({ embedding, tiers }): Promise<MemoryCandidate[]> {
      await ready()
      // Exact, unordered, unlimited: BM25's document frequencies are computed
      // over exactly this corpus. A row from another embedding space is
      // returned as it is; recall refuses it.
      const { rows } = await query<Record<string, unknown>>(
        `SELECT id, kind, tier, content, embed_space, last_seen_at,
                embedding <=> $3::vector AS distance
           FROM memories
          WHERE user_id = $1 AND tier = ANY($2)`,
        [userId, [...tiers], toVectorLiteral(embedding)],
      )
      return rows.map((r) => ({
        id: r.id as string,
        kind: r.kind as MemoryKind,
        tier: r.tier as string,
        content: decryptContent(r.content),
        embedSpace: r.embed_space as string,
        distance: Number(r.distance),
        lastSeenAt: r.last_seen_at as Date,
      }))
    },

    async transaction<R>(fn: (tx: MemoryWriteTx) => Promise<R>): Promise<R> {
      await ready()
      const client = await getMemoryPool().connect()
      let broken = false
      try {
        await client.query('BEGIN')
        await client.query(`SET LOCAL lock_timeout = ${MEMORY_LOCK_TIMEOUT_MS}`)
        // One owner's stores (and compaction) serialize; a second waits at most
        // lock_timeout and then fails, instead of queueing behind a model call.
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
          `memories:${userId}`,
        ])
        const out = await fn(writeTx(client, userId))
        await client.query('COMMIT')
        return out
      } catch (err) {
        try {
          await client.query('ROLLBACK')
        } catch {
          broken = true // never return a connection in an unknown state to the pool
        }
        throw err
      } finally {
        client.release(broken)
      }
    },
  }
}

/** One memory transaction's operations, bound to its connection and owner. */
function writeTx(client: pg.PoolClient, userId: string): MemoryWriteTx {
  /** A write that must hit the owner's row: zero rows means the memory was
   *  erased between the nearest/read and this write — throw, so the whole
   *  transaction (source row included) rolls back instead of resurrecting a
   *  sighting of a memory that no longer exists. */
  const mustHit = (rowCount: number | null, what: string, id: string) => {
    if (!rowCount) throw new Error(`[memories] ${what}: memory ${id} not found for this owner`)
  }
  const tx: MemoryWriteTx = {
    async nearest({ embedding, embedSpace, tier }): Promise<MemoryNeighbor | null> {
      const { rows } = await client.query(
        `SELECT id, kind, content, 1 - (embedding <=> $1::vector) AS similarity
           FROM memories
          WHERE user_id = $2 AND tier = $3 AND embed_space = $4
          ORDER BY embedding <=> $1::vector
          LIMIT 1`,
        [toVectorLiteral(embedding), userId, tier, embedSpace],
      )
      const r = rows[0]
      if (!r) return null
      return {
        id: r.id as string,
        kind: r.kind as MemoryKind,
        content: decryptContent(r.content),
        similarity: Number(r.similarity),
      }
    },

    async insert(row: MemoryInsertRow & WithEvidenceEvent) {
      await client.query(
        `INSERT INTO memories (id, user_id, kind, tier, content, evidence, embedding, embed_space, evidence_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, $9)`,
        [
          row.id,
          userId,
          row.kind,
          row.tier,
          encryptField(row.content),
          encryptField(row.evidence),
          toVectorLiteral(row.embedding),
          row.embedSpace,
          row.evidenceEventId ?? null,
        ],
      )
    },

    async reinforce(id) {
      const r = await client.query(
        `UPDATE memories SET evidence_count = evidence_count + 1, last_seen_at = NOW()
          WHERE id = $1 AND user_id = $2`,
        [id, userId],
      )
      mustHit(r.rowCount, 'reinforce', id)
    },

    async update(id, next) {
      // `evidence` and its event id are replaced TOGETHER: an id left behind
      // would name an event that no longer holds the stored quote. Source
      // rows are never touched (decision (b)).
      const r = await client.query(
        `UPDATE memories
            SET content = $3, evidence = $4, embedding = $5::vector, embed_space = $6,
                evidence_event_id = $7,
                evidence_count = evidence_count + 1, last_seen_at = NOW()
          WHERE id = $1 AND user_id = $2`,
        [
          id,
          userId,
          encryptField(next.content),
          encryptField(next.evidence),
          toVectorLiteral(next.embedding),
          next.embedSpace,
          (next as WithEvidenceEvent).evidenceEventId ?? null,
        ],
      )
      mustHit(r.rowCount, 'update', id)
    },

    async addSource(src: MemorySourceRow) {
      // ON CONFLICT DO NOTHING RETURNING: a bare INSERT would abort the whole
      // transaction on a replayed candidate. RETURNING yields nothing on
      // conflict, so the existing row's memory is read back.
      const ins = await client.query<{ memory_id: string }>(
        `INSERT INTO memory_sources (user_id, event_id, ordinal, memory_id, conversation_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, event_id, ordinal) DO NOTHING
         RETURNING memory_id`,
        [userId, src.eventId, src.ordinal, src.memoryId, src.conversationId],
      )
      if (ins.rows.length > 0) return { inserted: true as const }
      const { rows } = await client.query<{ memory_id: string }>(
        `SELECT memory_id FROM memory_sources
          WHERE user_id = $1 AND event_id = $2 AND ordinal = $3`,
        [userId, src.eventId, src.ordinal],
      )
      const existing = rows[0]?.memory_id
      if (!existing) {
        throw new Error('[memories] addSource: conflicting source row vanished before it was read')
      }
      return { inserted: false as const, memoryId: existing }
    },

    async read(id) {
      const { rows } = await client.query(
        `SELECT kind, content FROM memories WHERE id = $1 AND user_id = $2`,
        [id, userId],
      )
      const r = rows[0]
      return r ? { kind: r.kind as MemoryKind, content: decryptContent(r.content) } : null
    },

    async count() {
      const { rows } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM memories WHERE user_id = $1`,
        [userId],
      )
      return rows[0]?.n ?? 0
    },
  }
  return tx
}
