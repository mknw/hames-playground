/**
 * Hermetic loopback proof for the `retrieval-quality` scenario. Real committed
 * fixtures and the real stash pipeline; a FAKE Redis transport and a FAKE
 * deterministic embedder. No live eval is invoked, nothing bills, no gateway
 * is contacted — every stash call goes through injected `callTool`.
 *
 * Run: `corepack pnpm exec vitest run --config evals/vitest.config.ts`
 * (manual, like the rest of this directory — outside CI and the coverage
 * floors; the grader's arithmetic itself is pinned in CI under
 * `src/__tests__/lib/evals/`).
 *
 * What this file proves:
 *   1. the fixtures are a sound answer key (markers unique, deep answers deep,
 *      corpus larger than the largest graded k);
 *   2. the WHOLE pipeline works end to end — chunk → embed → index → KNN →
 *      grade — through the real `storeDocument` / `ingestDocument` /
 *      `searchDocuments`, over a fake transport;
 *   3. the scenario reports its metrics into the eval report.
 *
 * Wiring proof, not a quality measurement: the fake embedder is hashed
 * bag-of-words, so its retrieval numbers mean nothing. The live run is the
 * measurement, and it is a separate, owner-gated act.
 */
import { createHash } from 'node:crypto'
import { beforeAll, describe, expect, it } from 'vitest'
import {
  deleteSessionStash,
  ingestDocument,
  searchDocuments,
} from '@hames-ai/harness-patterns/stash/document-ingest.server'
import {
  storeDocument,
  type CallTool,
} from '@hames-ai/harness-patterns/stash/document-store.server'
import { deriveGroundTruth, DOCS, QUESTIONS } from './fixtures/retrieval-quality'
import { createRetrievalQualityScenario } from './scenarios/retrieval-quality'
import { runScenario, scenarioPassed } from './harness'
import { renderReport } from './report'
import type { EvalRouting } from './client'

// ============================================================================
// Fixture integrity — the answer key
// ============================================================================

describe('the fixture corpus is a sound answer key', () => {
  const key = deriveGroundTruth()

  it('locates every question exactly once', () => {
    expect(key.length).toBe(QUESTIONS.length)
    expect(new Set(key.map((e) => e.question.id)).size).toBe(QUESTIONS.length)
  })

  it('carries every category the scenario reports', () => {
    const cats = new Set(key.map((e) => e.question.category))
    for (const c of ['exact-term', 'paraphrase', 'deep', 'easy'] as const) {
      expect(cats.has(c), `category ${c} missing from the fixtures`).toBe(true)
    }
  })

  it('the corpus exceeds the largest graded k, so recall@20 is a measurement', () => {
    const chunks = new Map(key.map((e) => [e.doc.id, e.chunkCount]))
    expect([...chunks.values()].reduce((a, b) => a + b, 0)).toBeGreaterThan(20)
  })

  it('every deep answer sits beyond the production first page of 5', () => {
    for (const e of key.filter((x) => x.question.category === 'deep')) {
      expect(
        e.truth.chunkIndex,
        `${e.question.id} truth at chunk ${e.truth.chunkIndex} is not beyond the first page`,
      ).toBeGreaterThanOrEqual(5)
    }
  })
})

// ============================================================================
// Fake transport + fake embedder
// ============================================================================

const DIM = 64

/** Deterministic hashed bag-of-words. Same text → same vector; two texts that
 *  share words land closer than texts that share none. Quality is irrelevant
 *  here — the fake exists so the REAL KNN code has something to rank. */
function fakeVector(text: string): number[] {
  const v = new Array<number>(DIM).fill(0)
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length < 3) continue
    const h = createHash('sha256').update(w).digest()
    v[h[0] % DIM] += 1
    v[h[1] % DIM] += 0.5
  }
  const norm = Math.hypot(...v) || 1
  return v.map((x) => x / norm)
}

const fakeEmbedOne = async (text: string) => ({
  provider: 'local' as const,
  model: 'hermetic-fake-embedder',
  dimensions: DIM,
  vector: fakeVector(text),
})

/** In-memory stand-in for the redis MCP surface the stash pipeline uses —
 *  just enough of `json_set/get`, `sadd/smembers`, `delete` and the four
 *  vector commands for `storeDocument` / `ingestDocument` / `searchDocuments`
 *  / `deleteSessionStash` to run for real. */
function makeFakeCallTool(): CallTool {
  const hashes = new Map<string, Map<string, string>>()
  const vectors = new Map<string, number[]>()
  const jsons = new Map<string, string>()
  const sets = new Map<string, Set<string>>()
  return async (name, args) => {
    try {
      switch (name) {
        case 'json_set':
          jsons.set(String(args.name), String(args.value))
          return { success: true, data: undefined }
        case 'json_get':
          return { success: true, data: jsons.get(String(args.name)) ?? null }
        case 'sadd': {
          const set = sets.get(String(args.name)) ?? new Set<string>()
          set.add(String(args.value))
          sets.set(String(args.name), set)
          return { success: true, data: undefined }
        }
        case 'smembers':
          return { success: true, data: [...(sets.get(String(args.name)) ?? [])] }
        case 'srem':
          sets.get(String(args.name))?.delete(String(args.value))
          return { success: true, data: undefined }
        case 'delete':
          jsons.delete(String(args.key))
          sets.delete(String(args.key))
          vectors.delete(String(args.key))
          hashes.delete(String(args.key))
          return { success: true, data: undefined }
        case 'scan_all_keys': {
          // deleteSessionStash scans with a glob over the session's keys.
          const re = new RegExp(
            String(args.pattern)
              .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
              .replace(/\*/g, '.*'),
          )
          const keys = new Set([...jsons.keys(), ...sets.keys(), ...vectors.keys()])
          return { success: true, data: [...keys].filter((k) => re.test(k)) }
        }
        case 'create_vector_index_hash':
          return { success: true, data: undefined }
        case 'set_vector_in_hash':
          vectors.set(String(args.name), [...(args.vector as number[])])
          if (!hashes.has(String(args.name))) hashes.set(String(args.name), new Map())
          return { success: true, data: undefined }
        case 'hset': {
          const fields = hashes.get(String(args.name)) ?? new Map()
          fields.set(String(args.key), String(args.value))
          hashes.set(String(args.name), fields)
          return { success: true, data: undefined }
        }
        case 'vector_search_hash': {
          const q = args.query_vector as number[]
          const k = Number(args.k)
          const scored = [...vectors.entries()].map(([key, vec]) => ({
            key,
            // 1 - cosine similarity = cosine distance, the metric the index declares.
            score: 1 - q.reduce((s, x, i) => s + x * vec[i], 0),
            meta: hashes.get(key)?.get('meta') ?? '',
          }))
          scored.sort((a, b) => a.score - b.score)
          return {
            success: true,
            data: scored.slice(0, k).map((h) => ({ id: h.key, score: h.score, meta: h.meta })),
          }
        }
        default:
          return {
            success: false,
            data: undefined,
            error: `hermetic fake: unexpected Redis call ${name}`,
          }
      }
    } catch (err) {
      return {
        success: false,
        data: undefined,
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }
}

// ============================================================================
// Full pipeline over the fake transport
// ============================================================================

describe('the retrieval-quality scenario runs the real pipeline hermetically', () => {
  const callTool = makeFakeCallTool()
  const fakeEmbed = async (texts: string[]) => ({
    provider: 'local' as const,
    model: 'hermetic-fake-embedder',
    dimensions: DIM,
    vectors: texts.map(fakeVector),
  })

  const deps = {
    ingest: async (doc: (typeof DOCS)[number], sessionId: string) => {
      const stored = await storeDocument(
        {
          id: doc.id,
          sessionId,
          filename: doc.filename,
          mimeType: doc.mimeType,
          content: doc.content,
        },
        callTool,
      )
      const res = await ingestDocument(stored, { callTool, embedFn: fakeEmbed })
      return { docId: res.docId, chunks: res.chunks }
    },
    search: async (_c: unknown, sessionId: string, query: string, k: number) => {
      const hits = await searchDocuments(sessionId, query, {
        k,
        callTool,
        embedOneFn: fakeEmbedOne,
      })
      return hits.map((h) => ({ docId: h.docId, chunkIndex: h.chunkIndex }))
    },
    cleanup: (sessionId: string) => deleteSessionStash(sessionId, callTool),
  }

  const routing: EvalRouting = { routed: [], note: 'hermetic loopback' }
  let result: Awaited<ReturnType<typeof runScenario>>

  beforeAll(async () => {
    result = await runScenario(createRetrievalQualityScenario(deps), routing)
  })

  it('completes without throwing and passes every structural check', () => {
    expect(result.error).toBeUndefined()
    expect(scenarioPassed(result)).toBe(true)
    // 3 chunk-count pins + 12 non-empty-ranking pins + 1 graded-all pin.
    expect(result.checks.length).toBe(3 + QUESTIONS.length + 1)
    expect(
      result.checks.every((c) => c.pass),
      result.checks
        .filter((c) => !c.pass)
        .map((c) => c.name)
        .join('; '),
    ).toBe(true)
  })

  it('makes NO LLM calls and reports no served client', () => {
    expect(result.calls).toEqual([])
    expect(result.servedBy).toEqual([])
    expect(result.expectedClient).toBe('(no BAML call)')
  })

  it('reports the metrics per configuration into the report', () => {
    const names = result.observations.map((o) => o.name)
    for (const row of [
      'vector-only · recall@5',
      'vector-only · recall@10',
      'vector-only · recall@20',
      'vector-only · MRR',
    ]) {
      expect(names).toContain(row)
    }
    expect(names.some((n) => n.startsWith('vector-only · q-'))).toBe(true)
    expect(names.some((n) => n.includes('category exact-term'))).toBe(true)

    const markdown = renderReport([result], {
      routing,
      startedAt: '2026-01-01T00:00:00.000Z',
      totalMs: 1,
    })
    expect(markdown).toContain('retrieval-quality')
    expect(markdown).toContain('vector-only · recall@5')
  })
})
