/**
 * Document Ingestion Tests (pipeline capstone: #6 + #9 + #8)
 *
 * Verifies chunk → embed → Redis-index wiring and, crucially, the
 * one-model-per-corpus guard, against fake `callTool` + fake embedders.
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
  ingestDocument,
  searchDocuments,
  getEmbeddingSpace,
  indexNameFor,
  prefixFor,
} from '../../lib/document-ingest.server'
import type { StashDocument } from '../../lib/document-store.server'
import type { CallTool } from '../../lib/document-store.server'
import type { ToolCallResult } from '../../lib/harness-patterns/types'
import type { EmbeddingConfig, EmbeddingResult } from '../../lib/embeddings.server'

// ----------------------------------------------------------------------------
// Fake Redis (json + hashes + vector search) behind a fake callTool
// ----------------------------------------------------------------------------

function makeFakeRedis() {
  const json = new Map<string, unknown>()
  const hashes = new Map<string, Record<string, unknown>>()
  const indexes = new Map<string, { prefix: string; dim: number }>()
  const calls: Array<[string, Record<string, unknown>]> = []

  const callTool = (async (name: string, args: Record<string, unknown>): Promise<ToolCallResult> => {
    calls.push([name, args])
    switch (name) {
      case 'json_set':
        json.set(args.name as string, JSON.parse(args.value as string))
        return { success: true, data: 'OK' }
      case 'json_get': {
        const v = json.get(args.name as string)
        return { success: true, data: v == null ? null : [v] }
      }
      case 'create_vector_index_hash':
        indexes.set(args.index_name as string, {
          prefix: args.prefix as string,
          dim: args.dim as number,
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
        // Return every stored chunk hash as a "match" (field dicts, no vector).
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
  return { json, hashes, indexes, calls, callTool }
}

function makeDoc(overrides: Partial<StashDocument> = {}): StashDocument {
  return {
    id: 'doc1',
    sessionId: 's1',
    filename: 'notes.txt',
    mimeType: 'text/plain',
    size: 11,
    uploadedAt: 1,
    content: 'Alpha sentence.\n\nBeta paragraph here.\n\nGamma final part.',
    ...overrides,
  }
}

/** Fake embedder bound to a given space; vectors echo text length. */
function makeEmbedder(model: string, dim: number) {
  const embedFn = async (texts: string[], config?: EmbeddingConfig): Promise<EmbeddingResult> => ({
    provider: config?.provider ?? 'local',
    model: config?.model ?? model,
    dimensions: dim,
    vectors: texts.map((t, i) => Array.from({ length: dim }, (_, d) => t.length + i + d)),
  })
  const embedOneFn = async (text: string, config?: EmbeddingConfig) => {
    const r = await embedFn([text], config)
    return { provider: r.provider, model: r.model, dimensions: r.dimensions, vector: r.vectors[0] }
  }
  return { embedFn, embedOneFn }
}

// ----------------------------------------------------------------------------

describe('document-ingest', () => {
  let fake: ReturnType<typeof makeFakeRedis>
  beforeEach(() => {
    fake = makeFakeRedis()
  })

  describe('ingestDocument', () => {
    it('chunks, embeds, and stores a vector + fields per chunk', async () => {
      const { embedFn } = makeEmbedder('fake-model', 3)
      const result = await ingestDocument(makeDoc(), {
        chunk: { strategy: 'paragraph', maxChars: 30, overlap: 0 },
        callTool: fake.callTool,
        embedFn,
      })

      expect(result.chunks).toBeGreaterThan(0)
      expect(result.space).toEqual({ provider: 'local', model: 'fake-model', dimensions: 3 })
      expect(result.indexName).toBe(indexNameFor('s1', result.space))
      expect(result.prefix).toBe(prefixFor('s1', result.space))

      // One hash per chunk: vector + a single JSON `meta` field carrying
      // content AND provenance — 2 writes/chunk (the gateway's redis MCP is
      // serial stdio, so call count is the cost).
      expect(fake.hashes.size).toBe(result.chunks)
      for (const h of fake.hashes.values()) {
        expect(Array.isArray(h.vector)).toBe(true)
        const raw = h.meta as string
        expect(raw.startsWith('b64:')).toBe(true) // opaque, non-JSON (gateway-safe)
        const meta = JSON.parse(Buffer.from(raw.slice(4), 'base64').toString('utf8'))
        expect(typeof meta.content).toBe('string')
        expect(meta.doc_id).toBe('doc1')
        expect(meta.source).toBe('notes.txt')
        expect(meta.model).toBe('fake-model')
      }
    })

    it('creates the index with the embedding dimensionality', async () => {
      const { embedFn } = makeEmbedder('fake-model', 7)
      await ingestDocument(makeDoc(), { callTool: fake.callTool, embedFn })
      const idx = Array.from(fake.indexes.values())[0]
      expect(idx.dim).toBe(7)
      expect(idx.prefix.startsWith('stashvec:s1:')).toBe(true)
    })

    it('records the session embedding space', async () => {
      const { embedFn } = makeEmbedder('fake-model', 3)
      await ingestDocument(makeDoc(), { callTool: fake.callTool, embedFn })
      const space = await getEmbeddingSpace('s1', fake.callTool)
      expect(space).toEqual({ provider: 'local', model: 'fake-model', dimensions: 3 })
    })

    it('allows re-ingesting under the SAME space', async () => {
      const { embedFn } = makeEmbedder('fake-model', 3)
      await ingestDocument(makeDoc({ id: 'doc1' }), { callTool: fake.callTool, embedFn })
      await expect(
        ingestDocument(makeDoc({ id: 'doc2' }), { callTool: fake.callTool, embedFn }),
      ).resolves.toBeTruthy()
    })

    it('refuses a DIFFERENT embedding space for the same session (comparability)', async () => {
      const first = makeEmbedder('model-A', 3)
      await ingestDocument(makeDoc({ id: 'doc1' }), {
        callTool: fake.callTool,
        embedFn: first.embedFn,
      })

      const second = makeEmbedder('model-B', 5) // different model + dim
      await expect(
        ingestDocument(makeDoc({ id: 'doc2' }), {
          callTool: fake.callTool,
          embedFn: second.embedFn,
        }),
      ).rejects.toThrow(/not\s+comparable|mismatch/i)
    })

    it('permits a space change when explicitly allowed', async () => {
      const first = makeEmbedder('model-A', 3)
      await ingestDocument(makeDoc({ id: 'doc1' }), {
        callTool: fake.callTool,
        embedFn: first.embedFn,
      })
      const second = makeEmbedder('model-B', 5)
      await expect(
        ingestDocument(makeDoc({ id: 'doc2' }), {
          callTool: fake.callTool,
          embedFn: second.embedFn,
          allowSpaceChange: true,
        }),
      ).resolves.toBeTruthy()
    })

    it('tolerates an "already exists" index error', async () => {
      const existsRedis = makeFakeRedis()
      const base = existsRedis.callTool
      const callTool = (async (name: string, args: Record<string, unknown>) => {
        if (name === 'create_vector_index_hash') {
          return { success: false, data: null, error: 'Index already exists' }
        }
        return base(name, args)
      }) as CallTool
      const { embedFn } = makeEmbedder('fake-model', 3)
      await expect(
        ingestDocument(makeDoc(), { callTool, embedFn }),
      ).resolves.toBeTruthy()
    })
  })

  describe('searchDocuments', () => {
    it('returns [] when the session has no ingested corpus', async () => {
      const { embedOneFn } = makeEmbedder('fake-model', 3)
      const hits = await searchDocuments('ghost', 'query', {
        callTool: fake.callTool,
        embedOneFn,
      })
      expect(hits).toEqual([])
    })

    it('embeds the query with the recorded model and returns parsed hits', async () => {
      const { embedFn, embedOneFn } = makeEmbedder('fake-model', 3)
      await ingestDocument(makeDoc(), {
        chunk: { strategy: 'paragraph', maxChars: 30, overlap: 0 },
        callTool: fake.callTool,
        embedFn,
      })

      const hits = await searchDocuments('s1', 'alpha', {
        callTool: fake.callTool,
        embedOneFn,
        k: 3,
      })
      expect(hits.length).toBeGreaterThan(0)
      expect(hits[0].docId).toBe('doc1')
      expect(typeof hits[0].content).toBe('string')

      // The search must target the recorded space's index.
      const searchCall = fake.calls.find((c) => c[0] === 'vector_search_hash')!
      expect(searchCall[1].index_name).toBe(
        indexNameFor('s1', { provider: 'local', model: 'fake-model', dimensions: 3 }),
      )
      expect(searchCall[1].k).toBe(3)
    })
  })
})
