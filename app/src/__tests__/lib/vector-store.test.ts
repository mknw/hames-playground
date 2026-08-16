/**
 * Vector Store Tests
 *
 * Exercises the shared RediSearch wrapper (ensureIndex / upsert / search) and
 * the payload encode/decode + naming helpers against a fake `callTool`.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))
vi.mock('../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: vi.fn(async () => ({ success: false, data: null, error: 'no gateway' })),
}))

import {
  createVectorStore,
  encodeMeta,
  decodeMeta,
  spaceTag,
  sanitize,
} from '../../lib/vector-store.server'
import type { CallTool } from '../../lib/document-store.server'
import type { ToolCallResult } from '../../lib/harness-patterns/types'

function makeFakeRedis() {
  const hashes = new Map<string, Record<string, unknown>>()
  const indexes = new Map<string, { prefix: string; dim: number; metric: string }>()
  const calls: Array<[string, Record<string, unknown>]> = []

  const callTool = (async (name: string, args: Record<string, unknown>): Promise<ToolCallResult> => {
    calls.push([name, args])
    switch (name) {
      case 'create_vector_index_hash':
        indexes.set(args.index_name as string, {
          prefix: args.prefix as string,
          dim: args.dim as number,
          metric: args.distance_metric as string,
        })
        return { success: true, data: 'Index created' }
      case 'set_vector_in_hash': {
        const key = args.name as string
        const h = hashes.get(key) ?? {}
        h.vector = args.vector
        hashes.set(key, h)
        return { success: true, data: true }
      }
      case 'hset': {
        const key = args.name as string
        const h = hashes.get(key) ?? {}
        h[args.key as string] = args.value
        hashes.set(key, h)
        return { success: true, data: 1 }
      }
      case 'vector_search_hash': {
        // Return every stored hash as a "match" (field dicts minus the vector).
        const rows = Array.from(hashes.values()).map((h) => {
          const { vector: _v, ...fields } = h
          return { ...fields, score: 0.1 }
        })
        return { success: true, data: rows }
      }
      default:
        return { success: false, data: null, error: `unhandled ${name}` }
    }
  }) as CallTool
  return { hashes, indexes, calls, callTool }
}

describe('vector-store', () => {
  let fake: ReturnType<typeof makeFakeRedis>
  beforeEach(() => {
    fake = makeFakeRedis()
  })

  describe('ensureIndex', () => {
    it('creates an HNSW index with the given name/prefix/dim/metric', async () => {
      const store = createVectorStore({ indexName: 'idx1', prefix: 'p:', dim: 8, callTool: fake.callTool })
      await store.ensureIndex()
      expect(fake.indexes.get('idx1')).toEqual({ prefix: 'p:', dim: 8, metric: 'COSINE' })
    })

    it('tolerates an "already exists" error', async () => {
      const callTool: CallTool = async (name) =>
        name === 'create_vector_index_hash'
          ? { success: false, data: null, error: 'Index already exists' }
          : { success: true, data: 1 }
      const store = createVectorStore({ indexName: 'idx1', prefix: 'p:', dim: 8, callTool })
      await expect(store.ensureIndex()).resolves.toBeUndefined()
    })

    it('throws on a non-exists index error', async () => {
      const callTool: CallTool = async () => ({ success: false, data: null, error: 'WRONGTYPE boom' })
      const store = createVectorStore({ indexName: 'idx1', prefix: 'p:', dim: 8, callTool })
      await expect(store.ensureIndex()).rejects.toThrow(/WRONGTYPE/)
    })
  })

  describe('upsert', () => {
    it('stores a vector + base64 payload at prefix+id, with TTL', async () => {
      const store = createVectorStore({ indexName: 'idx1', prefix: 'p:', dim: 3, callTool: fake.callTool })
      await store.upsert('a', [1, 2, 3], { content: 'hi', n: 5 }, 60)

      const h = fake.hashes.get('p:a')!
      expect(h.vector).toEqual([1, 2, 3])
      expect((h.meta as string).startsWith('b64:')).toBe(true)
      const payload = decodeMeta(h.meta)
      expect(payload).toMatchObject({ content: 'hi', n: 5, _vid: 'a' })

      const hset = fake.calls.find((c) => c[0] === 'hset')!
      expect(hset[1].expire_seconds).toBe(60)
    })

    it('throws when the vector write fails', async () => {
      const callTool: CallTool = async (name) =>
        name === 'set_vector_in_hash'
          ? { success: false, data: null, error: 'boom' }
          : { success: true, data: 1 }
      const store = createVectorStore({ indexName: 'idx1', prefix: 'p:', dim: 3, callTool })
      await expect(store.upsert('a', [1, 2, 3])).rejects.toThrow(/boom/)
    })
  })

  describe('search', () => {
    it('returns hits with decoded payloads, id (from _vid) and score', async () => {
      const store = createVectorStore({ indexName: 'idx1', prefix: 'p:', dim: 3, callTool: fake.callTool })
      await store.upsert('doc-1', [1, 2, 3], { content: 'alpha', kind: 'x' })
      await store.upsert('doc-2', [4, 5, 6], { content: 'beta' })

      const hits = await store.search([1, 2, 3], 5)
      expect(hits.length).toBe(2)
      const ids = hits.map((h) => h.id).sort()
      expect(ids).toEqual(['doc-1', 'doc-2'])
      const first = hits.find((h) => h.id === 'doc-1')!
      expect(first.payload.content).toBe('alpha')
      expect(first.score).toBe(0.1)
      // The search targets the configured index with the right k.
      const call = fake.calls.find((c) => c[0] === 'vector_search_hash')!
      expect(call[1].index_name).toBe('idx1')
      expect(call[1].k).toBe(5)
    })

    it('returns [] on an unsuccessful search', async () => {
      const callTool: CallTool = async () => ({ success: false, data: null, error: 'no index' })
      const store = createVectorStore({ indexName: 'idx1', prefix: 'p:', dim: 3, callTool })
      expect(await store.search([1, 2, 3])).toEqual([])
    })

    it('parses a SINGLE match returned as a bare hit object (gateway 1-result shape)', async () => {
      // Live regression: for exactly ONE match the gateway returns the hit as a
      // bare object (not an array, not a {results:[…]} wrapper) — one text block,
      // un-aggregated. The old parseHits treated any non-array object as a
      // wrapper, found no .results/.documents/.matches, and yielded [] → search
      // silently returned nothing. (N≥2 matches arrive as an array and worked.)
      const meta = 'b64:' + Buffer.from(JSON.stringify({ content: 'hello', _vid: 'd1:0' })).toString('base64')
      const callTool: CallTool = async (name) =>
        name === 'vector_search_hash'
          ? { success: true, data: { id: 'p:d1:0', payload: null, score: '0.2044', meta } }
          : { success: true, data: 1 }
      const store = createVectorStore({ indexName: 'idx1', prefix: 'p:', dim: 3, callTool })
      const hits = await store.search([0, 0, 0], 3)
      expect(hits).toHaveLength(1)
      expect(hits[0].id).toBe('d1:0')
      expect(hits[0].payload.content).toBe('hello')
      expect(hits[0].score).toBe(0.2044) // string score coerced to number
    })

    it('ignores a non-hit bare object (e.g. an empty/no-results response)', async () => {
      const callTool: CallTool = async (name) =>
        name === 'vector_search_hash'
          ? { success: true, data: { count: 0 } }
          : { success: true, data: 1 }
      const store = createVectorStore({ indexName: 'idx1', prefix: 'p:', dim: 3, callTool })
      expect(await store.search([0, 0, 0], 3)).toEqual([])
    })

    it('parses a JSON-string meta and a {result} wrapper shape', async () => {
      // Mimic a backend that returns rows under a key, with meta as raw JSON.
      const callTool: CallTool = async (name) =>
        name === 'vector_search_hash'
          ? {
              success: true,
              data: { results: [{ meta: JSON.stringify({ result: 'r', _vid: 'q1' }), score: 0.04 }] },
            }
          : { success: true, data: 1 }
      const store = createVectorStore({ indexName: 'idx1', prefix: 'p:', dim: 3, callTool })
      const hits = await store.search([0, 0, 0], 1)
      expect(hits).toHaveLength(1)
      expect(hits[0].id).toBe('q1')
      expect(hits[0].payload.result).toBe('r')
      expect(hits[0].score).toBe(0.04)
    })
  })

  describe('helpers', () => {
    it('encodeMeta/decodeMeta round-trip', () => {
      const enc = encodeMeta({ a: 1, b: 'x' })
      expect(enc.startsWith('b64:')).toBe(true)
      expect(decodeMeta(enc)).toEqual({ a: 1, b: 'x' })
    })
    it('decodeMeta tolerates plain JSON string and object', () => {
      expect(decodeMeta('{"a":1}')).toEqual({ a: 1 })
      expect(decodeMeta({ a: 1 })).toEqual({ a: 1 })
      expect(decodeMeta('not json')).toEqual({})
    })
    it('spaceTag encodes provider_model_dim (sanitized)', () => {
      expect(spaceTag({ provider: 'local', model: 'Qwen3-Embedding-0.6B', dimensions: 1024 })).toBe(
        'local_Qwen3_Embedding_0_6B_1024',
      )
      expect(sanitize('a/b.c:d')).toBe('a_b_c_d')
    })
  })
})
