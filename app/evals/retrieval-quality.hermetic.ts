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
 *   2. the WHOLE pipeline works end to end — chunk → embed → index → search
 *      (both halves: KNN and the BM25 keyword search) → RRF merge → grade —
 *      through the real `storeDocument` / `ingestDocument` / `searchDocuments`
 *      / `searchDocumentsKeyword` / `reciprocalRankFusion`, over a fake
 *      transport;
 *   3. the scenario reports its metrics into the eval report.
 *
 * Wiring proof, not a quality measurement: the fake embedder is hashed
 * bag-of-words, so its retrieval numbers mean nothing — see
 * `fixtures/hermetic-transport.ts` for exactly what the hermetic layer can and
 * cannot show. The live run is the measurement, and it is a separate,
 * owner-gated act.
 */
import { beforeAll, describe, expect, it } from 'vitest'
import {
  deleteSessionStash,
  ingestDocument,
} from '@hames-ai/harness-patterns/stash/document-ingest.server'
import { storeDocument } from '@hames-ai/harness-patterns/stash/document-store.server'
import { fakeEmbed, hermeticIo, makeFakeCallTool } from './fixtures/hermetic-transport'
import { deriveGroundTruth, DOCS, QUESTIONS } from './fixtures/retrieval-quality'
import { BACKEND_CONFIGS, createRetrievalQualityScenario } from './scenarios/retrieval-quality'
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
// Full pipeline over the fake transport
// ============================================================================

describe('the retrieval-quality scenario runs the real pipeline hermetically', () => {
  const callTool = makeFakeCallTool()

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
    io: hermeticIo(callTool),
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
    // 3 chunk-count pins + (12 non-empty-ranking + 1 graded-all) per configuration.
    expect(result.checks.length).toBe(3 + BACKEND_CONFIGS.length * (QUESTIONS.length + 1))
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
      'vector+bm25+rrf · recall@5',
      'vector+bm25+rrf · MRR',
    ]) {
      expect(names).toContain(row)
    }
    expect(names.some((n) => n.startsWith('vector-only · q-'))).toBe(true)
    expect(names.some((n) => n.startsWith('vector+bm25+rrf · q-'))).toBe(true)
    expect(names.some((n) => n.includes('category exact-term'))).toBe(true)

    const markdown = renderReport([result], {
      routing,
      startedAt: '2026-01-01T00:00:00.000Z',
      totalMs: 1,
    })
    expect(markdown).toContain('retrieval-quality')
    expect(markdown).toContain('vector-only · recall@5')
    expect(markdown).toContain('vector+bm25+rrf · recall@5')
  })
})
