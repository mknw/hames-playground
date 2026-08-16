/**
 * Status-tracked ingest tests — `ingestStashDocument` + `ensureSessionIngested`
 * (the harness-aware Data Stash auto-ingest gate + retriever safety net).
 *
 * Drives the REAL document-store (storeDocument / setDocumentFlags / getDocument)
 * over a fake Redis so status transitions are exercised end-to-end: indexed on
 * success, failed on error/binary, and idempotent skip-when-terminal.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))
vi.mock('../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: vi.fn(async () => ({ success: false, data: null, error: 'no gateway' })),
}))

import { ingestStashDocument, ensureSessionIngested } from '../../lib/document-ingest.server'
import { storeDocument, setDocumentFlags, getDocument } from '../../lib/document-store.server'
import type { CallTool } from '../../lib/document-store.server'
import type { ToolCallResult } from '../../lib/harness-patterns/types'
import type { EmbeddingConfig, EmbeddingResult } from '../../lib/embeddings.server'

// ----------------------------------------------------------------------------
// Fake Redis: JSON docs + a per-session index set + vector hashes.
// ----------------------------------------------------------------------------
function makeFakeRedis() {
  const json = new Map<string, unknown>()
  const hashes = new Map<string, Record<string, unknown>>()
  const sets = new Map<string, Set<string>>()
  const callTool = (async (name: string, args: Record<string, unknown>): Promise<ToolCallResult> => {
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
      default:
        return { success: false, data: null, error: `unhandled ${name}` }
    }
  }) as CallTool
  return { json, hashes, sets, callTool }
}

function makeEmbedder(model: string, dim: number) {
  const embedFn = async (texts: string[], config?: EmbeddingConfig): Promise<EmbeddingResult> => ({
    provider: config?.provider ?? 'local',
    model: config?.model ?? model,
    dimensions: dim,
    vectors: texts.map((t, i) => Array.from({ length: dim }, (_, d) => t.length + i + d)),
  })
  return { embedFn }
}

async function seed(
  fake: ReturnType<typeof makeFakeRedis>,
  id: string,
  content: string,
  opts: { encoding?: 'base64'; mimeType?: string } = {},
) {
  return storeDocument(
    {
      sessionId: 's1',
      id,
      filename: `${id}.txt`,
      mimeType: opts.mimeType ?? 'text/plain',
      content,
      ...(opts.encoding ? { encoding: opts.encoding } : {}),
    },
    fake.callTool,
  )
}

/** A base64 "binary" doc of a convertible type (e.g. a PDF). */
async function seedBinary(
  fake: ReturnType<typeof makeFakeRedis>,
  id: string,
  mimeType = 'application/pdf',
) {
  return seed(fake, id, Buffer.from(`raw ${id} bytes`).toString('base64'), {
    encoding: 'base64',
    mimeType,
  })
}

describe('ingestStashDocument', () => {
  let fake: ReturnType<typeof makeFakeRedis>
  beforeEach(() => {
    fake = makeFakeRedis()
  })

  it('indexes a text doc and stamps status "indexed"', async () => {
    const { embedFn } = makeEmbedder('m', 3)
    await seed(fake, 'd1', 'Alpha sentence.\n\nBeta paragraph.')
    const res = await ingestStashDocument('s1', 'd1', { callTool: fake.callTool, embedFn })
    expect(res?.docId).toBe('d1')
    expect((await getDocument('s1', 'd1', fake.callTool))?.ingestStatus).toBe('indexed')
    expect(fake.hashes.size).toBeGreaterThan(0)
  })

  it('marks a base64 binary doc "failed" without attempting ingest', async () => {
    const { embedFn } = makeEmbedder('m', 3)
    await seed(fake, 'bin', Buffer.from('binary').toString('base64'), { encoding: 'base64' })
    const res = await ingestStashDocument('s1', 'bin', { callTool: fake.callTool, embedFn })
    expect(res).toBeNull()
    expect((await getDocument('s1', 'bin', fake.callTool))?.ingestStatus).toBe('failed')
    expect(fake.hashes.size).toBe(0)
  })

  it('returns null for a missing doc', async () => {
    const { embedFn } = makeEmbedder('m', 3)
    expect(await ingestStashDocument('s1', 'ghost', { callTool: fake.callTool, embedFn })).toBeNull()
  })

  it('marks status "failed" (and never throws) when ingest errors', async () => {
    const boom: ReturnType<typeof makeEmbedder>['embedFn'] = async () => {
      throw new Error('embedder offline')
    }
    await seed(fake, 'd2', 'some text')
    const res = await ingestStashDocument('s1', 'd2', { callTool: fake.callTool, embedFn: boom })
    expect(res).toBeNull()
    expect((await getDocument('s1', 'd2', fake.callTool))?.ingestStatus).toBe('failed')
  })
})

describe('ingestStashDocument — binary conversion', () => {
  let fake: ReturnType<typeof makeFakeRedis>
  beforeEach(() => {
    fake = makeFakeRedis()
  })
  afterEach(() => {
    delete process.env.STASH_CONVERT_DOCS
  })

  it('converts a convertible binary → persists derivedText, chunks the markdown, indexes', async () => {
    process.env.STASH_CONVERT_DOCS = '1'
    const { embedFn } = makeEmbedder('m', 3)
    const embedSpy = vi.fn(embedFn)
    const markdown =
      '# Architecture\n\nThe system uses a Rust core.\n\n## Storage\n\nRedis holds the vectors.'
    const convertFn = vi.fn(async () => markdown)
    await seedBinary(fake, 'pdf1')

    const res = await ingestStashDocument('s1', 'pdf1', {
      callTool: fake.callTool,
      embedFn: embedSpy,
      convertFn,
    })

    expect(res?.docId).toBe('pdf1')
    expect(convertFn).toHaveBeenCalledTimes(1)
    const stored = await getDocument('s1', 'pdf1', fake.callTool)
    expect(stored?.ingestStatus).toBe('indexed')
    expect(stored?.derivedText).toBe(markdown) // persisted for viewer/citations
    expect(stored?.encoding).toBe('base64') // original bytes kept for download
    expect(fake.hashes.size).toBeGreaterThan(0)
    // Chunks were derived from the MARKDOWN, not the base64 original.
    const embedded = embedSpy.mock.calls[0][0].join('\n')
    expect(embedded).toContain('Architecture')
    expect(embedded).toContain('Storage')
  })

  it('marks a convertible binary "failed" when conversion is disabled', async () => {
    const { embedFn } = makeEmbedder('m', 3)
    const convertFn = vi.fn(async () => '# md')
    await seedBinary(fake, 'pdf2')
    const res = await ingestStashDocument('s1', 'pdf2', {
      callTool: fake.callTool,
      embedFn,
      convertFn,
    })
    expect(res).toBeNull()
    expect(convertFn).not.toHaveBeenCalled()
    const stored = await getDocument('s1', 'pdf2', fake.callTool)
    expect(stored?.ingestStatus).toBe('failed')
    expect(stored?.derivedText).toBeUndefined()
  })

  it('marks "failed" (never throws) when conversion errors, stores no derivedText', async () => {
    process.env.STASH_CONVERT_DOCS = '1'
    const { embedFn } = makeEmbedder('m', 3)
    const convertFn = vi.fn(async () => {
      throw new Error('doc-convert sidecar down')
    })
    await seedBinary(fake, 'pdf3')
    const res = await ingestStashDocument('s1', 'pdf3', {
      callTool: fake.callTool,
      embedFn,
      convertFn,
    })
    expect(res).toBeNull()
    const stored = await getDocument('s1', 'pdf3', fake.callTool)
    expect(stored?.ingestStatus).toBe('failed')
    expect(stored?.derivedText).toBeUndefined()
    expect(fake.hashes.size).toBe(0)
  })
})

describe('ensureSessionIngested', () => {
  let fake: ReturnType<typeof makeFakeRedis>
  beforeEach(() => {
    fake = makeFakeRedis()
  })

  it('ingests every not-yet-indexed doc, and is idempotent on a second run', async () => {
    const { embedFn } = makeEmbedder('m', 3)
    const embedSpy = vi.fn(embedFn)
    await seed(fake, 'a', 'Aaa text.')
    await seed(fake, 'b', 'Bbb text.')

    await ensureSessionIngested('s1', { callTool: fake.callTool, embedFn: embedSpy })
    expect((await getDocument('s1', 'a', fake.callTool))?.ingestStatus).toBe('indexed')
    expect((await getDocument('s1', 'b', fake.callTool))?.ingestStatus).toBe('indexed')

    const callsAfterFirst = embedSpy.mock.calls.length
    await ensureSessionIngested('s1', { callTool: fake.callTool, embedFn: embedSpy })
    expect(embedSpy.mock.calls.length).toBe(callsAfterFirst) // nothing re-embedded
  })

  it('ingests failed + absent, skips indexed + pending + binary', async () => {
    const { embedFn } = makeEmbedder('m', 3)
    const embedSpy = vi.fn(embedFn)
    await seed(fake, 'already', 'Already indexed text.')
    await setDocumentFlags('s1', 'already', { ingestStatus: 'indexed' }, fake.callTool)
    await seed(fake, 'old-failed', 'Previously failed (embedder was down).')
    await setDocumentFlags('s1', 'old-failed', { ingestStatus: 'failed' }, fake.callTool)
    await seed(fake, 'in-flight', 'Being ingested by the upload gate.')
    await setDocumentFlags('s1', 'in-flight', { ingestStatus: 'pending' }, fake.callTool)
    await seed(fake, 'bin', Buffer.from('b').toString('base64'), { encoding: 'base64' })
    await seed(fake, 'fresh', 'Fresh content here.')

    await ensureSessionIngested('s1', { callTool: fake.callTool, embedFn: embedSpy })

    expect((await getDocument('s1', 'fresh', fake.callTool))?.ingestStatus).toBe('indexed') // absent → ingested
    // A prior failure is transient — retried and recovered now the embedder's up.
    expect((await getDocument('s1', 'old-failed', fake.callTool))?.ingestStatus).toBe('indexed')
    expect((await getDocument('s1', 'already', fake.callTool))?.ingestStatus).toBe('indexed') // skipped
    expect((await getDocument('s1', 'in-flight', fake.callTool))?.ingestStatus).toBe('pending') // skipped (gate owns it)
    expect((await getDocument('s1', 'bin', fake.callTool))?.ingestStatus).toBeUndefined() // skipped (binary)
    expect(embedSpy).toHaveBeenCalledTimes(2) // old-failed + fresh only
  })

  it('with conversion enabled, ingests a convertible binary (no longer skipped)', async () => {
    process.env.STASH_CONVERT_DOCS = '1'
    try {
      const { embedFn } = makeEmbedder('m', 3)
      const convertFn = vi.fn(async () => '# Title\n\nBody text here.')
      await seedBinary(fake, 'pdfx')
      await ensureSessionIngested('s1', { callTool: fake.callTool, embedFn, convertFn })
      const stored = await getDocument('s1', 'pdfx', fake.callTool)
      expect(stored?.ingestStatus).toBe('indexed')
      expect(convertFn).toHaveBeenCalledTimes(1)
    } finally {
      delete process.env.STASH_CONVERT_DOCS
    }
  })
})
