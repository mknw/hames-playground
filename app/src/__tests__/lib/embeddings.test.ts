/**
 * Embeddings Tests (Issue #8)
 *
 * Exercises the provider-pluggable embedder against an injected fake `fetch`
 * (no live model server), plus the comparability guard that keeps a corpus on
 * one model.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

import {
  embed,
  embedOne,
  embeddingSpaceId,
  assertSameSpace,
  type EmbeddingSpace,
} from '../../lib/embeddings.server'

// ----------------------------------------------------------------------------
// Fake OpenAI-compatible /embeddings endpoint
// ----------------------------------------------------------------------------

/** Returns a deterministic `dim`-length vector per input, echoing call count. */
function makeFakeFetch(dim = 3) {
  const calls: Array<{ url: string; body: any; headers: any }> = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    calls.push({ url: String(url), body, headers: init?.headers })
    const inputs: string[] = Array.isArray(body.input) ? body.input : [body.input]
    const data = inputs.map((text, i) => ({
      index: i,
      embedding: Array.from({ length: dim }, (_, d) => text.length + d),
    }))
    return new Response(JSON.stringify({ data, model: body.model }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('embeddings (Issue #8)', () => {
  const ORIGINAL_ENV = { ...process.env }
  beforeEach(() => {
    delete process.env.EMBEDDINGS_PROVIDER
    delete process.env.EMBEDDINGS_LOCAL_URL
    delete process.env.EMBEDDINGS_LOCAL_MODEL
    delete process.env.OPENROUTER_API_KEY
  })
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
    vi.restoreAllMocks()
  })

  describe('embed', () => {
    it('returns vectors tagged with provider/model/dimensions (local default)', async () => {
      const { fetchImpl, calls } = makeFakeFetch(4)
      const res = await embed(['hello', 'world!'], { fetchImpl })
      expect(res.provider).toBe('local')
      expect(res.model).toBe('Qwen3-Embedding-0.6B')
      expect(res.dimensions).toBe(4)
      expect(res.vectors).toHaveLength(2)
      expect(res.vectors[0]).toHaveLength(4)
      // Hits the local :8090 OpenAI-compatible endpoint.
      expect(calls[0].url).toBe('http://localhost:8090/v1/embeddings')
    })

    it('honours EMBEDDINGS_LOCAL_URL / MODEL env overrides', async () => {
      process.env.EMBEDDINGS_LOCAL_URL = 'http://127.0.0.1:9000/v1/'
      process.env.EMBEDDINGS_LOCAL_MODEL = 'my-model'
      const { fetchImpl, calls } = makeFakeFetch()
      const res = await embed(['x'], { fetchImpl })
      expect(calls[0].url).toBe('http://127.0.0.1:9000/v1/embeddings')
      expect(res.model).toBe('my-model')
    })

    it('batches inputs beyond batchSize, preserving order', async () => {
      const { fetchImpl, calls } = makeFakeFetch(2)
      const texts = ['a', 'bb', 'ccc', 'dddd', 'eeeee']
      const res = await embed(texts, { fetchImpl, batchSize: 2 })
      expect(calls).toHaveLength(3) // 2 + 2 + 1
      // First dim component equals the text length (per fake) → order preserved.
      expect(res.vectors.map((v) => v[0])).toEqual([1, 2, 3, 4, 5])
    })

    it('throws on inconsistent dimensions across the batch', async () => {
      const fetchImpl = (async (_url: any, init: any) => {
        const inputs = JSON.parse(init.body).input
        const data = inputs.map((t: string, i: number) => ({
          index: i,
          embedding: i === 0 ? [1, 2, 3] : [1, 2], // mismatched length
        }))
        return new Response(JSON.stringify({ data }), { status: 200 })
      }) as unknown as typeof fetch
      await expect(embed(['a', 'b'], { fetchImpl })).rejects.toThrow(/inconsistent/i)
    })

    it('throws when the model returns a different dim than requested', async () => {
      const { fetchImpl } = makeFakeFetch(3)
      await expect(embed(['a'], { fetchImpl, dimensions: 1536 })).rejects.toThrow(/1536/)
    })

    it('surfaces HTTP errors with status', async () => {
      const fetchImpl = (async () =>
        new Response('rate limited', { status: 429 })) as unknown as typeof fetch
      await expect(embed(['a'], { fetchImpl })).rejects.toThrow(/429/)
    })

    it('wraps network errors with a local-server hint', async () => {
      const fetchImpl = (async () => {
        throw new Error('ECONNREFUSED')
      }) as unknown as typeof fetch
      await expect(embed(['a'], { fetchImpl })).rejects.toThrow(/llama-server/)
    })

    it('returns an empty result for empty input without calling fetch', async () => {
      const { fetchImpl, calls } = makeFakeFetch()
      const res = await embed([], { fetchImpl })
      expect(res.vectors).toEqual([])
      expect(calls).toHaveLength(0)
    })
  })

  describe('openrouter provider', () => {
    it('requires an API key', async () => {
      const { fetchImpl } = makeFakeFetch()
      await expect(embed(['a'], { provider: 'openrouter', fetchImpl })).rejects.toThrow(
        /OPENROUTER_API_KEY/,
      )
    })

    it('sends a bearer token and hits the OpenRouter endpoint', async () => {
      const { fetchImpl, calls } = makeFakeFetch()
      await embed(['a'], { provider: 'openrouter', apiKey: 'sk-test', fetchImpl })
      expect(calls[0].url).toBe('https://openrouter.ai/api/v1/embeddings')
      expect(calls[0].headers.Authorization).toBe('Bearer sk-test')
    })
  })

  describe('embedOne', () => {
    it('returns a single vector with its space', async () => {
      const { fetchImpl } = makeFakeFetch(3)
      const res = await embedOne('hi', { fetchImpl })
      expect(res.vector).toHaveLength(3)
      expect(res.provider).toBe('local')
    })
  })

  describe('comparability guard', () => {
    const a: EmbeddingSpace = { provider: 'local', model: 'Qwen3', dimensions: 1024 }
    const b: EmbeddingSpace = { provider: 'openrouter', model: 'nemotron', dimensions: 768 }

    it('builds a stable space id', () => {
      expect(embeddingSpaceId(a)).toBe('local:Qwen3:1024')
    })

    it('passes for identical spaces', () => {
      expect(() => assertSameSpace(a, { ...a })).not.toThrow()
    })

    it('throws for a different model/provider/dim', () => {
      expect(() => assertSameSpace(a, b)).toThrow(/not\s+comparable/i)
      expect(() => assertSameSpace(a, { ...a, dimensions: 512 })).toThrow(/mismatch/i)
    })
  })
})
