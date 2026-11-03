/**
 * Retrieval-quality metrics — pure, deterministic, no I/O.
 *
 * The grader behind `pnpm eval:harness`'s `retrieval-quality` scenario
 * (`app/evals/scenarios/retrieval-quality.ts`, issue #945, tracked from
 * #928/#927). It compares the chunk ids a retrieval backend returned against a
 * KNOWN ground-truth chunk per question — no LLM judge, no prose reading — so
 * the same numbers can be produced by a unit test, by a live run and by the
 * hermetic loopback proof, and so recall@k / MRR stay comparable across
 * backend configurations (today vector-only; later vector+BM25+RRF per #928
 * slice 1).
 *
 * Lives under `src/` (not `app/evals/`) on purpose: everything provable about
 * a pure function is proved in CI (kg-test-pyramid rule 1), and the evals
 * import FROM src — never the other way round (`evals-not-in-ci.test.ts`).
 *
 * Grading is over (docId, chunkIndex) pairs rather than the backends'
 * composed `id` strings, so a backend that formats ids differently is graded
 * identically to one that composes `${docId}:${chunkIndex}` like the redis
 * backend does.
 */

/** The chunk that holds a question's answer, located at fixture-build time. */
export interface GroundTruthChunk {
  docId: string
  chunkIndex: number
}

/** The one field pair the grader reads off a hit. Both `RetrievalHit` (the
 *  retriever's normalized shape) and `SearchHit` (the stash's) carry them. */
export interface GradedHit {
  docId: string
  chunkIndex: number
}

/** 1-based rank of the ground-truth chunk in `hits`, or null when not hit. */
export function rankOfGroundTruth(hits: GradedHit[], truth: GroundTruthChunk): number | null {
  const idx = hits.findIndex((h) => h.docId === truth.docId && h.chunkIndex === truth.chunkIndex)
  return idx === -1 ? null : idx + 1
}

/** recall@k for ONE question: 1 when the ground-truth chunk is inside the top
 *  k hits, else 0. A per-question 0/1 — the aggregate divides by the question
 *  count, which is what keeps a missed question from being hidden by an easy
 *  one. */
export function recallAtK(hits: GradedHit[], truth: GroundTruthChunk, k: number): 0 | 1 {
  const rank = rankOfGroundTruth(hits, truth)
  return rank !== null && rank <= k ? 1 : 0
}

/** Reciprocal rank for one question: 1/rank, 0 when the truth was not hit. */
export function reciprocalRank(hits: GradedHit[], truth: GroundTruthChunk): number {
  const rank = rankOfGroundTruth(hits, truth)
  return rank === null ? 0 : 1 / rank
}

/** The k thresholds a scenario grades at. Exported so the report and the
 *  scenario agree on them without one reaching into the other's literals. */
export const RECALL_K_STEPS = [5, 10, 20] as const

/** One question's grade against one ranked list. */
export interface QuestionGrade {
  questionId: string
  /** 1-based rank of the ground-truth chunk, null when not retrieved at all. */
  rank: number | null
  reciprocalRank: number
  /** Per-threshold 0/1, keyed by k. */
  recall: Record<number, 0 | 1>
}

/** Grade one question. `ks` is the threshold list; the ranked list must have
 *  been retrieved with `k >= max(ks)` so every prefix here is a real prefix of
 *  the ranking (the scenario searches once at the largest k and slices). */
export function gradeQuestion(
  questionId: string,
  hits: GradedHit[],
  truth: GroundTruthChunk,
  ks: readonly number[] = RECALL_K_STEPS,
): QuestionGrade {
  const rank = rankOfGroundTruth(hits, truth)
  const recall: Record<number, 0 | 1> = {}
  for (const k of ks) recall[k] = rank !== null && rank <= k ? 1 : 0
  return {
    questionId,
    rank,
    reciprocalRank: rank === null ? 0 : 1 / rank,
    recall,
  }
}

/** Aggregated metrics for one backend configuration over all questions. */
export interface ConfigGrade {
  config: string
  questions: number
  /** recall@k as a fraction of questions, per threshold. */
  recallAtK: Record<number, number>
  /** Mean reciprocal rank over all questions (a miss contributes 0). */
  mrr: number
  /** Question ids whose ground truth was not retrieved at the largest k —
   *  paging could not surface them either, at this ranking. */
  totalMisses: string[]
  /** Question ids whose truth sits beyond the first page (rank > first k) but
   *  inside the largest k — exactly the cases paging (#927) exists for. */
  pagedFindable: string[]
}

/** Aggregate one configuration's per-question grades. `ks` must match the
 *  thresholds `gradeQuestion` was called with; `firstK` is the production
 *  page size (5) that separates a top-k miss from a paged find. */
export function summarizeGrades(
  config: string,
  grades: QuestionGrade[],
  ks: readonly number[] = RECALL_K_STEPS,
  firstK = 5,
): ConfigGrade {
  const n = grades.length
  const recallAtK: Record<number, number> = {}
  for (const k of ks) {
    recallAtK[k] = n === 0 ? 0 : grades.reduce((s, g) => s + g.recall[k], 0) / n
  }
  const mrr = n === 0 ? 0 : grades.reduce((s, g) => s + g.reciprocalRank, 0) / n
  const largestK = ks[ks.length - 1]
  return {
    config,
    questions: n,
    recallAtK,
    mrr,
    totalMisses: grades.filter((g) => g.rank === null).map((g) => g.questionId),
    pagedFindable: grades
      .filter((g) => g.rank !== null && g.rank > firstK && g.rank <= largestK)
      .map((g) => g.questionId),
  }
}
