/**
 * Redis RetrieverBackend Tests
 *
 * Wraps `searchDocuments` (Data Stash KNN) → normalized RetrievalHit, and runs
 * `ensureSessionIngested` once per session as a lazy ingest safety net. Both
 * dependencies are injected, so no gateway/embedder is touched.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))
vi.mock('../../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: vi.fn(async () => ({ success: false, data: null, error: 'no gateway' })),
}))

import { createRedisBackend } from '../../../lib/retriever/redis-backend.server'
import type { SearchHit } from '../../../lib/document-ingest.server'

const SAMPLE: SearchHit[] = [
  {
    docId: 'doc1',
    source: 'notes.txt',
    chunkIndex: 2,
    content: 'the matched chunk',
    startOffset: 10,
    endOffset: 27,
    score: 0.13,
  },
]

describe('createRedisBackend', () => {
  beforeEach(() => vi.clearAllMocks())

  it('self-describes as a vector backend named "redis"', () => {
    const b = createRedisBackend('s1', { searchFn: vi.fn(async () => []), ensureIngested: false })
    expect(b.name).toBe('redis')
    expect(b.type).toBe('vector')
  })

  it('passes sessionId + query text + k through to searchDocuments', async () => {
    const searchFn = vi.fn(async () => [])
    const b = createRedisBackend('sess-42', { searchFn, ensureIngested: false })
    await b.search({ text: 'how do refunds work?' }, { k: 7 })
    expect(searchFn).toHaveBeenCalledWith('sess-42', 'how do refunds work?', { k: 7 })
  })

  it('normalizes SearchHit → RetrievalHit with first-class locator fields', async () => {
    const b = createRedisBackend('s1', {
      searchFn: vi.fn(async () => SAMPLE),
      ensureIngested: false,
    })
    const hits = await b.search({ text: 'q' }, { k: 5 })
    expect(hits).toEqual([
      {
        backend: 'redis',
        id: 'doc1:2',
        content: 'the matched chunk',
        source: 'notes.txt',
        score: 0.13,
        docId: 'doc1',
        chunkIndex: 2,
        startOffset: 10,
        endOffset: 27,
      },
    ])
  })

  it('runs the ingest safety net once per session, not per query', async () => {
    const ensureFn = vi.fn(async () => {})
    const searchFn = vi.fn(async () => [])
    const b = createRedisBackend('s1', { searchFn, ensureFn })
    await b.search({ text: 'a' }, { k: 5 })
    await b.search({ text: 'b' }, { k: 5 })
    await b.search({ text: 'c' }, { k: 5 })
    expect(ensureFn).toHaveBeenCalledTimes(1)
    expect(ensureFn).toHaveBeenCalledWith('s1')
    expect(searchFn).toHaveBeenCalledTimes(3)
  })

  it('skips the safety net entirely when ensureIngested is false', async () => {
    const ensureFn = vi.fn(async () => {})
    const b = createRedisBackend('s1', { searchFn: vi.fn(async () => []), ensureFn, ensureIngested: false })
    await b.search({ text: 'a' }, { k: 5 })
    expect(ensureFn).not.toHaveBeenCalled()
  })

  it('still searches when the safety net throws (best-effort)', async () => {
    const ensureFn = vi.fn(async () => {
      throw new Error('embedder offline')
    })
    const searchFn = vi.fn(async () => SAMPLE)
    const b = createRedisBackend('s1', { searchFn, ensureFn })
    const hits = await b.search({ text: 'q' }, { k: 5 })
    expect(hits).toHaveLength(1)
    expect(searchFn).toHaveBeenCalledTimes(1)
    // A failed ensure isn't retried on the next query (marked done up-front).
    await b.search({ text: 'q2' }, { k: 5 })
    expect(ensureFn).toHaveBeenCalledTimes(1)
  })
})
