/**
 * #592 against a real Postgres with pgvector, in databases of its own
 * (`hames_test_mem_schema*`). Needs the pgvector CI image; skips without a
 * database, like the other DB-backed files.
 *
 * MUTATION per pin (each run against a throwaway Postgres):
 * - delete the `pg_advisory_xact_lock` statement in `applyMemorySchema` → "waits for
 *   the schema lock" reds (the deterministic discriminator; the concurrent-boot pin
 *   is a regression net, since without the lock the race is probabilistic);
 * - restore the old catch-all (`catch { _available = false; return }` around
 *   `CREATE EXTENSION`) → "a lost CREATE EXTENSION race is not sticky" reds;
 * - make the hash gate always run the DDL → "takes no table lock" reds (timeout);
 * - drop the relation check (`current` stays true) → "recreates an index dropped by
 *   hand" reds.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import pg from 'pg'
import { skipWithoutDatabase } from '../../test-database'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

const DB = 'hames_test_mem_schema'
let dbAvailable = true
let admin = ''
let target = ''
const closers: Array<() => Promise<void>> = []

/** A fresh module instance = a fresh pool and a fresh once-per-process ensure. */
async function freshProcess() {
  vi.resetModules()
  process.env.DATABASE_URL = target
  const client = await import('../../../lib/db/client.server')
  const hitl = await import('../../../lib/db/hitl.server')
  const memories = await import('../../../lib/db/memories.server')
  closers.push(async () => {
    hitl.stopHitlSweepTimer()
    await client.closePool()
  })
  return { client, memories }
}

/** An empty database: no pgvector extension in it yet. */
async function recreate() {
  const c = new pg.Client({ connectionString: admin })
  await c.connect()
  try {
    await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`)
    await c.query(`CREATE DATABASE ${DB}`)
  } finally {
    await c.end()
  }
}

const settlesWithin = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))])

beforeAll(async () => {
  try {
    const base = new URL(process.env.DATABASE_URL!)
    const a = new URL(base)
    a.pathname = '/postgres'
    admin = a.toString()
    const t = new URL(base)
    t.pathname = `/${DB}`
    target = t.toString()
    await recreate()
  } catch (err) {
    dbAvailable = false
    console.warn('[memories-schema-lock-db] Postgres unreachable, skipping:', err)
  }
})
afterAll(async () => {
  for (const close of closers) await close().catch(() => undefined)
})

describe('ensureMemoriesSchema against one database', () => {
  beforeEach(async (ctx) => {
    skipWithoutDatabase(ctx, dbAvailable)
    await recreate()
  })

  // `freshProcess()` calls are awaited in SEQUENCE: interleaved, both resolve to the
  // same module instance and the "race" is one initialiser.
  it('two concurrent first boots on a database without the extension both end available', async () => {
    const a = await freshProcess()
    const b = await freshProcess()
    expect(a.memories).not.toBe(b.memories)
    await Promise.all([a.memories.ensureMemoriesSchema(), b.memories.ensureMemoriesSchema()])
    expect(a.memories.isMemoryAvailable()).toBe(true)
    expect(b.memories.isMemoryAvailable()).toBe(true)
  })

  it('a lost CREATE EXTENSION race is not sticky: memory ends available', async () => {
    const proc = await freshProcess()
    await proc.client.query('SELECT 1') // main schema ready; the extension is still absent
    // A rival creates the extension WITHOUT our lock (another tool, an older binary)
    // and holds its transaction open while the ensure reaches its own CREATE.
    const rival = new pg.Client({ connectionString: target })
    await rival.connect()
    try {
      await rival.query('BEGIN')
      await rival.query('CREATE EXTENSION vector')
      const ensure = proc.memories.ensureMemoriesSchema().then(
        () => 'ok',
        () => 'rejected',
      )
      expect(await settlesWithin(ensure, 1_000)).toBe(false) // blocked on the rival's pg_extension row
      await rival.query('COMMIT')
      await ensure
    } finally {
      await rival.query('ROLLBACK').catch(() => undefined)
      await rival.end()
    }
    // A unique violation is a rejection the next call retries — never "no pgvector".
    await proc.memories.ensureMemoriesSchema()
    expect(proc.memories.isMemoryAvailable()).toBe(true)
  })

  it('waits for the schema lock instead of running past it', async () => {
    const holder = new pg.Client({ connectionString: target })
    await holder.connect()
    const proc = await freshProcess()
    await proc.client.query('SELECT 1') // main init done and its lock released
    await holder.query('BEGIN')
    await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('hames:schema-init', 0))`)
    try {
      const ensure = proc.memories.ensureMemoriesSchema()
      expect(await settlesWithin(ensure, 1_000)).toBe(false)
      await holder.query('COMMIT')
      expect(await settlesWithin(ensure, 30_000)).toBe(true)
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await holder.end()
    }
  })

  it('takes no table lock on a boot where the memory schema is current', async () => {
    const seed = await freshProcess()
    await seed.memories.ensureMemoriesSchema()
    const reader = new pg.Client({ connectionString: target })
    await reader.connect()
    await reader.query('BEGIN')
    await reader.query('LOCK TABLE memories, conversations IN ACCESS SHARE MODE')
    try {
      // ALTER TABLE ... ADD COLUMN IF NOT EXISTS would queue behind the reader forever.
      const proc = await freshProcess()
      expect(await settlesWithin(proc.memories.ensureMemoriesSchema(), 10_000)).toBe(true)
      expect(proc.memories.isMemoryAvailable()).toBe(true)
    } finally {
      await reader.query('ROLLBACK').catch(() => undefined)
      await reader.end()
    }
  })

  it('recreates an index dropped by hand even though the hash is current', async () => {
    const seed = await freshProcess()
    await seed.memories.ensureMemoriesSchema()
    await seed.client.query('DROP INDEX memory_sources_memory_idx')
    const proc = await freshProcess()
    await proc.memories.ensureMemoriesSchema()
    const { rows } = await proc.client.query(
      `SELECT to_regclass('memory_sources_memory_idx') IS NOT NULL AS present`,
    )
    expect(rows[0].present).toBe(true)
  })

  /** A reader holding `mode` on `table`, released by the caller. */
  async function holdLock(table: string, mode: string) {
    const c = new pg.Client({ connectionString: target })
    await c.connect()
    await c.query('BEGIN')
    await c.query(`LOCK TABLE ${table} IN ${mode} MODE`)
    return c
  }
  const release = async (c: pg.Client) => {
    await c.query('ROLLBACK').catch(() => undefined)
    await c.end()
  }

  // #592 review 1: the DDL path holds the shared schema lock, so its wait must be bounded.
  it('the DDL path gives up on a held memories lock with 55P03, then retries to available', async () => {
    const seed = await freshProcess()
    await seed.memories.ensureMemoriesSchema()
    await seed.client.query(`DELETE FROM schema_meta WHERE key = 'memory_ddl_hash'`)
    const reader = await holdLock('memories', 'ACCESS SHARE')
    const proc = await freshProcess()
    try {
      const outcome = proc.memories.ensureMemoriesSchema().then(
        () => 'ok',
        (e: { code?: string }) => e.code,
      )
      expect(await settlesWithin(outcome, 15_000)).toBe(true)
      expect(await outcome).toBe('55P03')
      expect(proc.memories.isMemoryAvailable()).toBe(false) // not sticky-off by a verdict: it simply is not ready
    } finally {
      await release(reader)
    }
    await proc.memories.ensureMemoriesSchema()
    expect(proc.memories.isMemoryAvailable()).toBe(true)
  }, 30_000)

  // #592 review 5: the hash commits atomically with the DDL — a DDL that fails midway leaves neither.
  it('a DDL that fails midway rolls back its earlier statements and records no hash', async () => {
    const seed = await freshProcess()
    await seed.memories.ensureMemoriesSchema()
    await seed.client.query(`DELETE FROM schema_meta WHERE key = 'memory_ddl_hash'`)
    await seed.client.query('DROP INDEX memories_user_idx') // recreated BEFORE the statement that blocks
    const writer = await holdLock('memory_sources', 'ROW EXCLUSIVE') // CREATE INDEX IF NOT EXISTS needs SHARE
    const proc = await freshProcess()
    try {
      await expect(proc.memories.ensureMemoriesSchema()).rejects.toMatchObject({ code: '55P03' })
    } finally {
      await release(writer)
    }
    const { rows } = await proc.client.query(
      `SELECT to_regclass('memories_user_idx') IS NOT NULL AS idx,
              EXISTS (SELECT 1 FROM schema_meta WHERE key = 'memory_ddl_hash') AS hash`,
    )
    expect(rows[0]).toEqual({ idx: false, hash: false })
  }, 30_000)

  // #592 review 5: the FK half of the relation check.
  it('re-creates the owner FK dropped by hand even though the hash is current', async () => {
    const seed = await freshProcess()
    await seed.memories.ensureMemoriesSchema()
    await seed.client.query(
      'ALTER TABLE memory_sources DROP CONSTRAINT memory_sources_conversation_owner_fk',
    )
    const proc = await freshProcess()
    await proc.memories.ensureMemoriesSchema()
    const { rows } = await proc.client.query(
      `SELECT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_sources_conversation_owner_fk') AS present`,
    )
    expect(rows[0].present).toBe(true)
  })
})
