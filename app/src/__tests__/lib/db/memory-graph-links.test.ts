/**
 * Memory → graph node links against a real Postgres with pgvector
 * (org-knowledge slice 8, `docs/plan/org-knowledge-hook.md` LD-15). Same gate
 * as `memories-db-store.test.ts`: CI's `test · postgres` job cannot skip these.
 * Synthetic ids and text only.
 *
 * Pins, each with the mutation that reddens it:
 *  - a deleted memory deletes its links (mutation: drop ON DELETE CASCADE);
 *  - a link is owner scoped (mutation: drop the `m.user_id = $1` check);
 *  - recall attaches the CURRENT names of the nodes the graph still holds,
 *    and a missing node contributes nothing (mutation: skip the recheck, i.e.
 *    use the stored ids as terms).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { skipWithoutDatabase } from '../../test-database'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

import {
  createMemoryDbStore,
  deleteAllMemoriesForUser,
  deleteMemoryForUser,
  ensureMemoriesSchema,
  exportMemoryDataForUser,
  insertMemory,
  replaceMemoryGraphLinks,
} from '../../../lib/db/memories.server'
import { closePool, query } from '../../../lib/db/client.server'

const tag = Math.random().toString(36).slice(2, 10)
const ALICE = `s8-alice-${tag}`
const BOB = `s8-bob-${tag}`
let n = 0
const id = (p: string) => `${p}-${tag}-${++n}`
const SPACE = 'test-space-v1'
const axis = (k: number) => {
  const v = new Array<number>(1024).fill(0)
  v[k] = 1
  return v
}

let dbAvailable = true

async function memory(userId: string, content = 'I own the release checklist'): Promise<string> {
  const mid = id('mem')
  await insertMemory({
    id: mid,
    userId,
    kind: 'semantic',
    tier: 'self_deployed',
    content,
    evidence: content,
    evidenceEventId: id('evt'),
    embedding: axis(0),
    embedSpace: SPACE,
  })
  return mid
}

const links = async (mid: string) =>
  (
    await query<{ node_id: string }>(
      `SELECT node_id FROM memory_graph_links WHERE memory_id = $1 ORDER BY node_id`,
      [mid],
    )
  ).rows.map((r) => r.node_id)

beforeAll(async () => {
  try {
    await query('SELECT 1')
    const { rows } = await query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_available_extensions WHERE name = 'vector'`,
    )
    dbAvailable = (rows[0]?.n ?? 0) > 0
    if (dbAvailable) await ensureMemoriesSchema()
  } catch (err) {
    dbAvailable = false
    console.warn('[memory-graph-links.test] Postgres unreachable, skipping:', err)
  }
})

afterAll(async () => {
  if (!dbAvailable) return
  for (const u of [ALICE, BOB]) await deleteAllMemoriesForUser(u)
  await closePool()
})

describe('memory_graph_links', () => {
  beforeEach((ctx) => skipWithoutDatabase(ctx, dbAvailable))

  it('replaces a memory’s links, and deletes them with the memory', async () => {
    const mid = await memory(ALICE)
    await replaceMemoryGraphLinks(ALICE, mid, ['node-a', 'node-b', 'node-a'])
    expect(await links(mid)).toEqual(['node-a', 'node-b'])
    // An update re-links from the new text: the old links go.
    await replaceMemoryGraphLinks(ALICE, mid, ['node-c'])
    expect(await links(mid)).toEqual(['node-c'])
    // Pin: deleting the memory deletes its links (the cascade).
    await deleteMemoryForUser(ALICE, mid)
    expect(await links(mid)).toEqual([])
    const all = await deleteAllMemoriesForUser(ALICE)
    expect(all).toBeGreaterThanOrEqual(0)
  })

  it('is owner scoped: another user cannot link a memory that is not theirs', async () => {
    const mid = await memory(ALICE)
    await replaceMemoryGraphLinks(BOB, mid, ['node-x'])
    expect(await links(mid)).toEqual([])
  })

  it('recall reads the current names of the nodes the graph still holds, and skips a missing one', async () => {
    const linked = await memory(ALICE, 'I own the release checklist')
    const plain = await memory(ALICE, 'I prefer short summaries')
    await replaceMemoryGraphLinks(ALICE, linked, ['node-osprey', 'node-gone'])
    const asked: string[][] = []
    const store = createMemoryDbStore(ALICE, {
      linkedNames: async (ids) => {
        asked.push([...ids].sort())
        return new Map([['node-osprey', 'Osprey']]) // node-gone is no longer in the graph
      },
    })
    const rows = await store.candidates({ embedding: axis(0), tiers: ['self_deployed'] })
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(asked).toEqual([['node-gone', 'node-osprey']])
    expect(byId.get(linked)?.terms).toEqual(['Osprey'])
    expect(byId.get(plain)?.terms).toBeUndefined()
    // The memory's own text is untouched: terms are matched, never rendered.
    expect(byId.get(linked)?.content).toBe('I own the release checklist')
  })

  it('recall goes on without terms when the graph cannot be read', async () => {
    const mid = await memory(ALICE)
    await replaceMemoryGraphLinks(ALICE, mid, ['node-osprey'])
    const store = createMemoryDbStore(ALICE, {
      linkedNames: () => Promise.reject(new Error('graph down')),
    })
    const rows = await store.candidates({ embedding: axis(0), tiers: ['self_deployed'] })
    expect(rows.find((r) => r.id === mid)?.terms).toBeUndefined()
  })

  it('exports a memory’s links with it', async () => {
    const mid = await memory(ALICE)
    await replaceMemoryGraphLinks(ALICE, mid, ['node-osprey'])
    const exported = await exportMemoryDataForUser(ALICE)
    expect(exported.find((m) => m.id === mid)?.graph_links).toEqual(['node-osprey'])
  })
})
