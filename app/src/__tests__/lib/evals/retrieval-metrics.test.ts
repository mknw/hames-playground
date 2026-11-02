// @vitest-environment node
/**
 * The retrieval-quality grader (`src/lib/retrieval-metrics.ts`), pinned
 * in layer 1 because it is a pure function (kg-test-pyramid rule 1) and is the
 * acceptance instrument for #928 slice 1 and #927 slice 3 — a grader nobody
 * tests would grade the thing it was built to measure.
 *
 * The live run and the hermetic loopback proof live in `app/evals/`; this file
 * pins only the arithmetic.
 */
import { describe, expect, it } from 'vitest'
import {
  gradeQuestion,
  rankOfGroundTruth,
  recallAtK,
  reciprocalRank,
  summarizeGrades,
  RECALL_K_STEPS,
  type GradedHit,
  type GroundTruthChunk,
} from '../../../lib/retrieval-metrics'

const TRUTH: GroundTruthChunk = { docId: 'd1', chunkIndex: 4 }

/** Hits d1:0..9 in order, with d1:4 (the truth) at 1-based rank `at`. */
function corpusOrderedWithTruthAt(at: number): GradedHit[] {
  const others = [...Array(10).keys()]
    .filter((i) => i !== 4)
    .map((i) => ({ docId: 'd1', chunkIndex: i }))
  return [...others.slice(0, at - 1), { docId: 'd1', chunkIndex: 4 }, ...others.slice(at - 1)]
}

describe('rankOfGroundTruth', () => {
  it('returns the 1-BASED rank of the truth chunk', () => {
    // Mutation: returning `idx` (0-based) instead of `idx + 1` shifts every
    // rank down by one — recall@5 would silently grade against a 6-chunk
    // window, and MRR would read a rank too well. Pinned by rank 1 and the
    // boundary rank 5 below, which disagree with the 0-based value.
    expect(rankOfGroundTruth(corpusOrderedWithTruthAt(1), TRUTH)).toBe(1)
    expect(rankOfGroundTruth(corpusOrderedWithTruthAt(5), TRUTH)).toBe(5)
  })

  it('returns null when the truth chunk is not in the hits', () => {
    expect(rankOfGroundTruth([{ docId: 'd1', chunkIndex: 0 }], TRUTH)).toBeNull()
    expect(rankOfGroundTruth([], TRUTH)).toBeNull()
  })

  it('matches on the (docId, chunkIndex) pair, not on position alone', () => {
    expect(rankOfGroundTruth([{ docId: 'd2', chunkIndex: 4 }], TRUTH)).toBeNull()
  })
})

describe('recallAtK', () => {
  it('is 1 exactly while the truth rank is within k', () => {
    const hits = corpusOrderedWithTruthAt(5)
    expect(recallAtK(hits, TRUTH, 4)).toBe(0)
    expect(recallAtK(hits, TRUTH, 5)).toBe(1)
    expect(recallAtK(hits, TRUTH, 20)).toBe(1)
  })

  it('is 0 when the truth was not retrieved at any k', () => {
    expect(recallAtK([], TRUTH, 5)).toBe(0)
  })

  it('a truth at rank 1 is found already at k=1', () => {
    expect(recallAtK(corpusOrderedWithTruthAt(1), TRUTH, 1)).toBe(1)
  })
})

describe('reciprocalRank', () => {
  it('is 1/rank, and 0 for a miss', () => {
    expect(reciprocalRank(corpusOrderedWithTruthAt(1), TRUTH)).toBe(1)
    expect(reciprocalRank(corpusOrderedWithTruthAt(4), TRUTH)).toBeCloseTo(0.25)
    expect(reciprocalRank([], TRUTH)).toBe(0)
  })
})

describe('gradeQuestion', () => {
  it('grades per threshold from one ranked list', () => {
    const g = gradeQuestion('q', corpusOrderedWithTruthAt(7), TRUTH, [5, 10, 20])
    expect(g.questionId).toBe('q')
    expect(g.rank).toBe(7)
    expect(g.reciprocalRank).toBeCloseTo(1 / 7)
    expect(g.recall[5]).toBe(0)
    expect(g.recall[10]).toBe(1)
    expect(g.recall[20]).toBe(1)
  })

  it('defaults to the exported RECALL_K_STEPS', () => {
    const g = gradeQuestion('q', [], TRUTH)
    expect(Object.keys(g.recall).map(Number)).toEqual([...RECALL_K_STEPS])
  })
})

describe('summarizeGrades', () => {
  const ks = [5, 10, 20]

  function g(id: string, rank: number | null) {
    const hits = rank === null ? [] : corpusOrderedWithTruthAt(rank)
    return gradeQuestion(id, hits, TRUTH, ks)
  }

  it('averages per-question 0/1 recall and reciprocal rank', () => {
    // ranks 2, 6, 10 → recall@5 = 1/3, recall@10 = 1, MRR = (1/2 + 1/6 + 1/10)/3
    const s = summarizeGrades('vector-only', [g('a', 2), g('b', 6), g('c', 10)], ks)
    expect(s.questions).toBe(3)
    expect(s.recallAtK[5]).toBeCloseTo(1 / 3)
    expect(s.recallAtK[10]).toBe(1)
    expect(s.recallAtK[20]).toBe(1)
    expect(s.mrr).toBeCloseTo((0.5 + 1 / 6 + 0.1) / 3)
  })

  it('separates a top-k miss from a pageable find (first page of 5)', () => {
    // Truth at rank 8: outside the first page of 5, inside k=20 — exactly the
    // case #927's paging exists for. A total miss lands in neither bucket.
    const s = summarizeGrades('vector-only', [g('paged', 8), g('gone', null)], ks)
    expect(s.pagedFindable).toEqual(['paged'])
    expect(s.totalMisses).toEqual(['gone'])
  })

  it('is 0 on an empty grade set rather than NaN', () => {
    const s = summarizeGrades('vector-only', [], ks)
    expect(s.recallAtK[5]).toBe(0)
    expect(s.mrr).toBe(0)
  })
})
