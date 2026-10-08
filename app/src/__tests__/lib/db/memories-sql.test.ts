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
vi.mock('../../../lib/db/client.server', () => ({
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    if (failOn(sql)) throw new Error(`mocked db failure for: ${sql.trim().slice(0, 40)}`)
    sent.push({ sql: sql.replace(/\s+/g, ' ').trim(), params })
    return reply(sql)
  }),
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

beforeEach(() => {
  sent.length = 0
  failOn = () => false
  reply = () => ({ rows: [], rowCount: 1 })
  repo.resetMemoriesSchemaForTests()
})

describe('the missing-extension fail policy', () => {
  it('disables memory, not the database: ensure resolves, no DDL runs, ops get a named error', async () => {
    failOn = (sql) => sql.includes('CREATE EXTENSION')
    // The ensure must NOT reject — the environment, not a fault.
    await expect(repo.ensureMemoriesSchema()).resolves.toBeUndefined()
    expect(repo.isMemoryAvailable()).toBe(false)
    // The tables were never attempted: the `vector` type would not resolve.
    expect(sent.filter((s) => s.sql.startsWith('CREATE TABLE'))).toHaveLength(0)

    await expect(insert()).rejects.toMatchObject({ name: 'MemoryUnavailableError' })
    await expect(repo.listMemoriesForUser('user-a')).rejects.toMatchObject({
      name: 'MemoryUnavailableError',
    })
    await expect(repo.deleteAllMemoriesForUser('user-a')).rejects.toMatchObject({
      name: 'MemoryUnavailableError',
    })
    // And the policy never opened the tables' DDL to get there.
    expect(sent.filter((s) => s.sql.startsWith('CREATE TABLE'))).toHaveLength(0)
  })

  it('is sticky within the process — a retry does not re-run CREATE EXTENSION per operation', async () => {
    failOn = (sql) => sql.includes('CREATE EXTENSION')
    await repo.ensureMemoriesSchema()
    const afterFirst = sent.length
    await repo.ensureMemoriesSchema()
    await expect(insert()).rejects.toMatchObject({ name: 'MemoryUnavailableError' })
    expect(sent.length).toBe(afterFirst)
  })

  it('a DDL failure (not the extension) still rejects and retries on the next call', async () => {
    failOn = (sql) => sql.trim().startsWith('CREATE TABLE')
    await expect(repo.ensureMemoriesSchema()).rejects.toThrow(/mocked db failure for: CREATE TABLE/)
    // The rejected memo was dropped, so a later ensure re-attempts — the same
    // transient-failure contract client.server.ts's own ensure keeps.
    failOn = () => false
    await expect(repo.ensureMemoriesSchema()).resolves.toBeUndefined()
    expect(repo.isMemoryAvailable()).toBe(true)
  })
})

describe('the ensure sends the extension first, then the DDL', () => {
  it('CREATE EXTENSION precedes one DDL statement naming both tables', async () => {
    await repo.ensureMemoriesSchema()
    expect(sent[0]?.sql).toBe('CREATE EXTENSION IF NOT EXISTS vector')
    const ddl = sent.filter((s) => s.sql.startsWith('CREATE TABLE'))
    expect(ddl).toHaveLength(1)
    expect(ddl[0]!.sql).toContain('CREATE TABLE IF NOT EXISTS memories')
    expect(ddl[0]!.sql).toContain('CREATE TABLE IF NOT EXISTS memory_sources')
    // Spec §5: no tsvector, no ANN index in v1 — recall is exact by construction.
    expect(sent.some((s) => /tsvector|hnsw|ivfflat/i.test(s.sql))).toBe(false)
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
    reply = () => ({
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
    })
    const rows = await repo.listMemoriesForUser('user-a')
    const readStmt = sent.find((s) => s.sql.startsWith('SELECT'))!
    expect(readStmt.sql).toContain('WHERE user_id = $1')
    expect(readStmt.params).toEqual(['user-a'])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.content).toBe('I prefer short answers')
    expect(rows[0]!.evidence).toBe('I prefer short answers')
  })

  it('deleteAllMemoriesForUser: DELETE FROM memories WHERE user_id = $1, bound to the caller', async () => {
    reply = () => ({ rows: [], rowCount: 2 })
    const deleted = await repo.deleteAllMemoriesForUser('user-a')
    const stmt = sent.find((s) => s.sql.startsWith('DELETE FROM memories'))!
    expect(stmt.sql).toBe('DELETE FROM memories WHERE user_id = $1')
    expect(stmt.params).toEqual(['user-a'])
    expect(deleted).toBe(2)
  })
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

  it('erases on tx even after CREATE EXTENSION failed while the tables exist', async () => {
    failOn = (sql) => sql.includes('CREATE EXTENSION')
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
