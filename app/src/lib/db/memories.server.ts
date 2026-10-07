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
 * and CI images are plain `postgres:16` until #419 M8 moves them to
 * `pgvector/pgvector`). Running it from the shared init would take the whole
 * database down with it.
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
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import { decryptField, encryptField } from './crypto.server'
import { query } from './client.server'

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
    evidence_count INTEGER NOT NULL DEFAULT 1,
    compacted_from INTEGER NOT NULL DEFAULT 1,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
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
    `INSERT INTO memories (id, user_id, kind, tier, content, evidence, embedding, embed_space)
     VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8)`,
    [
      input.id,
      input.userId,
      input.kind,
      input.tier,
      encryptField(input.content),
      encryptField(input.evidence),
      toVectorLiteral(input.embedding),
      input.embedSpace,
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
    `SELECT id, user_id, kind, tier, content, evidence, embed_space,
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
