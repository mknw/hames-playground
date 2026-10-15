/**
 * `initSchema()`'s DDL is serialised and version-gated (#585). Hermetic: `pg` is
 * scripted, so this runs everywhere and pins the SHAPE of the init transaction;
 * `schema-init-lock-db.test.ts` pins the behaviour against a real Postgres.
 *
 * MUTATION per pin (each run):
 * - delete the `pg_advisory_xact_lock` statement → "locks first" reds;
 * - make the hash comparison always stale → "skips the DDL" reds;
 * - drop the ROLLBACK in the catch → "rolls back" reds;
 * - drop `client.on('error', …)` → "a connection error mid-init rejects" reds;
 * - drop the relation check (`current` stays true) → "re-runs the DDL when a
 *   relation is missing" reds;
 * - return from `initSchema` right after `applySchema` when the DDL was skipped
 *   → "still runs the key check" reds;
 * - plain `BEGIN` → "begins READ COMMITTED" reds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const log: string[] = []
let recordedHash: string | undefined
let relationsPresent = true
let failOn: string | null = null
let emitOnLock: Error | null = null
let listenersAtLock = -1

vi.mock('pg', async () => {
  const { EventEmitter } = await import('node:events')
  class FakeClient extends EventEmitter {
    release = vi.fn()
    async query(text: string, params?: unknown[]) {
      log.push(text.trim().split('\n')[0])
      if (failOn && text.includes(failOn)) throw new Error('boom')
      if (text.includes('pg_advisory_xact_lock')) listenersAtLock = this.listenerCount('error')
      if (text.includes('pg_advisory_xact_lock') && emitOnLock) {
        // pg emits on the checked-out client, and throws if nothing listens
        this.emit('error', emitOnLock)
        throw emitOnLock
      }
      if (text.includes('SELECT value FROM schema_meta')) {
        return { rows: recordedHash === undefined ? [] : [{ value: recordedHash }] }
      }
      if (text.includes('to_regclass')) return { rows: [{ ok: relationsPresent }] }
      if (text.includes('INSERT INTO schema_meta')) recordedHash = params?.[0] as string
      return { rows: [] }
    }
  }
  const client = new FakeClient()
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
const ensureEncryptionReady = vi.fn(async () => {})
vi.mock('../../../lib/db/migrate-encryption.server', () => ({
  EncryptionBootError: class EncryptionBootError extends Error {},
  ensureEncryptionReady: (...a: unknown[]) =>
    (ensureEncryptionReady as never as (...x: unknown[]) => unknown)(...a),
}))
const backfill = vi.fn(async () => {})
vi.mock('../../../lib/db/conversations.server', () => ({
  backfillConversationInferenceTier: (...a: unknown[]) =>
    (backfill as never as (...x: unknown[]) => unknown)(...a),
}))
const sweep = vi.fn()
vi.mock('../../../lib/db/hitl.server', () => ({ startHitlSweepTimer: () => sweep() }))

const ddlRan = () => log.some((l) => l.startsWith('CREATE TABLE IF NOT EXISTS conversations'))

async function boot() {
  vi.resetModules()
  const { query } = await import('../../../lib/db/client.server')
  await query('SELECT 1')
}

beforeEach(() => {
  log.length = 0
  recordedHash = undefined
  relationsPresent = true
  failOn = null
  emitOnLock = null
  listenersAtLock = -1
  ensureEncryptionReady.mockClear()
  backfill.mockClear()
  sweep.mockClear()
})

describe('initSchema transaction', () => {
  it('locks first: BEGIN, then the advisory lock, before any DDL', async () => {
    await boot()
    expect(log[0]).toMatch(/^BEGIN/)
    expect(log[1]).toContain('pg_advisory_xact_lock')
    expect(log.indexOf('COMMIT')).toBeGreaterThan(
      log.findIndex((l) => l.includes('INSERT INTO schema_meta')),
    )
  })

  it('begins READ COMMITTED, so the hash read follows the lock grant', async () => {
    await boot()
    expect(log[0]).toBe('BEGIN ISOLATION LEVEL READ COMMITTED')
  })

  it('skips the DDL when the recorded hash is current, runs it once otherwise', async () => {
    await boot()
    expect(ddlRan()).toBe(true)
    log.length = 0
    await boot() // recordedHash now holds the hash of this SCHEMA_SQL
    expect(ddlRan()).toBe(false)
    expect(log).toContain('COMMIT')
  })

  it('still runs the key check, backfill and sweep when the DDL is skipped', async () => {
    await boot()
    ensureEncryptionReady.mockClear()
    backfill.mockClear()
    sweep.mockClear()
    log.length = 0
    await boot()
    expect(ddlRan()).toBe(false)
    expect(ensureEncryptionReady).toHaveBeenCalledTimes(1)
    expect(backfill).toHaveBeenCalledTimes(1)
    expect(sweep).toHaveBeenCalledTimes(1)
  })

  it('re-runs the DDL when the hash is current but a relation is missing', async () => {
    await boot()
    log.length = 0
    relationsPresent = false
    await boot()
    expect(ddlRan()).toBe(true)
  })

  it('rolls back and rethrows when the DDL fails, recording nothing', async () => {
    failOn = 'CREATE TABLE IF NOT EXISTS conversations'
    await expect(boot()).rejects.toThrow('boom')
    expect(log).toContain('ROLLBACK')
    expect(recordedHash).toBeUndefined()
  })

  it('a connection error mid-init rejects the init instead of throwing out of the emitter', async () => {
    emitOnLock = new Error('terminating connection')
    await expect(boot()).rejects.toThrow('terminating connection')
    // the checked-out client has no pool listener: ours must be attached
    expect(listenersAtLock).toBeGreaterThanOrEqual(1)
  })
})
