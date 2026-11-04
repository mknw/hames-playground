/**
 * Reciprocal-rank fusion tests (#928 slice 1) — the pure `reciprocalRankFusion`
 * merge AND its production wiring in the retriever pattern: more than one
 * backend is fused, ONE backend keeps the distance-only sort unchanged.
 *
 * Every pin here was verified by mutation: flipping the merge back to the
 * unconditional distance-only sort, dropping the `+1` rank offset, breaking the
 * dedupe, or removing the k cap each turns the named test red (red output
 * pasted in the PR).
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

import { RRF_K, reciprocalRankFusion, retriever } from '../../patterns/retriever.server'
import { createEvent, createScope } from '../../context.server'
import { createEventView } from '../../patterns/event-view.server'
import type { RetrievalHit, RetrieverBackend, RetrieverData } from '../../patterns/retriever.server'
import type { ContextEvent } from '../../types'

type Data = Record<string, unknown>

const hit = (id: string, backend = 'redis', score?: number): RetrievalHit => ({
  backend,
  id,
  content: `content of ${id}`,
  source: `${id}.txt`,
  ...(score !== undefined ? { score } : {}),
})

// ============================================================================
// The pure merge
// ============================================================================

describe('reciprocalRankFusion', () => {
  it('ranks a hit found by BOTH backends above a hit found by one', () => {
    const a = hit('a')
    const b = hit('b')
    const c = hit('c')
    const fused = reciprocalRankFusion(
      [
        [a, b],
        [c, a],
      ],
      10,
    )
    // a: 1/(60+1) + 1/(60+2) — two contributions; c: rank 1 in list 2 (1/61);
    // b: rank 2 in list 1 (1/62). Agreement outranks every single hit.
    expect(fused[0]!.id).toBe('a')
    expect(fused.map((h) => h.id)).toEqual(['a', 'c', 'b'])
  })

  it('keeps the FIRST occurrence of a duplicate id and sums its contributions', () => {
    const vecHit = hit('d:1', 'redis', 0.13) // a distance
    const kwHit = hit('d:1', 'redis-keyword', 7.4) // BM25 relevance
    const other = hit('d:2', 'redis-keyword', 6.0)
    const fused = reciprocalRankFusion([[vecHit], [kwHit, other]], 10)
    expect(fused).toHaveLength(2)
    const merged = fused.find((h) => h.id === 'd:1')!
    // First occurrence wins the fields: the vector backend came first.
    expect(merged.backend).toBe('redis')
    // The fused score replaces the per-backend score (see the next pin).
    expect(merged.score).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 1))
  })

  it('fuses ties deterministically — first-encountered order wins', () => {
    // a is rank 2 in list 1 and rank 1 in list 2; b is rank 1 in list 1 and
    // rank 2 in list 2. Identical contributions → a tie → stable sort keeps
    // first-encountered order (a, seen first in list 1).
    const a = hit('a')
    const b = hit('b')
    const fused = reciprocalRankFusion(
      [
        [b, a],
        [a, b],
      ],
      10,
    )
    expect(fused.map((h) => h.id)).toEqual(['b', 'a'])
    expect(fused[0]!.score).toBeCloseTo(fused[1]!.score!)
  })

  it('handles one empty list — the other list still ranks in full', () => {
    const a = hit('a')
    const b = hit('b')
    const fused = reciprocalRankFusion([[], [a, b]], 10)
    expect(fused.map((h) => h.id)).toEqual(['a', 'b'])
    expect(fused[0]!.score).toBeCloseTo(1 / (RRF_K + 1))
  })

  it('caps the merged list at k', () => {
    const lists = [
      [hit('a'), hit('b'), hit('c')],
      [hit('d'), hit('e'), hit('f')],
    ]
    const fused = reciprocalRankFusion(lists, 4)
    expect(fused).toHaveLength(4)
    expect(reciprocalRankFusion(lists, 2)).toHaveLength(2)
  })

  it('uses the documented constant K=60 — and a different constant changes the scores', () => {
    expect(RRF_K).toBe(60)
    const lists = [[hit('a')], [hit('a')]]
    const at60 = reciprocalRankFusion(lists, 10)
    const at0 = reciprocalRankFusion(lists, 10, 0)
    expect(at60[0]!.score).toBeCloseTo(2 / 61)
    expect(at0[0]!.score).toBeCloseTo(2 / 1)
  })

  it('scores are strictly the RRF formula 1/(K+rank), summed per backend', () => {
    const a = hit('a') // rank 1 in list 1
    const b = hit('b') // rank 2 in list 1, rank 1 in list 2
    const fused = reciprocalRankFusion([[a, b], [b]], 10)
    expect(fused[0]!.id).toBe('b')
    expect(fused[0]!.score).toBeCloseTo(1 / (RRF_K + 2) + 1 / (RRF_K + 1))
    expect(fused[1]!.score).toBeCloseTo(1 / (RRF_K + 1))
  })
})

// ============================================================================
// The production wiring — through the retriever pattern's own fn
// ============================================================================

const userMessage = (text: string): ContextEvent =>
  createEvent('user_message', 'harness', { content: text })

const runPattern = async (backends: RetrieverBackend[], k = 5): Promise<RetrievalHit[]> => {
  const pattern = retriever<Data>({
    patternId: 'retriever',
    backends,
    k,
    rewrite: vi.fn() as never,
    generateQuery: false,
  })
  const ctx = { events: [userMessage('what does the document say?')] } as unknown as Parameters<
    typeof createEventView
  >[0]
  const scope = await pattern.fn(
    createScope<Data>('retriever', {}),
    createEventView(ctx, undefined, 'retriever'),
  )
  return (scope.data as RetrieverData).matches ?? []
}

describe('the retriever merge', () => {
  it('fuses two backends by reciprocal rank — agreement wins over distance', async () => {
    // The vector backend's CLOSEST hit (distance 0.01) is found by one backend
    // only; the chunk both backends rank (even modestly) must come out ahead.
    const vecOnly = { ...hit('v:1', 'redis', 0.01) }
    const agreed = hit('d:2', 'redis', 0.5)
    const agreedKeyword = hit('d:2', 'redis-keyword', 9.9)
    const vectorBackend: RetrieverBackend = {
      name: 'redis',
      type: 'vector',
      search: vi.fn(async () => [agreed, vecOnly]),
    }
    const keywordBackend: RetrieverBackend = {
      name: 'redis-keyword',
      type: 'keyword',
      search: vi.fn(async () => [agreedKeyword]),
    }
    const matches = await runPattern([vectorBackend, keywordBackend])
    expect(matches[0]!.id).toBe('d:2')
    // The fused score is an RRF score, not a distance.
    expect(matches[0]!.score).toBeCloseTo(1 / (RRF_K + 1) + 1 / (RRF_K + 1))
  })

  it('ONE backend keeps the distance-only sort — behaviour unchanged', async () => {
    const backend: RetrieverBackend = {
      name: 'redis',
      type: 'vector',
      search: vi.fn(async () => [
        hit('v:2', 'redis', 0.4),
        hit('v:1', 'redis', 0.01), // closest — must be first
        hit('v:3', 'redis'), // no score — sorts last
      ]),
    }
    const matches = await runPattern([backend])
    expect(matches.map((m) => m.id)).toEqual(['v:1', 'v:2', 'v:3'])
    // The scores are the backend's own distances, untouched by any fusion.
    expect(matches[0]!.score).toBe(0.01)
  })

  it('a failing backend contributes an empty list, not a broken retrieval', async () => {
    const failing: RetrieverBackend = {
      name: 'redis-keyword',
      type: 'keyword',
      search: vi.fn(async () => {
        throw new Error('no full-text search on this transport')
      }),
    }
    const working: RetrieverBackend = {
      name: 'redis',
      type: 'vector',
      search: vi.fn(async () => [hit('v:1', 'redis', 0.2), hit('v:2', 'redis', 0.3)]),
    }
    const matches = await runPattern([working, failing])
    expect(matches.map((m) => m.id)).toEqual(['v:1', 'v:2'])
  })
})
