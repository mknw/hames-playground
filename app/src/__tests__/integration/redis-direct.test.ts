/**
 * Direct-Redis integration smoke — a real create → upsert → KNN round-trip
 * against a live redis-stack via the direct ioredis client. SKIPPED unless
 * `REDIS_DIRECT_IT=1` (needs redis-stack on :6379, arm64 → linux/amd64 override).
 *
 *   REDIS_DIRECT_IT=1 pnpm vitest run src/__tests__/integration/redis-direct.test.ts
 *
 * Proves the FT.CREATE / hset(vector-blob) / FT.SEARCH commands are correct
 * against real RediSearch. Gateway↔direct cross-compatibility (a gateway-written
 * vector read back by direct search) is verified live in the app.
 */

import { describe, it, expect, afterAll, vi } from 'vitest'

vi.mock('../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

import { directCallTool, getRedis, closeRedisDirect } from '../../lib/redis-direct.server'
import { createVectorStore } from '../../lib/vector-store.server'

const RUN = process.env.REDIS_DIRECT_IT === '1'

describe.skipIf(!RUN)('redis-direct integration (live redis-stack)', () => {
  const indexName = 'stash_it_idx_test'
  const prefix = 'stash_it_test:'
  const store = createVectorStore({ indexName, prefix, dim: 4, callTool: directCallTool })

  afterAll(async () => {
    try {
      await getRedis().call('FT.DROPINDEX', indexName, 'DD') // DD also deletes the docs
    } catch {
      /* index may not exist */
    }
    await closeRedisDirect()
  })

  it('round-trips create → upsert → KNN search, closest first', async () => {
    await store.ensureIndex()
    await store.upsert('docA:0', [1, 0, 0, 0], { content: 'alpha', doc_id: 'docA', chunk_index: 0 }, 300)
    await store.upsert('docB:0', [0, 1, 0, 0], { content: 'beta', doc_id: 'docB', chunk_index: 0 }, 300)

    const hits = await store.search([0.9, 0.1, 0, 0], 5)
    expect(hits.length).toBeGreaterThanOrEqual(2)
    expect(hits[0].payload.content).toBe('alpha') // nearest to the query
    expect(hits.map((h) => h.payload.content)).toContain('beta')
    expect(hits[0].id).toBe('docA:0') // _vid recovered from meta
  })
})
