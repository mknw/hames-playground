/**
 * Memories repository (#419 M4) against a real Postgres: the schema ensure,
 * the encryption round trip, owner scoping and cascade delete, by behaviour.
 *
 * The gate is the #460 one, extended for this suite's extra requirement: the
 * `embedding` column needs the pgvector extension, so this file's
 * `dbAvailable` means "a reachable Postgres THAT ALSO HAS pgvector installed
 * in the image" — a reachable plain `postgres:16` is not available for memory.
 * The spec prescribed a per-test conditional skip on vector availability, but
 * the #460 guard's source scan fails any DB test file that skips outside
 * `skipWithoutDatabase` — and in CI's `test · postgres` job (pgvector image,
 * `TEST_DATABASE_REQUIRED=1`) a skip must be impossible. So the gate rides
 * `skipWithoutDatabase` like every other suite: it skips on a developer's
 * vector-less Postgres and THROWS in CI. The substitution is recorded on #419.
 *
 * The same guards are ALSO pinned without a database, on the SQL each
 * function sends: `memories-sql.test.ts` is what CI's `check` job sees.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { skipWithoutDatabase } from '../../test-database'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import {
  COLUMN_CLASSIFICATION,
  deleteAllMemoriesForUser,
  ensureMemoriesSchema,
  insertMemory,
  insertMemorySource,
  isMemoryAvailable,
  listMemoriesForUser,
} from '../../../lib/db/memories.server'
import { closePool, query } from '../../../lib/db/client.server'
import { createConversation, deleteConversations } from '../../../lib/db/conversations.server'
import { ENCRYPTED_TABLES } from '../../../lib/db/migrate-encryption.server'
import { looksEncrypted } from '../../../lib/db/crypto.server'

const tag = Math.random().toString(36).slice(2, 10)
const ALICE = `mem-alice-${tag}`
const BOB = `mem-bob-${tag}`
// Fresh users for the scoping test, so earlier describes' rows for ALICE and
// BOB cannot leak into a list assertion.
const CAROL = `mem-carol-${tag}`
const DAVE = `mem-dave-${tag}`
let n = 0
const memoryId = () => `mem-${tag}-${++n}`

/** A deterministic 1024-dim vector, so a round trip can be compared. */
function vec(seed: number): number[] {
  return Array.from({ length: 1024 }, (_, i) => ((seed * (i + 1)) % 17) / 17)
}

let dbAvailable = true
/**
 * The probe's verdict: reachable Postgres AND pgvector installed in the image
 * (`pg_available_extensions`, not `pg_extension` — the tests create the
 * extension themselves via the ensure; what they cannot create is an
 * extension the image does not ship).
 */
let vectorInImage = false

beforeAll(async () => {
  try {
    await query('SELECT 1')
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_available_extensions WHERE name = 'vector'`,
    )
    vectorInImage = (rows[0]?.n ?? 0) > 0
  } catch (err) {
    dbAvailable = false
    console.warn('[memories.test] Postgres unreachable, skipping:', err)
    return
  }
  dbAvailable = dbAvailable && vectorInImage
  if (!vectorInImage) {
    console.warn(
      '[memories.test] Postgres reachable but the pgvector extension is not installed in the ' +
        'image — memory is expected to be unavailable here, so the DB-backed suites skip. ' +
        'Use pgvector/pgvector for a private test Postgres (docs/testing/pyramid.md).',
    )
  }
})

afterAll(async () => {
  if (!dbAvailable) return
  await deleteAllMemoriesForUser(ALICE)
  await deleteAllMemoriesForUser(BOB)
  await deleteAllMemoriesForUser(CAROL)
  await deleteAllMemoriesForUser(DAVE)
  await closePool()
})

// ============================================================================
// The column-classification pin — pure source scan, no database needed
// ============================================================================

describe('column classification (source scan, D2)', () => {
  const SRC = resolve(process.cwd(), 'src/lib/db/memories.server.ts')

  /** Column lines of one CREATE TABLE block in the module's DDL. Type-agnostic
   *  on purpose: the pin must fail on ANY unclassified column, whatever type
   *  it carries — including a type that did not exist when this test was
   *  written. Only SQL constraint keywords are excluded. */
  function ddlColumns(source: string, table: string): string[] {
    const ddl = source.match(/const MEMORY_DDL = `([\s\S]*?)`/)?.[1]
    expect(ddl, 'the module no longer carries a MEMORY_DDL template').toBeTruthy()
    const block = ddl!.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\);`))
    expect(block, `no CREATE TABLE block for ${table} found`).toBeTruthy()
    const constraint = /^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i
    return block![1]
      .split('\n')
      .map((line) => line.trim().match(/^(\w+)\s+(?!\()([\w([]+)/)?.[1])
      .filter((c): c is string => c !== undefined && !constraint.test(c))
  }

  it('classifies every column of both tables, and nothing else', async () => {
    const source = await readFile(SRC, 'utf8')
    for (const table of ['memories', 'memory_sources'] as const) {
      expect(
        new Set(ddlColumns(source, table)),
        `${table}: DDL and COLUMN_CLASSIFICATION must name exactly the same columns`,
      ).toEqual(new Set(Object.keys(COLUMN_CLASSIFICATION[table])))
    }
  })

  it('matches the ENCRYPTED_TABLES registration, and exempts exactly the embedding', async () => {
    const source = await readFile(SRC, 'utf8')
    const spec = ENCRYPTED_TABLES.find((t) => t.table === 'memories')
    expect(spec, 'memories must be registered in ENCRYPTED_TABLES').toBeTruthy()

    const encrypted = Object.entries(COLUMN_CLASSIFICATION.memories)
      .filter(([, v]) => v === 'encrypted')
      .map(([k]) => k)
    expect(encrypted).toEqual([...spec!.textColumns].sort())

    const exceptions = Object.entries(COLUMN_CLASSIFICATION.memories)
      .filter(([, v]) => v === 'declared-exception')
      .map(([k]) => k)
    // One declared exception, and it is the owner's (D2): the embedding. A
    // second plaintext content column must not arrive unannounced.
    expect(exceptions).toEqual(['embedding'])
    expect(ddlColumns(source, 'memories')).toContain('embedding')
  })
})

// ============================================================================
// DB-backed behaviour
// ============================================================================

describe('ensureMemoriesSchema', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it('creates the extension and both tables, and is idempotent', async () => {
    await ensureMemoriesSchema()
    await ensureMemoriesSchema() // a second call is a no-op, not an error
    expect(isMemoryAvailable()).toBe(true)
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_tables
        WHERE tablename IN ('memories', 'memory_sources')`,
    )
    expect(rows[0]?.n).toBe(2)
  })
})

describe('encryption at rest', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it('stores content and evidence as envelopes; the read path decrypts them', async () => {
    const id = memoryId()
    await insertMemory({
      id,
      userId: ALICE,
      kind: 'preference',
      tier: 'verda',
      content: 'I prefer dark mode and short answers',
      evidence: 'I prefer dark mode and short answers',
      embedding: vec(3),
      embedSpace: 'test-space-v1',
    })
    // What landed is ciphertext — at rest, in the row, in a dump of the row.
    const { rows } = await query<Record<string, unknown>>(
      `SELECT content, evidence, user_id, kind, tier, embed_space
         FROM memories WHERE id = $1`,
      [id],
    )
    const raw = rows[0]
    expect(looksEncrypted(raw.content as string), 'content is not an envelope').toBe(true)
    expect(looksEncrypted(raw.evidence as string), 'evidence is not an envelope').toBe(true)
    expect(JSON.stringify(raw)).not.toContain('dark mode')
    // What SQL needs stays readable.
    expect(raw.user_id).toBe(ALICE)
    expect(raw.kind).toBe('preference')
    expect(raw.tier).toBe('verda')

    // The read path hands the plaintext back, and only through the module.
    const [read] = await listMemoriesForUser(ALICE)
    expect(read.content).toBe('I prefer dark mode and short answers')
    expect(read.evidence).toBe('I prefer dark mode and short answers')
    expect(read.embedSpace).toBe('test-space-v1')
  })

  it('stores the embedding as a pgvector literal, lossless to float precision', async () => {
    const id = memoryId()
    const v = vec(7)
    await insertMemory({
      id,
      userId: ALICE,
      kind: 'semantic',
      tier: 'anthropic',
      content: 'the embedder output is not user content (D2)',
      evidence: 'the embedder output is not user content (D2)',
      embedding: v,
      embedSpace: 'test-space-v1',
    })
    const { rows } = await query<{ embedding: string }>(
      `SELECT embedding::text FROM memories WHERE id = $1`,
      [id],
    )
    const stored = rows[0].embedding
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map(Number)
    expect(stored).toHaveLength(1024)
    // `vector` stores float4; compare at its precision.
    for (let i = 0; i < 1024; i++) {
      expect(Math.abs(stored[i] - v[i])).toBeLessThan(1e-6)
    }
  })
})

describe('owner scoping', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it("A's rows are invisible to B, and deleting A's leaves B's", async () => {
    const aId = memoryId()
    const bId = memoryId()
    await insertMemory({
      id: aId,
      userId: CAROL,
      kind: 'episodic',
      tier: 'verda',
      content: 'carol memory',
      evidence: 'carol memory',
      embedding: vec(1),
      embedSpace: 'test-space-v1',
    })
    await insertMemory({
      id: bId,
      userId: DAVE,
      kind: 'episodic',
      tier: 'verda',
      content: 'dave memory',
      evidence: 'dave memory',
      embedding: vec(2),
      embedSpace: 'test-space-v1',
    })

    expect((await listMemoriesForUser(CAROL)).map((m) => m.id)).toEqual([aId])
    expect((await listMemoriesForUser(DAVE)).map((m) => m.id)).toEqual([bId])

    const deleted = await deleteAllMemoriesForUser(CAROL)
    expect(deleted).toBe(1)
    expect((await listMemoriesForUser(CAROL)).length).toBe(0)
    // A foreign id deletes nothing of DAVE's — the owner clause is the guard.
    expect((await listMemoriesForUser(DAVE)).map((m) => m.id)).toEqual([bId])
  })
})

describe('cascade delete', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it('deleting the user’s memories takes the provenance rows with them', async () => {
    // A source row names a conversation that exists (#531's FK).
    const conversationId = `conv-${tag}`
    await createConversation({
      id: conversationId,
      userId: ALICE,
      agentId: 'search',
      title: null,
      serializedContext: '{"events":[]}',
    })
    const id = memoryId()
    await insertMemory({
      id,
      userId: ALICE,
      kind: 'episodic',
      tier: 'verda',
      content: 'memory with a source',
      evidence: 'memory with a source',
      embedding: vec(5),
      embedSpace: 'test-space-v1',
    })
    await insertMemorySource({
      userId: ALICE,
      eventId: `evt-${tag}-1`,
      ordinal: 0,
      memoryId: id,
      conversationId,
    })
    const before = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM memory_sources WHERE memory_id = $1`,
      [id],
    )
    expect(before.rows[0]?.n).toBe(1)

    await deleteAllMemoriesForUser(ALICE)
    // No orphan sources: erasure leaves nothing that points at a dead memory.
    const after = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM memory_sources WHERE memory_id = $1`,
      [id],
    )
    expect(after.rows[0]?.n).toBe(0)
    await deleteConversations([conversationId], ALICE)
  })
})
