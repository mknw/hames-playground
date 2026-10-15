/**
 * #585 against a real Postgres, in a database of its own (`hames_test_schema_init`)
 * so no other file's DDL is a party to it. Needs a Postgres (CI `test · postgres`);
 * skips without one, like the other DB-backed files.
 *
 * MUTATION per pin (each run against a throwaway Postgres): delete the
 * `pg_advisory_xact_lock` statement → "waits for the schema lock" reds (the
 * fresh-database race is probabilistic, so it is the regression net, not the
 * discriminator); make the hash check always run the DDL → "takes no table lock"
 * reds (5s timeout).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import pg from 'pg'
import { skipWithoutDatabase } from '../../test-database'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

const DB = 'hames_test_schema_init'
let dbAvailable = true
let target = ''
const closers: Array<() => Promise<void>> = []

/** A fresh module instance = a fresh pool and a fresh once-per-process init. */
async function freshProcess() {
  vi.resetModules()
  process.env.DATABASE_URL = target
  const mod = await import('../../../lib/db/client.server')
  const hitl = await import('../../../lib/db/hitl.server')
  closers.push(async () => {
    hitl.stopHitlSweepTimer()
    await mod.closePool()
  })
  return mod
}

const settlesWithin = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => true), new Promise<boolean>((r) => setTimeout(() => r(false), ms))])

beforeAll(async () => {
  try {
    const base = new URL(process.env.DATABASE_URL!)
    const admin = new URL(base)
    admin.pathname = '/postgres'
    const t = new URL(base)
    t.pathname = `/${DB}`
    target = t.toString()
    const c = new pg.Client({ connectionString: admin.toString() })
    await c.connect()
    try {
      await c.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`)
      await c.query(`CREATE DATABASE ${DB}`)
    } finally {
      await c.end()
    }
  } catch (err) {
    dbAvailable = false
    console.warn('[schema-init-lock-db] Postgres unreachable, skipping:', err)
  }
})
afterAll(async () => {
  for (const close of closers) await close().catch(() => undefined)
})

describe('initSchema against one database', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it('two concurrent initialisers on a fresh database both complete', async () => {
    const [a, b] = await Promise.all([freshProcess(), freshProcess()])
    const done = Promise.all([a.query('SELECT 1'), b.query('SELECT 1')])
    expect(await settlesWithin(done, 30_000)).toBe(true)
    await done
  })

  it('waits for the schema lock instead of running the DDL past it', async () => {
    const holder = new pg.Client({ connectionString: target })
    await holder.connect()
    await holder.query('BEGIN')
    await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('hames:schema-init', 0))`)
    try {
      const proc = await freshProcess()
      const init = proc.query('SELECT 1')
      expect(await settlesWithin(init, 1_000)).toBe(false)
      await holder.query('COMMIT')
      expect(await settlesWithin(init, 30_000)).toBe(true)
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined)
      await holder.end()
    }
  })

  it('takes no table lock on a boot where the schema is current', async () => {
    const reader = new pg.Client({ connectionString: target })
    await reader.connect()
    await reader.query('BEGIN')
    await reader.query('LOCK TABLE conversations IN ACCESS SHARE MODE')
    try {
      // ADD COLUMN IF NOT EXISTS would queue behind the reader's lock forever.
      const proc = await freshProcess()
      expect(await settlesWithin(proc.query('SELECT 1'), 10_000)).toBe(true)
    } finally {
      await reader.query('ROLLBACK').catch(() => undefined)
      await reader.end()
    }
  })
})
