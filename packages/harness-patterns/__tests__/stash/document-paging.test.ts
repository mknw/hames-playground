/**
 * `searchDocuments`' `excludeIds` pins (#927 slice 2, adopted from the
 * round-1 review's proposed evidence tests):
 *  1. the #926 repro at the backend: a second search with the first page's ids
 *     excluded returns the NEXT k unseen chunks;
 *  2. THE PLACEMENT CASE: with a hidden document ranking ahead, the exclusion
 *     inside the visibility-widening loop still returns a full page of k — a
 *     post-filter (exclude after the k visible hits are cut) would shrink the
 *     page below k. Mutation-checked: moving the exclusion to a post-filter
 *     turns `returns a full page...` red;
 *  3. an exhausted document returns an empty page.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))
vi.mock('@hames-ai/harness-patterns/mcp-client.server', () => ({
  callTool: vi.fn(async () => ({ success: false, data: null, error: 'no gateway' })),
}))

import { ingestStashDocument, searchDocuments } from '../../stash/document-ingest.server'
import { storeDocument } from '../../stash/document-store.server'
import type { CallTool } from '../../stash/document-store.server'
import type { ToolCallResult } from '../../types'
import type { EmbeddingConfig, EmbeddingResult } from '../../stash/embeddings.server'

// Same fake as document-visibility.test.ts: the KNN answer is every stored
// chunk in insertion order, cut to `k` — so seeding the hidden document first
// puts its chunks AHEAD of the visible document's in the ranking.
function makeFakeRedis() {
  const json = new Map<string, unknown>()
  const hashes = new Map<string, Record<string, unknown>>()
  const sets = new Map<string, Set<string>>()
  const callTool = (async (
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolCallResult> => {
    switch (name) {
      case 'json_set':
        json.set(args.name as string, JSON.parse(args.value as string))
        return { success: true, data: 'OK' }
      case 'json_get': {
        const v = json.get(args.name as string)
        return { success: true, data: v == null ? null : [v] }
      }
      case 'sadd': {
        const s = sets.get(args.name as string) ?? new Set<string>()
        s.add(String(args.value))
        sets.set(args.name as string, s)
        return { success: true, data: 1 }
      }
      case 'smembers': {
        const s = sets.get(args.name as string)
        return { success: true, data: s ? [...s] : [] }
      }
      case 'srem':
        sets.get(args.name as string)?.delete(String(args.value))
        return { success: true, data: 1 }
      case 'create_vector_index_hash':
        return { success: true, data: 'Index created' }
      case 'set_vector_in_hash': {
        const h = hashes.get(args.name as string) ?? {}
        h.vector = args.vector
        hashes.set(args.name as string, h)
        return { success: true, data: true }
      }
      case 'hset': {
        const h = hashes.get(args.name as string) ?? {}
        h[args.key as string] = args.value
        hashes.set(args.name as string, h)
        return { success: true, data: 1 }
      }
      case 'vector_search_hash': {
        const rows = Array.from(hashes.values())
          .slice(0, Number(args.k))
          .map((h) => {
            const { vector: _v, ...fields } = h
            return { ...fields, score: 0.1 }
          })
        return { success: true, data: rows }
      }
      default:
        return { success: false, data: null, error: `unhandled ${name}` }
    }
  }) as CallTool
  return { json, hashes, callTool }
}

const embedFn = async (texts: string[], config?: EmbeddingConfig): Promise<EmbeddingResult> => ({
  provider: config?.provider ?? 'local',
  model: config?.model ?? 'm',
  dimensions: 3,
  vectors: texts.map((t, i) => Array.from({ length: 3 }, (_, d) => t.length + i + d)),
})
const embedOneFn = async (text: string, config?: EmbeddingConfig) => {
  const r = await embedFn([text], config)
  return { provider: r.provider, model: r.model, dimensions: r.dimensions, vector: r.vectors[0] }
}

type Fake = ReturnType<typeof makeFakeRedis>

/** A paragraph a chunking pass will not merge with its neighbour (< 1000 chars
 *  each, two together > 1000): one paragraph = one chunk. */
const para = (i: number) => `paragraph ${i} of this document. ${'x'.repeat(880)}`
const content = (n: number) => Array.from({ length: n }, (_, i) => para(i)).join('\n\n')

async function seedMultiChunk(fake: Fake, id: string, chunks: number) {
  await storeDocument(
    {
      sessionId: 's1',
      id,
      filename: `${id}.txt`,
      mimeType: 'text/plain',
      content: content(chunks),
    },
    fake.callTool,
  )
  const res = await ingestStashDocument('s1', id, { callTool: fake.callTool, embedFn })
  expect(res?.chunks).toBe(chunks)
}

const search = (fake: Fake, opts: { k?: number; excludeIds?: string[] } = {}) =>
  searchDocuments('s1', 'query', {
    callTool: fake.callTool,
    embedOneFn,
    k: opts.k ?? 5,
    ...(opts.excludeIds ? { excludeIds: opts.excludeIds } : {}),
  })

const ids = (hits: Array<{ docId: string; chunkIndex: number }>) =>
  hits.map((h) => `${h.docId}:${h.chunkIndex}`)

describe('searchDocuments — excludeIds (#927 slice 2)', () => {
  let fake: Fake
  beforeEach(async () => {
    fake = makeFakeRedis()
    // 'h' is seeded FIRST so its chunks rank ahead of 'a''s; it is then hidden,
    // which is exactly the shape where a post-filtered page would shrink.
    await seedMultiChunk(fake, 'h', 5)
    await seedMultiChunk(fake, 'a', 10)
    const { setDocumentFlags } = await import('../../stash/document-store.server')
    await setDocumentFlags('s1', 'h', { hidden: true }, fake.callTool)
  })
  afterEach(() => vi.restoreAllMocks())

  it('fixture sanity: 10 chunks recorded on "a", none of the hidden doc\'s chunks come back', async () => {
    const page1 = await search(fake)
    expect(page1).toHaveLength(5)
    expect(page1.every((h) => h.docId === 'a')).toBe(true)
    expect(page1.every((h) => h.docChunks === 10)).toBe(true)
  })

  // THE PLACEMENT CASE. A post-filter — search out k visible hits, then drop
  // the excluded ids — would return 0 here: the first k visible hits are a:0-4,
  // all excluded, and h's chunks (invisible) rank ahead of a's remainder. The
  // in-loop exclusion widens past both and returns a full page.
  it('a repeat search returns the NEXT k unseen chunks, a full page despite the hidden document', async () => {
    const page1 = await search(fake)
    const page2 = await search(fake, { excludeIds: ids(page1) })
    expect(page2).toHaveLength(5)
    expect(page2.every((h) => h.docId === 'a')).toBe(true)
    expect(page2.map((h) => h.chunkIndex)).toEqual([5, 6, 7, 8, 9])
  })

  it('an exhausted document returns an empty page', async () => {
    const page1 = await search(fake)
    const page2 = await search(fake, { excludeIds: ids(page1) })
    const page3 = await search(fake, { excludeIds: [...ids(page1), ...ids(page2)] })
    expect(page3).toEqual([])
  })

  it('an excludeIds entry that matches nothing costs nothing', async () => {
    const page1 = await search(fake, { excludeIds: ['nope:99'] })
    expect(page1).toHaveLength(5)
  })
})
