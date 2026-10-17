/**
 * Regression pin for PR #533 M2. The erase is gated on
 * the process-sticky `_available` flag, which ANY `CREATE EXTENSION` error sets
 * false (a concurrent first install's unique violation, a transient outage).
 * The memory tables and rows exist all the same.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'

import { skipWithoutDatabase } from '../../test-database'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

let failCreateExtension = true
vi.mock('../../../lib/db/client.server', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../lib/db/client.server')>()
  return {
    ...real,
    query: (text: string, params?: unknown[]) =>
      failCreateExtension && text.includes('CREATE EXTENSION')
        ? Promise.reject(
            Object.assign(
              new Error('duplicate key value violates unique constraint "pg_extension_name_index"'),
              {
                code: '23505',
              },
            ),
          )
        : real.query(text, params),
  }
})

import { closePool, query } from '../../../lib/db/client.server'
import { createConversation, deleteConversation } from '../../../lib/db/conversations.server'

import { ensureMemoriesSchema, resetMemoriesSchemaForTests } from '../../../lib/db/memories.server'

let dbAvailable = true
const tag = Math.random().toString(36).slice(2, 10)
const U = `rv533-sticky-${tag}`
const vec = `[${new Array(1024)
  .fill(0)
  .map((_, i) => (i === 0 ? 1 : 0))
  .join(',')}]`

async function seed(): Promise<{ a: string; m: string }> {
  const a = `conv-${tag}-${Math.random().toString(36).slice(2, 6)}`
  const m = `mem-${tag}-${Math.random().toString(36).slice(2, 6)}`
  await createConversation({
    id: a,
    userId: U,
    agentId: 'search',
    title: null,
    serializedContext: '{"events":[]}',
  })
  // Rows another process wrote: raw SQL, so this process never runs the ensure.
  await query(
    `INSERT INTO memories (id, user_id, kind, tier, content, evidence, embedding, embed_space)
     VALUES ($1, $2, 'semantic', 'verda', 'x', 'x', $3::vector, 'rv')`,
    [m, U, vec],
  )
  await query(
    `INSERT INTO memory_sources (user_id, event_id, ordinal, memory_id, conversation_id) VALUES ($1, $2, 0, $3, $4)`,
    [U, `evt-${m}`, m, a],
  )
  return { a, m }
}
const memExists = async (m: string) =>
  (await query(`SELECT 1 FROM memories WHERE id = $1`, [m])).rows.length > 0

beforeAll(async () => {
  try {
    await query('SELECT 1')
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_available_extensions WHERE name = 'vector'`,
    )
    dbAvailable = (rows[0]?.n ?? 0) > 0
  } catch {
    dbAvailable = false
  }
  if (!dbAvailable) return
  // Another process has already created the tables. Then this process's
  // extension ensure fails transiently and marks memory unavailable.
  failCreateExtension = false
  await ensureMemoriesSchema()
  resetMemoriesSchemaForTests()
  failCreateExtension = true
  await ensureMemoriesSchema()
})

afterAll(async () => {
  if (!dbAvailable) return
  failCreateExtension = false
  await query(`DELETE FROM memories WHERE user_id = $1`, [U])
  await query(`DELETE FROM conversations WHERE user_id = $1`, [U]).catch(() => {})
  await closePool()
})

describe('erase after a transient CREATE EXTENSION failure, tables present', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))
  it('with the FK present: the conversation delete must still erase and succeed', async () => {
    const { a, m } = await seed()
    // Expected after the fix: erase runs (tables exist), delete succeeds.
    await deleteConversation(a, U)
    expect(await memExists(m)).toBe(false)
  })
})
