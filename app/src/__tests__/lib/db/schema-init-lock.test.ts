/**
 * `initSchema()`'s DDL is serialised and version-gated (#585). Hermetic: `pg` is
 * scripted, so this runs everywhere and pins the SHAPE of the init transaction;
 * `schema-init-lock-db.test.ts` pins the behaviour against a real Postgres.
 *
 * MUTATION per pin (each run): delete the `pg_advisory_xact_lock` statement →
 * "locks first" reds; make the `!==` hash comparison always true → "skips the
 * DDL" reds; drop the ROLLBACK in the catch → "rolls back" reds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const log: string[] = []
let recordedHash: string | undefined
let failOn: string | null = null

vi.mock('pg', () => {
  const client = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      log.push(text.trim().split('\n')[0])
      if (failOn && text.includes(failOn)) throw new Error('boom')
      if (text.includes('SELECT value FROM schema_meta')) {
        return { rows: recordedHash === undefined ? [] : [{ value: recordedHash }] }
      }
      if (text.includes('INSERT INTO schema_meta')) recordedHash = params?.[0] as string
      return { rows: [] }
    }),
    release: vi.fn(),
  }
  class Pool {
    on() {}
    connect = async () => client
    query = async () => ({ rows: [] })
    end = async () => {}
  }
  return { default: { Pool } }
})
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))
vi.mock('../../../lib/db/migrate-encryption.server', () => ({
  EncryptionBootError: class EncryptionBootError extends Error {},
  ensureEncryptionReady: vi.fn(async () => {}),
}))
vi.mock('../../../lib/db/conversations.server', () => ({
  backfillConversationInferenceTier: vi.fn(async () => {}),
}))
vi.mock('../../../lib/db/hitl.server', () => ({ startHitlSweepTimer: vi.fn() }))

const ddlRan = () => log.some((l) => l.startsWith('CREATE TABLE IF NOT EXISTS conversations'))

async function boot() {
  vi.resetModules()
  const { query } = await import('../../../lib/db/client.server')
  await query('SELECT 1')
}

beforeEach(() => {
  log.length = 0
  recordedHash = undefined
  failOn = null
})

describe('initSchema transaction', () => {
  it('locks first: BEGIN, then the advisory lock, before any DDL', async () => {
    await boot()
    expect(log[0]).toBe('BEGIN')
    expect(log[1]).toContain('pg_advisory_xact_lock')
    expect(log.indexOf('COMMIT')).toBeGreaterThan(
      log.findIndex((l) => l.includes('INSERT INTO schema_meta')),
    )
  })

  it('skips the DDL when the recorded hash is current, runs it once otherwise', async () => {
    await boot()
    expect(ddlRan()).toBe(true)
    log.length = 0
    await boot() // recordedHash now holds the hash of this SCHEMA_SQL
    expect(ddlRan()).toBe(false)
    expect(log).toContain('COMMIT')
  })

  it('rolls back and rethrows when the DDL fails, recording nothing', async () => {
    failOn = 'CREATE TABLE IF NOT EXISTS conversations'
    await expect(boot()).rejects.toThrow('boom')
    expect(log).toContain('ROLLBACK')
    expect(recordedHash).toBeUndefined()
  })
})
