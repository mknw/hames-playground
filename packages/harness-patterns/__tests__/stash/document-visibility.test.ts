/**
 * Document visibility tests — retrieval and ingest honour a document's
 * `hidden` / `archived` flags.
 *
 * Hiding or archiving a document only rewrites its stored JSON; its chunks stay
 * in the vector index. So the flags are enforced where chunks are read
 * (`searchDocuments`, which the redis retriever backend wraps) and where
 * documents are chosen for indexing (`ensureSessionIngested`). Drives the REAL
 * document store and ingest over a fake Redis.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))
vi.mock('@hames-ai/harness-patterns/mcp-client.server', () => ({
  callTool: vi.fn(async () => ({ success: false, data: null, error: 'no gateway' })),
}))

import {
  ensureSessionIngested,
  ingestStashDocument,
  searchDocuments,
} from '../../stash/document-ingest.server'
import { createRedisBackend } from '../../retriever/redis-backend.server'
import {
  storeDocument,
  setDocumentFlags,
  getDocument,
  getDocumentStrict,
} from '../../stash/document-store.server'
import type { CallTool } from '../../stash/document-store.server'
import type { ToolCallResult } from '../../types'
import type { EmbeddingConfig, EmbeddingResult } from '../../stash/embeddings.server'

// ----------------------------------------------------------------------------
// Fake Redis: JSON docs, the session index set, and chunk hashes. The KNN
// answer is every stored chunk in insertion order, cut to `k` — so the document
// ingested first is the "closest", which lets a test put a flagged document at
// the top of the ranking.
// ----------------------------------------------------------------------------
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

/** Store a one-chunk text document and index it. */
async function seedIndexed(fake: Fake, id: string) {
  await storeDocument(
    {
      sessionId: 's1',
      id,
      filename: `${id}.txt`,
      mimeType: 'text/plain',
      content: `content of ${id}`,
    },
    fake.callTool,
  )
  expect(await ingestStashDocument('s1', id, { callTool: fake.callTool, embedFn })).not.toBeNull()
}

const search = (fake: Fake, callTool: CallTool = fake.callTool, k = 5) =>
  searchDocuments('s1', 'query', { callTool, embedOneFn, k })

const docIds = (hits: Array<{ docId?: string }>) => hits.map((h) => h.docId).sort()

describe('searchDocuments — hidden and archived documents', () => {
  let fake: Fake
  beforeEach(async () => {
    fake = makeFakeRedis()
    await seedIndexed(fake, 'a')
    await seedIndexed(fake, 'b')
  })
  afterEach(() => vi.restoreAllMocks())

  it('returns every indexed document while none is flagged', async () => {
    expect(docIds(await search(fake))).toEqual(['a', 'b'])
  })

  // Mutation: delete the `isDocumentVisible` check in `searchDocuments` →
  // document `a`'s chunk comes back.
  it("does not return a hidden document's chunks", async () => {
    await setDocumentFlags('s1', 'a', { hidden: true }, fake.callTool)
    expect(docIds(await search(fake))).toEqual(['b'])
  })

  // Mutation: make `isDocumentVisible` read only `doc.hidden` → the archived
  // document's chunk comes back.
  it("does not return an archived document's chunks", async () => {
    await setDocumentFlags('s1', 'a', { archived: true }, fake.callTool)
    expect(docIds(await search(fake))).toEqual(['b'])
  })

  // Mutation: make `isDocumentVisible` read only `doc.archived` → the hidden
  // document's chunk comes back (the previous test cannot tell the two apart).
  it('drops a document flagged both ways, and one flag alone is enough', async () => {
    await setDocumentFlags('s1', 'a', { hidden: true, archived: true }, fake.callTool)
    await setDocumentFlags('s1', 'b', { hidden: true }, fake.callTool)
    expect(await search(fake)).toEqual([])
  })

  // Mutation: remember each document's flags from the first search (a
  // module-level cache) → the second search still returns `a`, and the third
  // still drops it.
  it('follows the current flags: hiding is immediate, un-hiding restores the chunks', async () => {
    expect(docIds(await search(fake))).toEqual(['a', 'b'])

    await setDocumentFlags('s1', 'a', { hidden: true }, fake.callTool)
    expect(docIds(await search(fake))).toEqual(['b'])

    await setDocumentFlags('s1', 'a', { hidden: false }, fake.callTool)
    expect(docIds(await search(fake))).toEqual(['a', 'b'])

    await setDocumentFlags('s1', 'a', { archived: true }, fake.callTool)
    expect(docIds(await search(fake))).toEqual(['b'])

    await setDocumentFlags('s1', 'a', { archived: false }, fake.callTool)
    expect(docIds(await search(fake))).toEqual(['a', 'b'])
  })

  // The chunk's own payload carries no flags, but a copy taken at ingest time
  // would be exactly the stale read this guards against.
  it('does not trust anything recorded at ingest time', async () => {
    await setDocumentFlags('s1', 'a', { hidden: true }, fake.callTool)
    for (const h of fake.hashes.values()) {
      expect(String(h.meta)).not.toMatch(/hidden|archived/)
    }
    expect(docIds(await search(fake))).toEqual(['b'])
  })

  // Mutation: replace the `catch` in `isDocumentVisible` with `return true` →
  // the unreadable document's chunk is returned.
  it('drops the hits of a document whose flags cannot be read, and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unreadable = (async (name: string, args: Record<string, unknown>) =>
      name === 'json_get' && String(args.name).startsWith('stash:doc:s1:a')
        ? { success: false, data: null, error: 'READONLY gateway down' }
        : fake.callTool(name, args)) as CallTool

    expect(docIds(await search(fake, unreadable))).toEqual(['b'])
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/document a .*could not be read.*READONLY gateway down/),
    )
  })

  // Mutation: remove the `!doc` line in `isDocumentVisible` → the chunk of a
  // document whose record is gone is returned (chunks outlive the record).
  it('drops the hits of a document whose record is absent, and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fake.json.delete('stash:doc:s1:a')

    expect(docIds(await search(fake))).toEqual(['b'])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/document a .*record is absent/))
  })

  // Mutation: revert the throw in `getDocumentStrict` for an unreadable body →
  // the document reads as absent-or-visible and its chunk is returned.
  it('drops the hits of a document whose read "succeeds" with an unreadable body, and logs it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const wrongType = (async (name: string, args: Record<string, unknown>) =>
      name === 'json_get' && String(args.name) === 'stash:doc:s1:a'
        ? {
            success: true,
            data: 'WRONGTYPE Operation against a key holding the wrong kind of value',
          }
        : fake.callTool(name, args)) as CallTool

    expect(docIds(await search(fake, wrongType))).toEqual(['b'])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/document a .*unreadable document/))
  })

  // Mutation: let a scalar or non-document array body through as null/object →
  // the read stops throwing.
  it('getDocumentStrict: only a null, "null" or empty body is absent', async () => {
    const reading = (data: unknown) =>
      getDocumentStrict('s1', 'a', (async () => ({ success: true, data })) as CallTool)

    await expect(reading(null)).resolves.toBeNull()
    await expect(reading('null')).resolves.toBeNull()
    await expect(reading([])).resolves.toBeNull()
    await expect(reading('[]')).resolves.toBeNull()
    await expect(reading('not json')).rejects.toThrow(/unreadable document/)
    await expect(reading(42)).rejects.toThrow(/unreadable document/)
    await expect(reading('"text"')).rejects.toThrow(/unreadable document/)
    await expect(reading([[1]])).rejects.toThrow(/unreadable document/)
    await expect(reading([{ id: 'a' }])).resolves.toEqual({ id: 'a' })
  })

  // Mutation: replace `getDocumentStrict` with `getDocument` in
  // `isDocumentVisible` → a failed read collapses to "absent" and the chunk is
  // returned without a log line.
  it('does not mistake a failed read for an absent document', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const down = (async (name: string, args: Record<string, unknown>) =>
      name === 'json_get' && String(args.name).startsWith('stash:doc:')
        ? { success: false, data: null, error: 'connection reset' }
        : fake.callTool(name, args)) as CallTool

    expect(await search(fake, down)).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it('drops a chunk that names no document, because its flags cannot be checked', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const h of fake.hashes.values()) {
      const meta = JSON.parse(Buffer.from(String(h.meta).slice(4), 'base64').toString('utf8'))
      delete meta.doc_id
      h.meta = `b64:${Buffer.from(JSON.stringify(meta)).toString('base64')}`
    }
    expect(await search(fake)).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no document id/))
  })

  // Mutation: drop the widening loop (return after the first `store.search`) →
  // the flagged document fills the one-hit window and the visible one is lost.
  it('looks past flagged hits so they do not crowd visible matches out of the top k', async () => {
    await setDocumentFlags('s1', 'a', { hidden: true }, fake.callTool)
    const hits = await search(fake, fake.callTool, 1)
    expect(docIds(hits)).toEqual(['b'])
  })

  it('never returns more than k hits', async () => {
    await seedIndexed(fake, 'c')
    expect(await search(fake, fake.callTool, 2)).toHaveLength(2)
  })

  // Mutation: delete `if (out.length >= k) break` → the 4-chunk window holds two
  // visible hits and both are returned for k = 1.
  it('stops at k even when a wider window holds more visible hits', async () => {
    for (const id of ['c', 'd', 'e']) await seedIndexed(fake, id)
    await setDocumentFlags('s1', 'a', { hidden: true }, fake.callTool)
    await setDocumentFlags('s1', 'b', { hidden: true }, fake.callTool)
    // Windows tried for k = 1: 1, 2, 4. The 4-window is a, b, c, d.
    expect(docIds(await search(fake, fake.callTool, 1))).toHaveLength(1)
  })

  const countingSearches = () => {
    const ks: number[] = []
    const callTool = (async (name: string, args: Record<string, unknown>) => {
      if (name === 'vector_search_hash') {
        ks.push(Number(args.k))
        if (ks.length > 20) return { success: true, data: [] }
      }
      return fake.callTool(name, args)
    }) as CallTool
    return { ks, callTool }
  }

  // Mutation: raise `MAX_SEARCH_SPAN` → the widening runs past 200 chunks.
  it('stops widening at the 200-chunk ceiling', async () => {
    await setDocumentFlags('s1', 'a', { hidden: true }, fake.callTool)
    await setDocumentFlags('s1', 'b', { hidden: true }, fake.callTool)
    const { ks, callTool } = countingSearches()
    // An index that always fills the window with the same flagged chunk.
    const full = (async (name: string, args: Record<string, unknown>) => {
      if (name === 'vector_search_hash') {
        const rows = await callTool(name, args)
        const [first] = rows.data as Array<Record<string, unknown>>
        return { success: true, data: Array.from({ length: Number(args.k) }, () => first) }
      }
      return callTool(name, args)
    }) as CallTool

    expect(await search(fake, full, 5)).toEqual([])
    expect(ks).toEqual([5, 10, 20, 40, 80, 160, 200])
  })

  // Mutation: remove `hits.length < span ||` → the loop keeps widening over an
  // index that has already been read to the end.
  it('stops widening once the index holds fewer chunks than the window', async () => {
    await setDocumentFlags('s1', 'a', { hidden: true }, fake.callTool)
    const { ks, callTool } = countingSearches()
    expect(docIds(await search(fake, callTool, 5))).toEqual(['b'])
    expect(ks).toEqual([5])
  })

  it('reads each document’s flags once per search', async () => {
    const reads: string[] = []
    const counting = (async (name: string, args: Record<string, unknown>) => {
      if (name === 'json_get' && String(args.name).startsWith('stash:doc:')) {
        reads.push(String(args.name))
      }
      return fake.callTool(name, args)
    }) as CallTool
    await setDocumentFlags('s1', 'a', { hidden: true }, fake.callTool)
    await search(fake, counting, 1)
    expect(reads.filter((r) => r.endsWith(':a'))).toHaveLength(1)
  })

  // Mutation: delete the up-front resolution loop (reads run one at a time) →
  // one read in flight; raise `FLAG_READ_CONCURRENCY` past the document count →
  // all five at once.
  it('reads a batch’s distinct documents concurrently, within a bound', async () => {
    for (const id of ['c', 'd', 'e']) await seedIndexed(fake, id)
    let inFlight = 0
    let peak = 0
    const gated = (async (name: string, args: Record<string, unknown>) => {
      if (name !== 'json_get' || !String(args.name).startsWith('stash:doc:')) {
        return fake.callTool(name, args)
      }
      peak = Math.max(peak, ++inFlight)
      await new Promise((resolve) => setTimeout(resolve, 0))
      inFlight--
      return fake.callTool(name, args)
    }) as CallTool

    expect(docIds(await search(fake, gated, 5))).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThan(5)
  })

  // Mutation: delete the visibility check in `searchDocuments` → the backend
  // hands the retriever a hidden document's chunk.
  it('keeps flagged documents out of the redis retriever backend', async () => {
    await setDocumentFlags('s1', 'a', { archived: true }, fake.callTool)
    const backend = createRedisBackend('s1', {
      ensureIngested: false,
      searchFn: (session, query, opts) =>
        searchDocuments(session, query, { ...opts, callTool: fake.callTool, embedOneFn }),
    })
    const hits = await backend.search({ text: 'query' }, { k: 5 })
    expect(docIds(hits)).toEqual(['b'])
  })
})

describe('ensureSessionIngested — hidden and archived documents', () => {
  let fake: Fake
  beforeEach(() => {
    fake = makeFakeRedis()
  })

  async function seed(id: string) {
    await storeDocument(
      { sessionId: 's1', id, filename: `${id}.txt`, mimeType: 'text/plain', content: `text ${id}` },
      fake.callTool,
    )
  }

  // Mutation: delete the `m.hidden || m.archived` skip in `ensureSessionIngested`
  // → both flagged documents are embedded and indexed.
  it('does not ingest hidden or archived documents', async () => {
    const embedSpy = vi.fn(embedFn)
    await seed('visible')
    await seed('hidden')
    await seed('archived')
    await setDocumentFlags('s1', 'hidden', { hidden: true }, fake.callTool)
    await setDocumentFlags('s1', 'archived', { archived: true }, fake.callTool)

    await ensureSessionIngested('s1', { callTool: fake.callTool, embedFn: embedSpy })

    expect(embedSpy).toHaveBeenCalledTimes(1)
    expect((await getDocument('s1', 'visible', fake.callTool))?.ingestStatus).toBe('indexed')
    expect((await getDocument('s1', 'hidden', fake.callTool))?.ingestStatus).toBeUndefined()
    expect((await getDocument('s1', 'archived', fake.callTool))?.ingestStatus).toBeUndefined()
    expect(fake.hashes.size).toBe(1)
  })

  it('reports how many flagged documents it left unindexed', async () => {
    await seed('a')
    await seed('b')
    await seed('c')
    await setDocumentFlags('s1', 'a', { hidden: true }, fake.callTool)
    await setDocumentFlags('s1', 'b', { archived: true }, fake.callTool)

    const first = await ensureSessionIngested('s1', { callTool: fake.callTool, embedFn })
    expect(first).toEqual({ skippedFlagged: 2 })

    await setDocumentFlags('s1', 'a', { hidden: false }, fake.callTool)
    await setDocumentFlags('s1', 'b', { archived: false }, fake.callTool)
    expect(await ensureSessionIngested('s1', { callTool: fake.callTool, embedFn })).toEqual({
      skippedFlagged: 0,
    })

    // An already-indexed document that is flagged later needs no further run.
    await setDocumentFlags('s1', 'a', { hidden: true }, fake.callTool)
    expect(await ensureSessionIngested('s1', { callTool: fake.callTool, embedFn })).toEqual({
      skippedFlagged: 0,
    })
  })

  // Mutation: leave `ensured` true after a run that skipped a flagged document →
  // the backend never runs the net again and the un-hidden document stays
  // unindexed.
  it('re-arms the backend net after skipping a flagged document, so an un-hidden one is indexed', async () => {
    await seed('a')
    await setDocumentFlags('s1', 'a', { hidden: true }, fake.callTool)

    let run: Promise<unknown> = Promise.resolve()
    const ensureFn = vi.fn((sessionId: string) => {
      const p = ensureSessionIngested(sessionId, { callTool: fake.callTool, embedFn })
      run = p
      return p
    })
    const backend = createRedisBackend('s1', {
      ensureFn,
      searchFn: (session, query, opts) =>
        searchDocuments(session, query, { ...opts, callTool: fake.callTool, embedOneFn }),
    })

    expect(await backend.search({ text: 'query' }, { k: 5 })).toEqual([])
    await run
    expect(ensureFn).toHaveBeenCalledTimes(1)

    await setDocumentFlags('s1', 'a', { hidden: false }, fake.callTool)
    await backend.search({ text: 'query' }, { k: 5 })
    await run
    expect(ensureFn).toHaveBeenCalledTimes(2)

    expect(docIds(await backend.search({ text: 'query' }, { k: 5 }))).toEqual(['a'])
    // Everything is indexed now, so the net stays quiet.
    await run
    expect(ensureFn).toHaveBeenCalledTimes(2)
  })

  it('ingests a document once it is un-hidden', async () => {
    const embedSpy = vi.fn(embedFn)
    await seed('a')
    await setDocumentFlags('s1', 'a', { hidden: true }, fake.callTool)
    await ensureSessionIngested('s1', { callTool: fake.callTool, embedFn: embedSpy })
    expect(embedSpy).not.toHaveBeenCalled()

    await setDocumentFlags('s1', 'a', { hidden: false }, fake.callTool)
    await ensureSessionIngested('s1', { callTool: fake.callTool, embedFn: embedSpy })

    expect(embedSpy).toHaveBeenCalledTimes(1)
    expect((await getDocument('s1', 'a', fake.callTool))?.ingestStatus).toBe('indexed')
  })
})
