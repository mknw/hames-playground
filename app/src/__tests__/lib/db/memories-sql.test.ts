/**
 * Memories repository (#419 M4), WITHOUT a database: the fail policy, the
 * owner scoping and the encryption are pinned on the statements each function
 * sends — the same split as `skills-sql.test.ts`. CI has no Postgres in the
 * `check` job, so the behavioural suite (`memories.test.ts`) skips there and
 * this file is what the merge gate sees.
 *
 * It is also the only place the missing-extension fail policy can be tested
 * on a vector-capable CI image: the policy is a code decision (catch the
 * `CREATE EXTENSION` failure, disable memory, keep the database up), so the
 * mock makes the extension fail and the assertions hold it to the policy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

interface Sent {
  sql: string
  params: unknown[]
}
const sent: Sent[] = []
let failOn: (sql: string) => boolean = () => false
let reply: (sql: string) => { rows: unknown[]; rowCount?: number } = () => ({ rows: [] })
const mockQuery = async (sql: string, params: unknown[] = []) => {
  if (failOn(sql)) throw new Error(`mocked db failure for: ${sql.trim().slice(0, 40)}`)
  sent.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
  return reply(sql)
}
vi.mock('../../../lib/db/client.server', () => ({
  databaseUrl: () => 'postgresql://x:x@127.0.0.1:59999/x',
  onClosePool: vi.fn(),
  SCHEMA_LOCK_KEY: 'hames:schema-init',
  query: vi.fn(mockQuery),
  // The ensure runs in one transaction (#592); the mock's "transaction" is the same recorder.
  withTransaction: vi.fn(async (fn: (tx: { query: typeof mockQuery }) => unknown) =>
    fn({ query: mockQuery }),
  ),
}))

const repo = await import('../../../lib/db/memories.server')
const { looksEncrypted } = await import('../../../lib/db/crypto.server')

const insert = () =>
  repo.insertMemory({
    id: 'mem-1',
    userId: 'user-a',
    kind: 'preference',
    tier: 'verda',
    content: 'I prefer short answers',
    evidence: 'I prefer short answers',
    embedding: new Array(1024).fill(0.5),
    embedSpace: 'qwen3-0.6b',
  })

/** A database with pgvector installed and no recorded memory DDL hash. */
const defaultReply = (sql: string) =>
  /FROM pg_extension|schema_meta|pg_available_extensions/.test(sql) &&
  !/INSERT INTO schema_meta/.test(sql)
    ? { rows: /FROM pg_extension/.test(sql) ? [{ '?column?': 1 }] : [], rowCount: 1 }
    : { rows: [], rowCount: 1 }

/** Schema-ensure statements keep their default answers; `fn` answers everything else. */
const dataReply = (fn: (sql: string) => { rows: unknown[]; rowCount?: number }) => (sql: string) =>
  /pg_extension|pg_available_extensions|schema_meta|pg_advisory/.test(sql)
    ? defaultReply(sql)
    : fn(sql)

beforeEach(() => {
  sent.length = 0
  failOn = () => false
  reply = defaultReply
  repo.resetMemoriesSchemaForTests()
})

describe('the missing-extension fail policy', () => {
  const noVector = (sql: string) =>
    /FROM pg_extension|pg_available_extensions/.test(sql) ? { rows: [] } : defaultReply(sql)

  it('disables memory, not the database: ensure resolves, no DDL runs, ops get a named error', async () => {
    reply = noVector
    // The ensure must NOT reject — the environment, not a fault.
    await expect(repo.ensureMemoriesSchema()).resolves.toBeUndefined()
    expect(repo.isMemoryAvailable()).toBe(false)
    // Neither the extension nor the tables were attempted.
    expect(sent.filter((s) => /^CREATE (TABLE|EXTENSION)/.test(s.sql))).toHaveLength(0)

    await expect(insert()).rejects.toMatchObject({ name: 'MemoryUnavailableError' })
    await expect(repo.listMemoriesForUser('user-a')).rejects.toMatchObject({
      name: 'MemoryUnavailableError',
    })
    await expect(repo.deleteAllMemoriesForUser('user-a')).rejects.toMatchObject({
      name: 'MemoryUnavailableError',
    })
    expect(sent.filter((s) => s.sql.startsWith('CREATE TABLE'))).toHaveLength(0)
  })

  it('is sticky within the process — a retry does not re-check the catalog per operation', async () => {
    reply = noVector
    await repo.ensureMemoriesSchema()
    const afterFirst = sent.length
    await repo.ensureMemoriesSchema()
    await expect(insert()).rejects.toMatchObject({ name: 'MemoryUnavailableError' })
    expect(sent.length).toBe(afterFirst)
  })

  it('a role that may not CREATE EXTENSION disables memory (the environment, sticky)', async () => {
    reply = (sql) =>
      /FROM pg_extension/.test(sql)
        ? { rows: [] }
        : /pg_available_extensions/.test(sql)
          ? { rows: [{}] }
          : defaultReply(sql)
    failOn = (sql) => {
      if (!sql.includes('CREATE EXTENSION')) return false
      throw Object.assign(new Error('permission denied to create extension'), { code: '42501' })
    }
    await expect(repo.ensureMemoriesSchema()).resolves.toBeUndefined()
    expect(repo.isMemoryAvailable()).toBe(false)
  })

  // A 42501 anywhere but CREATE EXTENSION (a table owner, schema_meta) is a fault, not the environment.
  it('a privilege refusal on the DDL rejects and is not sticky', async () => {
    failOn = (sql) => {
      if (!sql.trim().startsWith('CREATE TABLE')) return false
      throw Object.assign(new Error('must be owner of table conversations'), { code: '42501' })
    }
    await expect(repo.ensureMemoriesSchema()).rejects.toThrow(/must be owner/)
    expect(repo.isMemoryAvailable()).toBe(false)
    failOn = () => false
    await expect(repo.ensureMemoriesSchema()).resolves.toBeUndefined()
    expect(repo.isMemoryAvailable()).toBe(true)
  })

  // #592: any OTHER failure (a lost CREATE EXTENSION race is a unique violation) is
  // not "no pgvector": it rejects, is not sticky, and the next call retries.
  it('a CREATE EXTENSION failure that is not a privilege refusal rejects and retries', async () => {
    reply = (sql) =>
      /FROM pg_extension/.test(sql)
        ? { rows: [] }
        : /pg_available_extensions/.test(sql)
          ? { rows: [{}] }
          : defaultReply(sql)
    failOn = (sql) => sql.includes('CREATE EXTENSION')
    await expect(repo.ensureMemoriesSchema()).rejects.toThrow(/mocked db failure/)
    expect(repo.isMemoryAvailable()).toBe(false)
    failOn = () => false
    await expect(repo.ensureMemoriesSchema()).resolves.toBeUndefined()
    expect(repo.isMemoryAvailable()).toBe(true)
  })

  it('a DDL failure (not the extension) still rejects and retries on the next call', async () => {
    failOn = (sql) => sql.trim().startsWith('CREATE TABLE')
    await expect(repo.ensureMemoriesSchema()).rejects.toThrow(/mocked db failure for: CREATE TABLE/)
    failOn = () => false
    await expect(repo.ensureMemoriesSchema()).resolves.toBeUndefined()
    expect(repo.isMemoryAvailable()).toBe(true)
  })
})

describe('the ensure takes the schema lock first, then the extension, then the DDL', () => {
  it('lock precedes everything; one DDL statement names both tables and records its hash', async () => {
    await repo.ensureMemoriesSchema()
    // Isolation pinned first (the waiter's snapshot must postdate the lock grant), then the lock.
    expect(sent[0]?.sql).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED')
    expect(sent[1]?.sql).toContain('pg_advisory_xact_lock')
    expect(sent[1]?.params).toEqual(['hames:schema-init'])
    const ddl = sent.filter((s) => s.sql.startsWith('CREATE TABLE'))
    expect(ddl).toHaveLength(1)
    expect(ddl[0]!.sql).toContain('CREATE TABLE IF NOT EXISTS memories')
    expect(ddl[0]!.sql).toContain('CREATE TABLE IF NOT EXISTS memory_sources')
    expect(sent.some((s) => s.sql.startsWith('INSERT INTO schema_meta'))).toBe(true)
    // Spec §5: no tsvector, no ANN index in v1 — recall is exact by construction.
    expect(sent.some((s) => /tsvector|hnsw|ivfflat/i.test(s.sql))).toBe(false)
  })

  it('the DDL is bounded by lock_timeout, set inside the transaction before it runs', async () => {
    await repo.ensureMemoriesSchema()
    const at = (re: RegExp) => sent.findIndex((x) => re.test(x.sql))
    expect(at(/^SET LOCAL lock_timeout = \d+$/)).toBeGreaterThan(at(/pg_advisory_xact_lock/))
    expect(at(/^SET LOCAL lock_timeout/)).toBeLessThan(at(/^CREATE TABLE IF NOT EXISTS memories/))
  })

  it('shares the lock key with client.server.ts instead of repeating the literal', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync('src/lib/db/memories.server.ts', 'utf8')
    expect(src).not.toContain('hames:schema-init')
    expect(src).toMatch(/SCHEMA_LOCK_KEY,\s*\n\s*withTransaction/)
  })

  it('an extension already installed is never CREATEd again', async () => {
    await repo.ensureMemoriesSchema()
    expect(sent.some((s) => s.sql.includes('CREATE EXTENSION'))).toBe(false)
  })
})

describe('every write to a memory row carries ciphertext, and every read is owner-scoped', () => {
  it('insertMemory binds envelopes for content and evidence, and a vector literal', async () => {
    await insert()
    const insertStmt = sent.find((s) => s.sql.startsWith('INSERT INTO memories'))!
    expect(insertStmt).toBeTruthy()
    expect(looksEncrypted(insertStmt.params[4] as string), 'content is plaintext').toBe(true)
    expect(looksEncrypted(insertStmt.params[5] as string), 'evidence is plaintext').toBe(true)
    expect(insertStmt.sql).toContain('$7::vector')
    // The embedding is the declared plaintext exception (D2) — bound as
    // pgvector's text literal, NOT as an envelope.
    expect(insertStmt.params[6]).toBe(`[${new Array(1024).fill(0.5).join(',')}]`)
    // A dump of the statement shows no plaintext content anywhere.
    expect(JSON.stringify(insertStmt)).not.toContain('short answers')
  })

  it('insertMemorySource: the provenance row, unencrypted, all six fields', async () => {
    await repo.insertMemorySource({
      userId: 'user-a',
      eventId: 'evt-1',
      ordinal: 0,
      memoryId: 'mem-1',
      conversationId: 'conv-1',
    })
    const stmt = sent.find((s) => s.sql.startsWith('INSERT INTO memory_sources'))!
    expect(stmt.params).toEqual(['user-a', 'evt-1', 0, 'mem-1', 'conv-1'])
  })

  it('listMemoriesForUser: WHERE user_id, and decrypts with table.column labels', async () => {
    const { encryptField } = await import('../../../lib/db/crypto.server')
    reply = dataReply(() => ({
      rows: [
        {
          id: 'mem-1',
          user_id: 'user-a',
          kind: 'preference',
          tier: 'verda',
          content: encryptField('I prefer short answers'),
          evidence: encryptField('I prefer short answers'),
          embed_space: 'qwen3-0.6b',
          evidence_count: 1,
          compacted_from: 1,
          created_at: new Date(0),
          last_seen_at: new Date(0),
        },
      ],
    }))
    const rows = await repo.listMemoriesForUser('user-a')
    const readStmt = sent.find(
      (s) => s.sql.startsWith('SELECT') && s.sql.includes('FROM memories'),
    )!
    expect(readStmt.sql).toContain('WHERE user_id = $1')
    expect(readStmt.params).toEqual(['user-a'])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe('I prefer short answers')
    expect(rows[0]!.evidence).toBe('I prefer short answers')
  })

  // Forget-all now uses a dedicated-pool transaction (#552). Its owner scope,
  // count and cascade are pinned on real Postgres in memories.test.ts;
  // lock interleavings and retryable failures in memories-db-store.test.ts.
})

describe('#531: the conversation-delete erase, by the SQL it sends', () => {
  const txSent: Sent[] = []
  let tablesPresent = true
  const tx = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      txSent.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
      return sql.startsWith('SELECT to_regclass')
        ? { rows: [{ present: tablesPresent }] }
        : { rows: [], rowCount: 3 }
    }),
  }
  beforeEach(() => {
    txSent.length = 0
    tablesPresent = true
  })

  it('erases WHOLE memories reached through ANY source row, owner-scoped on both tables, on the caller’s transaction', async () => {
    const n = await repo.deleteMemoriesForConversations(['conv-a', 'conv-b'], 'user-a', tx as never)
    expect(n).toBe(3)
    // Nothing went through the module-level query for the erase itself.
    expect(sent.some((s) => s.sql.startsWith('DELETE FROM memories'))).toBe(false)
    const del = txSent.find((s) => s.sql.startsWith('DELETE FROM memories'))!
    expect(del.params).toEqual([['conv-a', 'conv-b'], 'user-a'])
    // The memory's owner AND the source row's owner: a foreign user's rows
    // naming the same conversation id are never reached.
    expect(del.sql.match(/user_id = \$2/g)).toHaveLength(2)
    expect(del.sql).toContain('id IN (SELECT memory_id FROM memory_sources')
    expect(del.sql).toContain('conversation_id = ANY($1)')
    // "Only memories left with no source" is the reading decision (b) rejected.
    expect(del.sql).not.toMatch(/NOT EXISTS|<> ALL/i)
  })

  it('bounds the lock wait for the rest of the caller’s transaction, before the erase', async () => {
    await repo.deleteMemoriesForConversations(['conv-a'], 'user-a', tx as never)
    expect(txSent[0]!.sql).toBe("SELECT to_regclass('memory_sources') IS NOT NULL AS present")
    expect(txSent[1]!.sql).toBe(`SET LOCAL lock_timeout = ${repo.MEMORY_LOCK_TIMEOUT_MS}`)
  })

  it('no ids: nothing sent. No tables: only the probe, no DELETE, and NOT an error', async () => {
    expect(await repo.deleteMemoriesForConversations([], 'user-a', tx as never)).toBe(0)
    expect(txSent).toHaveLength(0)
    tablesPresent = false
    expect(await repo.deleteMemoriesForConversations(['conv-a'], 'user-a', tx as never)).toBe(0)
    expect(txSent).toHaveLength(1)
    expect(txSent[0]!.sql).toBe("SELECT to_regclass('memory_sources') IS NOT NULL AS present")
    expect(txSent.some((s) => s.sql.startsWith('DELETE'))).toBe(false)
  })

  it('erases on tx even after the extension was found missing while the tables exist', async () => {
    reply = (sql) =>
      /pg_extension|pg_available_extensions/.test(sql) ? { rows: [] } : defaultReply(sql)
    await repo.ensureMemoriesSchema()
    expect(repo.isMemoryAvailable()).toBe(false)
    expect(await repo.deleteMemoriesForConversations(['conv-a'], 'user-a', tx as never)).toBe(3)
    expect(txSent.some((s) => s.sql.startsWith('DELETE FROM memories'))).toBe(true)
  })

  it('the DDL keeps the conversation FK NO ACTION (never CASCADE) and the evidence_event_id column', async () => {
    await repo.ensureMemoriesSchema()
    const ddl = sent.find((s) => s.sql.startsWith('CREATE TABLE'))!.sql
    expect(ddl).toMatch(
      /FOREIGN KEY \(conversation_id, user_id\) REFERENCES conversations \(id, user_id\) NOT VALID/,
    )
    expect(ddl).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS conversations_id_user_key ON conversations (id, user_id)',
    )
    expect(ddl).toContain(
      'CREATE INDEX IF NOT EXISTS memory_sources_conv_idx ON memory_sources (conversation_id, user_id)',
    )
    expect(ddl).toContain(
      'CREATE INDEX IF NOT EXISTS memory_sources_memory_idx ON memory_sources (memory_id)',
    )
    const fk = ddl.slice(ddl.indexOf('memory_sources_conversation_fk'))
    expect(fk).not.toMatch(/ON DELETE CASCADE/i)
    expect(ddl).toContain('ALTER TABLE memories ADD COLUMN IF NOT EXISTS evidence_event_id TEXT')
  })
})

// M5c reconciliation reads source facts, never trusts a blob to restore a row.
it('reconciliation source rows are scoped to both source and memory owner', async () => {
  await repo.listMemorySourcesForConversation('conversation-a', 'owner-a')
  const statement = sent.find((s) => s.sql.includes('JOIN memories m'))!
  expect(statement.params).toEqual(['conversation-a', 'owner-a'])
  expect(statement.sql).toContain('s.conversation_id = $1')
  expect(statement.sql).toContain('s.user_id = $2')
  expect(statement.sql).toContain('m.user_id = $2')
  expect(statement.sql).toContain('s.event_id')
  expect(statement.sql).toContain('s.ordinal')
})

describe('M7 row erase and access export', () => {
  it('erases only the requested owner and row under the shared owner lock', async () => {
    const txSql: Sent[] = []
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        txSql.push({ sql, params })
        return { rows: [], rowCount: 1 }
      }),
      on: vi.fn(),
      off: vi.fn(),
      release: vi.fn(),
    }
    const connect = vi.spyOn(repo.getMemoryPool(), 'connect').mockResolvedValue(client as never)
    try {
      await repo.deleteMemoryForUser('synthetic-owner', 'synthetic-memory')
      expect(txSql.find((s) => s.sql.includes('DELETE FROM memories'))).toEqual({
        sql: 'DELETE FROM memories WHERE user_id = $1 AND id = $2',
        params: ['synthetic-owner', 'synthetic-memory'],
      })
      expect(txSql.findIndex((s) => s.sql.includes('pg_advisory_xact_lock'))).toBeLessThan(
        txSql.findIndex((s) => s.sql.includes('DELETE FROM memories')),
      )
      expect(txSql.at(-1)?.sql).toBe('COMMIT')
      expect(client.release).toHaveBeenCalled()
    } finally {
      connect.mockRestore()
    }
  })
  it('exports decrypted contents, evidence, vectors and all provenance only for the owner', async () => {
    const { encryptField } = await import('../../../lib/db/crypto.server')
    const source = { event_id: 'synthetic-event', conversation_id: 'synthetic-conversation' }
    reply = dataReply((sql) =>
      sql.includes('SELECT m.*')
        ? {
            rows: [
              {
                id: 'synthetic-memory',
                content: encryptField('Synthetic content'),
                evidence: encryptField('Synthetic evidence'),
                embedding: '[1,0]',
                sources: [source],
              },
            ],
          }
        : { rows: [] },
    )
    const out = await repo.exportMemoryDataForUser('synthetic-owner')
    expect(out).toEqual([
      {
        id: 'synthetic-memory',
        content: 'Synthetic content',
        evidence: 'Synthetic evidence',
        embedding: '[1,0]',
        sources: [source],
      },
    ])
    const select = sent.find((s) => s.sql.includes('SELECT m.*'))!
    expect(select.params).toEqual(['synthetic-owner'])
    expect(select.sql).toContain('m.user_id = $1')
    expect(select.sql).toContain('s.user_id = $1 AND s.memory_id = m.id')
  })
})
