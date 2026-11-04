/**
 * Stash index schema-version tests (#928 slice 1) — the `_v<N>` suffix on the
 * index name, the space record that carries the version, the plain `text`
 * field BM25 scores, and the LAZY re-ingest of a corpus recorded under an
 * older schema.
 *
 * Every pin here was verified by mutation: reverting `indexNameFor` to the
 * unsuffixed name, dropping the `text` payload field, or re-narrowing the
 * safety net's `indexed` skip each turn the named test red (red output pasted
 * in the PR).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))
vi.mock('@hames-ai/harness-patterns/mcp-client.server', () => ({
  callTool: vi.fn(async () => ({ success: false, data: null, error: 'no gateway' })),
}))

import {
  STASH_INDEX_SCHEMA_VERSION,
  ensureSessionIngested,
  indexNameFor,
  ingestStashDocument,
  prefixFor,
  searchDocumentsKeyword,
  spaceSchemaVersion,
} from '../../stash/document-ingest.server'
import { storeDocument } from '../../stash/document-store.server'
import type { CallTool } from '../../stash/document-store.server'
import type { ToolCallResult } from '../../types'
import type { EmbeddingResult } from '../../stash/embeddings.server'
import { TEXT_FIELD } from '../../stash/vector-store.server'

// ----------------------------------------------------------------------------
// Fake Redis — JSON docs, a per-session index set, vector hashes with plain
// `text` fields, and an in-memory full-text search over those fields.
// ----------------------------------------------------------------------------
function makeFakeRedis() {
  const json = new Map<string, unknown>()
  const hashes = new Map<string, Record<string, unknown>>()
  const sets = new Map<string, Set<string>>()
  const vectorWrites: string[] = []
  let keywordQuery = ''
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
      case 'delete':
        json.delete(args.key as string)
        sets.delete(args.key as string)
        hashes.delete(args.key as string)
        return { success: true, data: 1 }
      case 'scan_all_keys':
        return { success: true, data: [...json.keys(), ...hashes.keys(), ...sets.keys()] }
      case 'create_vector_index_hash':
        return { success: true, data: 'Index created' }
      case 'set_vector_in_hash': {
        const h = hashes.get(args.name as string) ?? {}
        h.vector = args.vector
        hashes.set(args.name as string, h)
        vectorWrites.push(args.name as string)
        return { success: true, data: true }
      }
      case 'hset': {
        const h = hashes.get(args.name as string) ?? {}
        h[args.key as string] = args.value
        hashes.set(args.name as string, h)
        return { success: true, data: 1 }
      }
      case 'keyword_search_hash': {
        // Rank the fake index's plain `text` fields by how many query terms
        // appear — enough of a ranking to prove the search READ the field.
        keywordQuery = String(args.query ?? '')
        const terms = keywordQuery.toLowerCase().split(/\W+/).filter(Boolean)
        const rows = [...hashes.entries()]
          .filter(([, h]) => typeof h[TEXT_FIELD] === 'string')
          .map(([key, h]) => {
            const body = String(h[TEXT_FIELD]).toLowerCase()
            const matches = terms.filter((t) => body.includes(t)).length
            return { key, score: matches, meta: h.meta }
          })
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, Number(args.k) || 5)
        return { success: true, data: rows }
      }
      default:
        return { success: false, data: null, error: `unhandled ${name}` }
    }
  }) as CallTool
  return { json, hashes, sets, callTool, vectorWrites, query: () => keywordQuery }
}

const embedFn = async (texts: string[]): Promise<EmbeddingResult> => ({
  provider: 'local',
  model: 'test-model',
  dimensions: 8,
  vectors: texts.map((t) => Array.from({ length: 8 }, (_, d) => t.length + d)),
})

describe('the stash index schema version', () => {
  let fake: ReturnType<typeof makeFakeRedis>
  beforeEach(() => {
    fake = makeFakeRedis()
  })

  /** Store + status-track ingest one document, like the upload gate does. */
  async function ingest(id: string, content: string) {
    const stored = await storeDocument(
      {
        sessionId: 's1',
        id,
        filename: `${id}.txt`,
        mimeType: 'text/plain',
        content,
      },
      fake.callTool,
    )
    return ingestStashDocument('s1', id, { callTool: fake.callTool, embedFn })
  }

  it('suffixes the CURRENT schema version onto the index name', () => {
    const space = { provider: 'local' as const, model: 'test-model', dimensions: 8 }
    expect(indexNameFor('s1', space)).toBe(
      `stash_idx_s1_local_test_model_8_v${STASH_INDEX_SCHEMA_VERSION}`,
    )
    // The key prefix is NOT versioned: chunk keys keep one shape, so the
    // session clear and the visibility reads never fork on the schema.
    expect(prefixFor('s1', space)).toBe('stashvec:s1:local_test_model_8:')
  })

  it('reads a space recorded before the field existed as version 1', () => {
    expect(spaceSchemaVersion({ provider: 'local', model: 'm', dimensions: 8 })).toBe(1)
    expect(spaceSchemaVersion({ provider: 'local', model: 'm', dimensions: 8, schema: 2 })).toBe(2)
    expect(
      spaceSchemaVersion({ provider: 'local', model: 'm', dimensions: 8, schema: Number.NaN }),
    ).toBe(1)
  })

  it('ingest writes each chunk text to the plain full-text-indexed field', async () => {
    const res = await ingest('d1', 'alpha beta gamma')
    expect(res?.chunks).toBe(1)
    const chunk = fake.hashes.get('stashvec:s1:local_test_model_8:d1:0')
    expect(chunk).toBeDefined()
    expect(chunk![TEXT_FIELD]).toBe('alpha beta gamma')
  })

  it('ingest records the schema version on the embedding space', async () => {
    await ingest('d1', 'alpha')
    const space = fake.json.get('stash:space:s1') as { schema?: number }
    expect(space.schema).toBe(STASH_INDEX_SCHEMA_VERSION)
  })

  it('the keyword search reads the plain text field and ranks by it', async () => {
    await ingest('d1', 'the torque spec is 2.1 Nm on the mast clamp')
    await ingest('d2', 'the drain plug takes 1.6 Nm and a fresh washer')
    const hits = await searchDocumentsKeyword('s1', 'drain plug', { callTool: fake.callTool })
    expect(hits.map((h) => h.docId)).toEqual(['d2'])
    expect(hits[0]!.content).toContain('drain plug')
    // The query reached the index as text, not as a vector.
    expect(fake.query()).toContain('drain')
  })

  it('a corpus recorded under an OLDER schema is lazily re-ingested', async () => {
    // Ingest, then drag the recorded space back to v1 — the state of every
    // corpus that predates this change.
    await ingest('d1', 'alpha beta')
    const spaceKey = 'stash:space:s1'
    const space = fake.json.get(spaceKey) as { schema?: number }
    expect(space.schema).toBe(2)
    fake.json.set(spaceKey, { ...space, schema: 1 })
    fake.vectorWrites.length = 0

    await ensureSessionIngested('s1', { callTool: fake.callTool, embedFn })

    // The indexed document was re-ingested (new chunk writes) and the space
    // record now carries the current schema, so the next net run is a no-op.
    expect(fake.vectorWrites.length).toBeGreaterThan(0)
    expect((fake.json.get(spaceKey) as { schema?: number }).schema).toBe(2)
  })

  it('a corpus at the CURRENT schema is not re-ingested', async () => {
    await ingest('d1', 'alpha beta')
    fake.vectorWrites.length = 0
    await ensureSessionIngested('s1', { callTool: fake.callTool, embedFn })
    expect(fake.vectorWrites.length).toBe(0)
  })
})
