/**
 * #419 M5b + #531 against a real Postgres WITH pgvector: the DB-backed recall
 * and write stores, the dedicated memory-write pool, `user_prefs.memory_enabled`,
 * `evidence_event_id`, and — the hard precondition of M5c — that EVERY
 * conversation delete erases the whole memory of every memory that ever drew on
 * it, in the same transaction.
 *
 * Same gate as `memories.test.ts`: `skipWithoutDatabase` on a probe of "a
 * reachable Postgres whose image ships pgvector". CI's `test · postgres` job
 * (pgvector image, `TEST_DATABASE_REQUIRED=1`) cannot skip these. Synthetic ids
 * and text only.
 *
 * Every pin names the mutation that turns it red in the PR body; the comments
 * here say which assertion each guards.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { skipWithoutDatabase } from '../../test-database'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import {
  MEMORY_LOCK_TIMEOUT_MS,
  MEMORY_POOL_APPLICATION_NAME,
  MEMORY_POOL_MAX,
  createMemoryDbStore,
  deleteAllMemoriesForUser,
  deleteMemoriesForConversations,
  getMemoryPool,
  insertMemory,
  insertMemorySource,
  isMemoryLockTimeout,
  listMemoriesForUser,
} from '../../../lib/db/memories.server'
import { closePool, query, withTransaction } from '../../../lib/db/client.server'
import {
  createConversation,
  deleteConversation,
  deleteConversations,
} from '../../../lib/db/conversations.server'
import { getMemoryEnabled, setStoredInferenceTier } from '../../../lib/db/user-prefs.server'

const tag = Math.random().toString(36).slice(2, 10)
const ALICE = `m5b-alice-${tag}`
const BOB = `m5b-bob-${tag}`
const USERS = [ALICE, BOB, `${ALICE}-near`]
let n = 0
const id = (p: string) => `${p}-${tag}-${++n}`

/** A deterministic unit-ish 1024-dim vector along one axis, so cosine
 *  distances between seeds are exact: same seed → 0, different seed → 1. */
function axis(k: number): number[] {
  const v = new Array<number>(1024).fill(0)
  v[k] = 1
  return v
}
const SPACE = 'test-space-v1'

let dbAvailable = true
const createdConversations: Array<{ id: string; userId: string }> = []

async function conv(userId: string): Promise<string> {
  const cid = id('conv')
  await createConversation({
    id: cid,
    userId,
    agentId: 'search',
    title: null,
    serializedContext: '{"events":[]}',
  })
  createdConversations.push({ id: cid, userId })
  return cid
}

/** A memory with sources from the given conversations (event ids unique). */
async function memorySourcedFrom(
  userId: string,
  convIds: string[],
  extra: { embedding?: number[]; tier?: 'verda' | 'anthropic'; content?: string } = {},
): Promise<string> {
  const mid = id('mem')
  await insertMemory({
    id: mid,
    userId,
    kind: 'semantic',
    tier: extra.tier ?? 'verda',
    content: extra.content ?? 'synthetic fact about a synthetic user',
    evidence: 'synthetic quote',
    embedding: extra.embedding ?? axis(0),
    embedSpace: SPACE,
  })
  let ord = 0
  for (const c of convIds) {
    await insertMemorySource({
      userId,
      eventId: id('evt'),
      ordinal: ord++,
      memoryId: mid,
      conversationId: c,
    })
  }
  return mid
}

const memExists = async (mid: string) =>
  (await query(`SELECT 1 FROM memories WHERE id = $1`, [mid])).rows.length > 0
const sourceCount = async (mid: string) =>
  (
    await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM memory_sources WHERE memory_id = $1`,
      [mid],
    )
  ).rows[0]!.n
const convExists = async (cid: string) =>
  (await query(`SELECT 1 FROM conversations WHERE id = $1`, [cid])).rows.length > 0

beforeAll(async () => {
  try {
    await query('SELECT 1')
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_available_extensions WHERE name = 'vector'`,
    )
    dbAvailable = (rows[0]?.n ?? 0) > 0
  } catch (err) {
    dbAvailable = false
    console.warn('[memories-db-store.test] Postgres unreachable, skipping:', err)
  }
})

afterAll(async () => {
  if (!dbAvailable) return
  for (const u of USERS) await deleteAllMemoriesForUser(u)
  for (const c of createdConversations) await deleteConversations([c.id], c.userId)
  await query(`DELETE FROM user_prefs WHERE user_id = ANY($1)`, [USERS])
  await closePool()
})

// ============================================================================
// #531 — every conversation delete erases whole memories, in one transaction
// ============================================================================

describe('#531: conversation delete erases the memories that ever drew on it', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it.each([
    ['deleteConversation', (cid: string) => deleteConversation(cid, ALICE)],
    ['deleteConversations', (cid: string) => deleteConversations([cid], ALICE)],
  ])(
    'pin 1+2 via %s: a memory sourced from A and B dies WHOLE with A; one sourced only from B survives',
    async (_name, del) => {
      const a = await conv(ALICE)
      const b = await conv(ALICE)
      const both = await memorySourcedFrom(ALICE, [a, b])
      const onlyB = await memorySourcedFrom(ALICE, [b])

      await del(a)

      expect(await convExists(a)).toBe(false)
      // Pin 1: erased, and ALL its sources (including the B one) with it.
      expect(await memExists(both)).toBe(false)
      expect(await sourceCount(both)).toBe(0)
      // Pin 2: a memory that never drew on A is untouched, sources included.
      expect(await memExists(onlyB)).toBe(true)
      expect(await sourceCount(onlyB)).toBe(1)
      expect(await convExists(b)).toBe(true)
    },
  )

  it('pin 1 (update shape): a memory whose stale A source and current B source both exist dies with either', async () => {
    const a = await conv(ALICE)
    const b = await conv(ALICE)
    const viaB = await memorySourcedFrom(ALICE, [a, b])
    await deleteConversation(b, ALICE)
    expect(await memExists(viaB)).toBe(false)
    expect(await sourceCount(viaB)).toBe(0)
    await deleteConversation(a, ALICE) // already gone: a no-op, not an error
  })

  it('the batch delete erases for every id in the batch and only those', async () => {
    const a = await conv(ALICE)
    const b = await conv(ALICE)
    const c = await conv(ALICE)
    const ma = await memorySourcedFrom(ALICE, [a])
    const mb = await memorySourcedFrom(ALICE, [b])
    const mc = await memorySourcedFrom(ALICE, [c])
    const deleted = await deleteConversations([a, b], ALICE)
    expect(deleted.sort()).toEqual([a, b].sort())
    expect(await memExists(ma)).toBe(false)
    expect(await memExists(mb)).toBe(false)
    expect(await memExists(mc)).toBe(true)
  })

  it("pin 3: another user's memory is never touched — by the delete, or by the erase called with the wrong owner", async () => {
    const aliceConv = await conv(ALICE)
    const bobConv = await conv(BOB)
    const aliceMem = await memorySourcedFrom(ALICE, [aliceConv])
    const bobMem = await memorySourcedFrom(BOB, [bobConv])

    // Alice deleting her conversation leaves Bob's memory alone.
    await deleteConversation(aliceConv, ALICE)
    expect(await memExists(aliceMem)).toBe(false)
    expect(await memExists(bobMem)).toBe(true)

    // Both users with a source row on the SAME conversation id (the FK keys on
    // the id alone): the erase scoped to one owner leaves the other's memory.
    const shared = await conv(ALICE)
    const sharedAlice = await memorySourcedFrom(ALICE, [shared])
    const sharedBob = await memorySourcedFrom(BOB, [shared])
    await withTransaction((tx) => deleteMemoriesForConversations([shared], BOB, tx))
    expect(await memExists(sharedBob)).toBe(false)
    expect(await memExists(sharedAlice)).toBe(true)
    // Bob's id naming ALICE's conversation never reaches Alice's rows either.
    await withTransaction((tx) => deleteMemoriesForConversations([bobConv], ALICE, tx))
    expect(await memExists(bobMem)).toBe(true)
  })

  it('pin 4: nothing survives an erase for reconcile-on-load to re-derive, and nothing can be written for an erased conversation', async () => {
    // INVARIANT (what M5c's reconcile may rely on): `memory_sources` is the
    // truth reconcile derives a missing `memory_written` from. After a
    // conversation delete (a) no source row of an erased memory remains, in ANY
    // conversation, so there is nothing to re-derive; (b) no source row can be
    // inserted for a conversation that no longer exists (FK), so a settle that
    // was in flight, or a replay of the same event, cannot recreate the memory.
    const a = await conv(ALICE)
    const b = await conv(ALICE)
    const mid = await memorySourcedFrom(ALICE, [a, b])
    await deleteConversation(a, ALICE)

    const left = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM memory_sources WHERE memory_id = $1 OR conversation_id = ANY($2)`,
      [mid, [a, b]],
    )
    expect(left.rows[0]!.n).toBe(0) // (a): B's source went with the memory too

    // (b): replay a settle for an event of the deleted conversation — insert
    // the memory and its source in one write transaction. The whole thing
    // rolls back; no memory row exists afterwards.
    const store = createMemoryDbStore(ALICE)
    const ghost = id('ghost')
    await expect(
      store.transaction(async (tx) => {
        await tx.insert({
          id: ghost,
          kind: 'semantic',
          tier: 'verda',
          content: 'synthetic ghost',
          evidence: 'synthetic ghost',
          embedding: axis(1),
          embedSpace: SPACE,
        })
        await tx.addSource({ memoryId: ghost, eventId: id('evt'), ordinal: 0, conversationId: a })
      }),
    ).rejects.toMatchObject({ code: '23503' })
    expect(await memExists(ghost)).toBe(false)
    expect(await store.transaction((tx) => tx.read(mid))).toBeNull()
  })

  it('tripwire: a raw conversation delete that skipped the erase FAILS (NO ACTION), it does not silently strand the memory', async () => {
    const a = await conv(ALICE)
    const b = await conv(ALICE)
    const mid = await memorySourcedFrom(ALICE, [a, b])
    await expect(query(`DELETE FROM conversations WHERE id = $1`, [a])).rejects.toMatchObject({
      code: '23503',
    })
    // Nothing moved: the conversation, the memory and BOTH sources are intact.
    expect(await convExists(a)).toBe(true)
    expect(await memExists(mid)).toBe(true)
    expect(await sourceCount(mid)).toBe(2)
  })

  it('pin 5: if the conversation delete fails, no memory is erased', async () => {
    const a = await conv(ALICE)
    const mid = await memorySourcedFrom(ALICE, [a])
    const fn = `m5b_block_${tag}`.replace(/[^a-z0-9_]/g, '_')
    await query(
      `CREATE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN IF OLD.id = '${a}' THEN RAISE EXCEPTION 'synthetic delete failure'; END IF; RETURN OLD; END $$`,
    )
    await query(
      `CREATE TRIGGER ${fn} BEFORE DELETE ON conversations FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    )
    try {
      await expect(deleteConversation(a, ALICE)).rejects.toThrow(/synthetic delete failure/)
      await expect(deleteConversations([a], ALICE)).rejects.toThrow(/synthetic delete failure/)
      // The erase ran before the failing statement, in the same transaction:
      // it must have rolled back with it.
      expect(await convExists(a)).toBe(true)
      expect(await memExists(mid)).toBe(true)
      expect(await sourceCount(mid)).toBe(1)
    } finally {
      await query(`DROP TRIGGER ${fn} ON conversations`)
      await query(`DROP FUNCTION ${fn}()`)
    }
  })

  it('deleteAllMemoriesForUser still erases everything for the user', async () => {
    const a = await conv(ALICE)
    const mid = await memorySourcedFrom(ALICE, [a])
    expect(await deleteAllMemoriesForUser(ALICE)).toBeGreaterThanOrEqual(1)
    expect(await memExists(mid)).toBe(false)
    expect(await convExists(a)).toBe(true)
  })
})

// ============================================================================
// The recall store
// ============================================================================

describe('recall store (MemoryStore)', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it('counts and returns candidates of the owner only, in the requested tiers, decrypted, with cosine distance', async () => {
    const c = await conv(ALICE)
    const cb = await conv(BOB)
    const same = await memorySourcedFrom(ALICE, [c], {
      embedding: axis(3),
      content: 'alice verda same-axis',
    })
    const other = await memorySourcedFrom(ALICE, [c], {
      embedding: axis(4),
      content: 'alice verda other-axis',
    })
    const anth = await memorySourcedFrom(ALICE, [c], { tier: 'anthropic', embedding: axis(3) })
    const bobs = await memorySourcedFrom(BOB, [cb], { embedding: axis(3) })

    const store = createMemoryDbStore(ALICE)
    const base = await store.count(['verda'])
    expect(base).toBeGreaterThanOrEqual(2)
    expect(await store.count(['anthropic'])).toBeGreaterThanOrEqual(1)
    expect(await store.count([])).toBe(0)

    const rows = await store.candidates({ embedding: axis(3), tiers: ['verda'] })
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.has(bobs)).toBe(false) // owner scope
    expect(byId.has(anth)).toBe(false) // tier filter
    expect(byId.get(same)!.distance).toBeCloseTo(0, 6)
    expect(byId.get(other)!.distance).toBeCloseTo(1, 6)
    expect(byId.get(same)!.content).toBe('alice verda same-axis') // decrypted
    expect(byId.get(same)!.embedSpace).toBe(SPACE)
    expect(byId.get(same)!.tier).toBe('verda')

    // Bob's store sees Bob's row and none of Alice's.
    const bobRows = await createMemoryDbStore(BOB).candidates({
      embedding: axis(3),
      tiers: ['verda'],
    })
    expect(bobRows.map((r) => r.id)).toContain(bobs)
    expect(bobRows.map((r) => r.id)).not.toContain(same)
  })
})

// ============================================================================
// The write store
// ============================================================================

describe('write store (MemoryWriteStore)', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it('addSource: ON CONFLICT DO NOTHING RETURNING — a replay reports the existing memory and the transaction survives', async () => {
    const c = await conv(ALICE)
    const store = createMemoryDbStore(ALICE)
    const m1 = id('mem')
    const m2 = id('mem')
    const evt = id('evt')
    const out = await store.transaction(async (tx) => {
      const row = (mid: string) => ({
        id: mid,
        kind: 'semantic' as const,
        tier: 'verda',
        content: 'synthetic',
        evidence: 'synthetic',
        embedding: axis(5),
        embedSpace: SPACE,
      })
      await tx.insert(row(m1))
      const first = await tx.addSource({
        memoryId: m1,
        eventId: evt,
        ordinal: 0,
        conversationId: c,
      })
      await tx.insert(row(m2))
      // Same (owner, event, ordinal), different memory: a conflict, not an abort.
      const replay = await tx.addSource({
        memoryId: m2,
        eventId: evt,
        ordinal: 0,
        conversationId: c,
      })
      // The transaction is still usable after the conflict.
      const readBack = await tx.read(m1)
      return { first, replay, readBack }
    })
    expect(out.first).toEqual({ inserted: true })
    expect(out.replay).toEqual({ inserted: false, memoryId: m1 })
    expect(out.readBack).toEqual({ kind: 'semantic', content: 'synthetic' })
  })

  it("read(id) is owner-scoped: another user's memory id reads as null", async () => {
    const cb = await conv(BOB)
    const bobs = await memorySourcedFrom(BOB, [cb])
    expect(await createMemoryDbStore(ALICE).transaction((tx) => tx.read(bobs))).toBeNull()
    expect(await createMemoryDbStore(BOB).transaction((tx) => tx.read(bobs))).not.toBeNull()
  })

  it("nearest/count are owner- and tier-scoped; reinforce/update cannot touch another owner's row", async () => {
    const owner = `${ALICE}-near`
    const ca = await conv(owner)
    const cb = await conv(BOB)
    const mine = await memorySourcedFrom(owner, [ca], { embedding: axis(7) })
    const bobs = await memorySourcedFrom(BOB, [cb], { embedding: axis(7) })
    const store = createMemoryDbStore(owner)
    await store.transaction(async (tx) => {
      const near = await tx.nearest({ embedding: axis(7), embedSpace: SPACE, tier: 'verda' })
      expect(near?.id).toBe(mine)
      expect(near?.similarity).toBeCloseTo(1, 6)
      expect(
        await tx.nearest({ embedding: axis(7), embedSpace: 'other-space', tier: 'verda' }),
      ).toBeNull()
      expect(
        await tx.nearest({ embedding: axis(7), embedSpace: SPACE, tier: 'anthropic' }),
      ).toBeNull()
      expect(await tx.count()).toBeGreaterThanOrEqual(1)
    })
    await expect(store.transaction((tx) => tx.reinforce(bobs))).rejects.toThrow(/not found/)
    await expect(
      store.transaction((tx) =>
        tx.update(bobs, {
          content: 'x',
          evidence: 'x',
          embedding: axis(8),
          embedSpace: SPACE,
        }),
      ),
    ).rejects.toThrow(/not found/)
    const bobRow = (await listMemoriesForUser(BOB)).find((m) => m.id === bobs)!
    expect(bobRow.evidenceCount).toBe(1)
    expect(bobRow.content).toBe('synthetic fact about a synthetic user')
  })

  it('evidence_event_id: stored on insert; replaced WITH evidence on update; source rows untouched', async () => {
    const c1 = await conv(ALICE)
    const c2 = await conv(ALICE)
    const store = createMemoryDbStore(ALICE)
    const mid = id('mem')
    await store.transaction(async (tx) => {
      await tx.insert({
        id: mid,
        kind: 'preference',
        tier: 'verda',
        content: 'first',
        evidence: 'first quote',
        embedding: axis(9),
        embedSpace: SPACE,
        evidenceEventId: 'evt-first',
      } as Parameters<typeof tx.insert>[0])
      await tx.addSource({ memoryId: mid, eventId: id('evt'), ordinal: 0, conversationId: c1 })
    })
    const readEvidence = async () => (await listMemoriesForUser(ALICE)).find((m) => m.id === mid)!
    expect((await readEvidence()).evidenceEventId).toBe('evt-first')

    await store.transaction(async (tx) => {
      await tx.update(mid, {
        content: 'second',
        evidence: 'second quote',
        embedding: axis(9),
        embedSpace: SPACE,
        evidenceEventId: 'evt-second',
      } as Parameters<typeof tx.update>[1])
      await tx.addSource({ memoryId: mid, eventId: id('evt'), ordinal: 0, conversationId: c2 })
    })
    const after = await readEvidence()
    expect(after.evidenceEventId).toBe('evt-second')
    expect(after.evidence).toBe('second quote')
    expect(after.evidenceCount).toBe(2)
    expect(await sourceCount(mid)).toBe(2) // the stale source stays (decision (b))

    // An update that names no event clears the stale id rather than keeping it.
    await store.transaction((tx) =>
      tx.update(mid, {
        content: 'third',
        evidence: 'third',
        embedding: axis(9),
        embedSpace: SPACE,
      }),
    )
    expect((await readEvidence()).evidenceEventId).toBeNull()
  })

  it('a throw inside the transaction rolls back every write in it', async () => {
    const store = createMemoryDbStore(ALICE)
    const mid = id('mem')
    await expect(
      store.transaction(async (tx) => {
        await tx.insert({
          id: mid,
          kind: 'semantic',
          tier: 'verda',
          content: 'x',
          evidence: 'x',
          embedding: axis(10),
          embedSpace: SPACE,
        })
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await memExists(mid)).toBe(false)
  })

  it('stores content as ciphertext (the write path encrypts)', async () => {
    const store = createMemoryDbStore(ALICE)
    const mid = id('mem')
    await store.transaction((tx) =>
      tx.insert({
        id: mid,
        kind: 'semantic',
        tier: 'verda',
        content: 'plain synthetic sentence',
        evidence: 'plain synthetic quote',
        embedding: axis(11),
        embedSpace: SPACE,
      }),
    )
    const { rows } = await query<{ content: string; evidence: string }>(
      `SELECT content, evidence FROM memories WHERE id = $1`,
      [mid],
    )
    expect(rows[0]!.content).not.toContain('plain synthetic')
    expect(rows[0]!.evidence).not.toContain('plain synthetic')
  })
})

// ============================================================================
// Owner decision (c): a dedicated, bounded pool and a lock_timeout
// ============================================================================

describe('memory-write pool (owner decision (c))', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it('is bounded, and a write transaction runs on it — not on the main pool', async () => {
    expect(MEMORY_POOL_MAX).toBeGreaterThan(0)
    expect(MEMORY_POOL_MAX).toBeLessThanOrEqual(4)
    expect(getMemoryPool().options.max).toBe(MEMORY_POOL_MAX)
    expect(getMemoryPool().options.connectionTimeoutMillis).toBeGreaterThan(0)
    expect(getMemoryPool().options.connectionTimeoutMillis).toBeLessThanOrEqual(30_000)

    // While a write transaction is open, the server sees a connection tagged
    // with the memory pool's application_name that is in a transaction.
    const during = await createMemoryDbStore(ALICE).transaction(async (tx) => {
      await tx.count()
      const r = await query<{ n: number }>(
        `SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE application_name = $1 AND datname = current_database()
            AND state IN ('idle in transaction', 'active')`,
        [MEMORY_POOL_APPLICATION_NAME],
      )
      return r.rows[0]!.n
    })
    expect(during).toBeGreaterThanOrEqual(1)
    // …and the main pool's own connection is NOT tagged with it.
    const mainName = await query<{ a: string }>(`SHOW application_name`)
    expect(mainName.rows[0]!.a).not.toBe(MEMORY_POOL_APPLICATION_NAME)
  })

  it('holding every memory connection leaves the main pool answering, and the next memory write fails fast instead of waiting', async () => {
    const store = createMemoryDbStore(ALICE)
    // Occupy the whole memory pool: distinct owners so the advisory lock does
    // not serialize them. Each holds its connection until released.
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const started: Promise<void>[] = []
    const holders: Promise<unknown>[] = []
    for (let i = 0; i < MEMORY_POOL_MAX; i++) {
      let up!: () => void
      started.push(new Promise<void>((r) => (up = r)))
      holders.push(
        createMemoryDbStore(`${ALICE}-hold-${i}`).transaction(async () => {
          up()
          await gate
        }),
      )
    }
    await Promise.all(started)
    try {
      // The main pool is untouched.
      const t0 = Date.now()
      await query('SELECT 1')
      expect(Date.now() - t0).toBeLessThan(1000)
      // A further memory write waits for a connection only up to the bound.
      const t1 = Date.now()
      await expect(store.transaction(async () => undefined)).rejects.toThrow(/timeout/i)
      expect(Date.now() - t1).toBeLessThan(getMemoryPool().options.connectionTimeoutMillis! + 3000)
    } finally {
      release()
      await Promise.all(holders)
    }
  }, 20_000)

  it('a second store for the same owner gives up at lock_timeout (55P03) instead of queueing behind the first', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let up!: () => void
    const started = new Promise<void>((r) => (up = r))
    const owner = `${ALICE}-lock`
    const first = createMemoryDbStore(owner).transaction(async () => {
      up()
      await gate
    })
    await started
    const t0 = Date.now()
    let err: unknown
    try {
      await createMemoryDbStore(owner).transaction(async () => undefined)
    } catch (e) {
      err = e
    }
    const waited = Date.now() - t0
    // Release only AFTER measuring: without a lock_timeout the second call
    // would still be waiting here, and the assertions below would not hold.
    release()
    await first
    expect(isMemoryLockTimeout(err)).toBe(true)
    expect(waited).toBeGreaterThanOrEqual(MEMORY_LOCK_TIMEOUT_MS - 500)
    expect(waited).toBeLessThan(MEMORY_LOCK_TIMEOUT_MS + 4000)
  }, 20_000)
})

// ============================================================================
// G9 Q3: user_prefs.memory_enabled
// ============================================================================

describe('user_prefs.memory_enabled (G9 Q3)', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it('is false for a user with no row and for a row that never set it; true only once set', async () => {
    const u = `${ALICE}-prefs`
    expect(await getMemoryEnabled(u)).toBe(false) // no row
    await setStoredInferenceTier(u, 'anthropic') // a row, tier only
    expect(await getMemoryEnabled(u)).toBe(false) // DEFAULT FALSE
    await query(`UPDATE user_prefs SET memory_enabled = TRUE WHERE user_id = $1`, [u])
    expect(await getMemoryEnabled(u)).toBe(true)
    await query(`DELETE FROM user_prefs WHERE user_id = $1`, [u])
  })

  it('the column is NOT NULL DEFAULT false, and the migration is idempotent with no backfill', async () => {
    const col = async () =>
      (
        await query<{ is_nullable: string; column_default: string }>(
          `SELECT is_nullable, column_default FROM information_schema.columns
            WHERE table_name = 'user_prefs' AND column_name = 'memory_enabled'`,
        )
      ).rows[0]!
    const c = await col()
    expect(c.is_nullable).toBe('NO')
    expect(c.column_default).toBe('false')
    // Re-running the idempotent ALTER changes nothing and does not throw.
    await query(
      `ALTER TABLE user_prefs ADD COLUMN IF NOT EXISTS memory_enabled BOOLEAN NOT NULL DEFAULT FALSE`,
    )
    expect(await col()).toEqual(c)
    // No backfill: nobody has memory on that did not turn it on.
    const on = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM user_prefs WHERE memory_enabled AND user_id LIKE $1`,
      [`%-${tag}%`],
    )
    expect(on.rows[0]!.n).toBe(0)
  })

  it('reads are scoped to the user asked about', async () => {
    const a = `${ALICE}-prefs2`
    const b = `${BOB}-prefs2`
    await setStoredInferenceTier(a, 'anthropic')
    await setStoredInferenceTier(b, 'anthropic')
    await query(`UPDATE user_prefs SET memory_enabled = TRUE WHERE user_id = $1`, [a])
    expect(await getMemoryEnabled(a)).toBe(true)
    expect(await getMemoryEnabled(b)).toBe(false)
    await query(`DELETE FROM user_prefs WHERE user_id = ANY($1)`, [[a, b]])
  })
})
