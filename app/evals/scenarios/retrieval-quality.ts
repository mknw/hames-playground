/**
 * retrieval-quality — the deterministic retrieval eval (#945, tracked from
 * #928 slice 1 and #927 slice 3).
 *
 * WHY THIS EXISTS: the owner ruled (2026-11-02) that hybrid retrieval (#928
 * slice 1: a BM25 backend + reciprocal-rank fusion) is accepted only once a
 * retrieval-quality eval measures it, and that the same eval grades #927's
 * deferred slice 3 (model-chosen k). Nothing like it existed in this suite.
 *
 * HOW IT GRADES — no LLM judge, no prose reading. A small SYNTHETIC corpus
 * (`../fixtures/retrieval-quality.ts`) is ingested into a fresh stash session;
 * each question's answer sits in a KNOWN chunk, located by running the same
 * `chunkDocument()` call ingest runs. Every question is asked of every
 * backend configuration, and the grader compares the returned (docId,
 * chunkIndex) pairs against the ground truth: recall@k for k in {5, 10, 20}
 * and MRR of the ground-truth chunk, reported per configuration. k=5 is the
 * production page size; k=10 and k=20 are what paging (#927 slice 2) can
 * reach with one and three further pages. All of that arithmetic lives in
 * `src/lib/retrieval-metrics.ts` and is pinned by CI unit tests.
 *
 * Backend configurations are declared in {@link BACKEND_CONFIGS}. Today there
 * is exactly one — vector-only, the shipped redis KNN backend. When #928
 * slice 1 lands, a `vector+bm25+rrf` entry joins the list and the same run
 * reports both side by side; that comparison is the acceptance check.
 *
 * WHAT FAILS AND WHAT DOES NOT. The quality numbers are OBSERVATIONS, never
 * checks: a pass/fail bar on retrieval quality is an owner decision (the same
 * posture as the reliability scenario), and a permanently-red baseline row
 * would drown the regression signal the rest of this suite carries. What IS
 * checked, deterministically:
 *   - the answer key and the ingested corpus agree (per-doc chunk counts) —
 *     a chunker change otherwise grades against stale chunk indexes silently;
 *   - every configuration returned a non-empty ranking for every question;
 *   - every fixture question was graded, for every configuration.
 *
 * NO CHAT MODEL IS CALLED. The only model work is query/chunk EMBEDDING, on
 * whatever `EMBEDDINGS_*` configures; latency sampling shows zero samples for
 * this scenario by design. One live run costs: ~21 chunk embeddings (2
 * batches) + 12 query embeddings per configuration, and the Redis writes
 * ingest needs (2 per chunk over the gateway, serial). The scenario cleans up
 * after itself (`deleteSessionStash`); a run that crashes leaves its session
 * keys to the stash's 7-day TTL.
 *
 * Prerequisites for a live run: Redis up (`docker compose up -d`) and an
 * embedder configured (dev default: `make embed`, the Qwen3-0.6B server on
 * :8090). See the README's cost envelope.
 */

import { randomUUID } from 'node:crypto'
import type { RetrieverBackend } from '@hames-ai/harness-patterns/patterns/retriever.server'
import {
  deleteSessionStash,
  ingestDocument,
} from '@hames-ai/harness-patterns/stash/document-ingest.server'
import { storeDocument } from '@hames-ai/harness-patterns/stash/document-store.server'
import { createRedisBackend } from '@hames-ai/harness-patterns/retriever/redis-backend.server'
import {
  DOCS,
  QUESTIONS,
  deriveGroundTruth,
  type FixtureDoc,
  type QuestionCategory,
} from '../fixtures/retrieval-quality'
import {
  RECALL_K_STEPS,
  gradeQuestion,
  summarizeGrades,
  type ConfigGrade,
  type GradedHit,
  type GroundTruthChunk,
} from '../../src/lib/retrieval-metrics'
import { check, type Check, type Observation, type Scenario } from '../harness'

/** The one search per (question, configuration): the largest graded k, sliced
 *  down for the smaller thresholds. A KNN over a fixed index is deterministic,
 *  so the prefix of a k=20 ranking is the k=5 ranking; the visibility-widening
 *  loop inside `searchDocuments` only reorders when hidden documents are
 *  dropped, and none of the fixtures are hidden. */
const SEARCH_K = Math.max(...RECALL_K_STEPS)

/** First-page size the paging analysis reads against — production's default. */
const FIRST_PAGE_K = 5

// ============================================================================
// Backend configurations
// ============================================================================

/** One ranked backend the questions are asked of. `run` returns the ranked
 *  hits; the grader reads only (docId, chunkIndex) off them. */
interface BackendConfig {
  name: string
  /** One line for the report: what this configuration is today. */
  note: string
  run(sessionId: string, query: string, k: number): Promise<GradedHit[]>
}

/** Today's shipped configuration. The real redis KNN backend, exactly as the
 *  retriever pattern builds it (`ensureIngested:false` — the corpus was just
 *  ingested by this scenario; the background ingest net would double-count). */
const vectorOnly: BackendConfig = {
  name: 'vector-only',
  note: 'redis KNN over the session index — the shipped backend (#928 baseline)',
  async run(sessionId, query, k) {
    const backend: RetrieverBackend = createRedisBackend(sessionId, { ensureIngested: false })
    const hits = await backend.search({ text: query }, { k })
    return hits.map((h) => ({ docId: h.docId ?? '', chunkIndex: h.chunkIndex ?? -1 }))
  },
}

/**
 * The configurations a run measures. #928 slice 1 adds its entry HERE:
 *
 *   vectorBm25Rrf: { name: 'vector+bm25+rrf', ... } — built on the production
 *   keyword backend and the retriever's RRF merge once they exist, NOT on a
 *   locally-reimplemented merge; the eval grades what production runs.
 */
const BACKEND_CONFIGS: BackendConfig[] = [vectorOnly]

// ============================================================================
// Injectable seams (hermetic loopback proof — see retrieval-quality.hermetic.ts)
// ============================================================================

export interface RetrievalDeps {
  /** Store + ingest one fixture document. Defaults to the real stash pipeline
   *  (storeDocument + ingestDocument, default chunker + embedder). */
  ingest?: (doc: FixtureDoc, sessionId: string) => Promise<{ docId: string; chunks: number }>
  /** Rank one query. Defaults to the real backend configuration's `run`. */
  search?: (
    config: BackendConfig,
    sessionId: string,
    query: string,
    k: number,
  ) => Promise<GradedHit[]>
  /** Drop the session's stash. Defaults to the real `deleteSessionStash`. */
  cleanup?: (sessionId: string) => Promise<void>
}

async function liveIngest(
  doc: FixtureDoc,
  sessionId: string,
): Promise<{ docId: string; chunks: number }> {
  const stored = await storeDocument({
    id: doc.id,
    sessionId,
    filename: doc.filename,
    mimeType: doc.mimeType,
    content: doc.content,
  })
  const res = await ingestDocument(stored)
  return { docId: res.docId, chunks: res.chunks }
}

// ============================================================================
// Grading helpers (pure over the fixture + grades; unit-testable in CI)
// ============================================================================

/** Category-level rollups — the whole point of the categories: "does the
 *  keyword-friendly set behave differently from the paraphrase set". */
export function categoryGrades(
  grades: Map<string, ReturnType<typeof gradeQuestion>>,
  byId: Map<string, QuestionCategory>,
): Array<{ category: QuestionCategory; summary: ConfigGrade }> {
  const byCategory = new Map<QuestionCategory, ReturnType<typeof gradeQuestion>[]>()
  for (const [qid, g] of grades) {
    const cat = byId.get(qid)
    if (!cat) continue
    const list = byCategory.get(cat) ?? []
    list.push(g)
    byCategory.set(cat, list)
  }
  return [...byCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, gs]) => ({ category, summary: summarizeGrades(category, gs) }))
}

function fmtPct(f: number): string {
  return `${(f * 100).toFixed(0)}%`
}

/** The per-question report row: everything a human needs to see WHERE it
 *  ranked, not just that it did or didn't. */
function questionRow(
  configName: string,
  qid: string,
  category: QuestionCategory,
  truth: GroundTruthChunk,
  g: ReturnType<typeof gradeQuestion>,
): Observation {
  const recalls = RECALL_K_STEPS.map((k) => `@${k}=${g.recall[k]}`).join(' ')
  return {
    name: `${configName} · ${qid} [${category}]`,
    value:
      `truth ${truth.docId}:${truth.chunkIndex} · rank ${g.rank ?? 'not retrieved'} · ` +
      `RR ${g.reciprocalRank.toFixed(3)} · recall ${recalls}`,
  }
}

function configObservations(grade: ConfigGrade): Observation[] {
  const rows: Observation[] = []
  for (const k of RECALL_K_STEPS) {
    rows.push({ name: `${grade.config} · recall@${k}`, value: fmtPct(grade.recallAtK[k]) })
  }
  rows.push({ name: `${grade.config} · MRR`, value: grade.mrr.toFixed(3) })
  rows.push({
    name: `${grade.config} · pageable misses (rank > ${FIRST_PAGE_K}, within k=${SEARCH_K})`,
    value: grade.pagedFindable.join(', ') || 'none',
  })
  rows.push({
    name: `${grade.config} · unretrieved at k=${SEARCH_K}`,
    value: grade.totalMisses.join(', ') || 'none',
  })
  return rows
}

// ============================================================================
// The scenario
// ============================================================================

export function createRetrievalQualityScenario(deps: RetrievalDeps = {}): Scenario {
  return {
    id: 'retrieval-quality',
    title: 'Retrieval quality — recall@k and MRR against known answer chunks',
    what: 'a synthetic corpus with known answer chunks, graded deterministically per backend configuration — the acceptance check #928 slice 1 (BM25+RRF) and #927 slice 3 (model-chosen k) are owed',
    run: async () => {
      // Throws — and the scenario reports the throw — when a marker is not
      // unique across the corpus and the chunker's overlap window. That is
      // the fixture corruption guard, and it must fire before any Redis
      // write, not after.
      const answerKey = deriveGroundTruth()
      const byId = new Map(answerKey.map((e) => [e.question.id, e.question.category]))
      const chunkCountByKey = new Map(answerKey.map((e) => [e.doc.id, e.chunkCount]))
      // answerKey carries the chunk count per QUESTION, so the same doc would
      // be counted once per question naming it — dedupe to one entry per doc.
      const corpusChunks = [...chunkCountByKey.values()].reduce((a, b) => a + b, 0)
      const sessionId = `eval-retrq-${randomUUID().slice(0, 8)}`

      const checks: Check[] = []
      const observations: Observation[] = [
        {
          name: 'corpus',
          value:
            `${DOCS.length} synthetic docs, ${corpusChunks} chunks · ${QUESTIONS.length} questions · ` +
            `search k=${SEARCH_K} · graded at k∈{${RECALL_K_STEPS.join(',')}}`,
        },
        {
          name: 'configurations',
          value: BACKEND_CONFIGS.map((c) => `${c.name} — ${c.note}`).join('; '),
        },
      ]

      try {
        // ── Ingest ────────────────────────────────────────────────────────
        const ingestedChunks = new Map<string, number>()
        for (const doc of DOCS) {
          const res = deps.ingest
            ? await deps.ingest(doc, sessionId)
            : await liveIngest(doc, sessionId)
          ingestedChunks.set(res.docId, res.chunks)
        }
        for (const doc of DOCS) {
          const expected = chunkCountByKey.get(doc.id)
          const got = ingestedChunks.get(doc.id)
          checks.push(
            check(
              `${doc.id}: ingest chunked like the answer key`,
              expected !== undefined && got === expected,
              `ingested ${got} chunks, answer key derived ${expected} — a mismatch means the ` +
                'grader would score against chunk indexes the corpus no longer has',
            ),
          )
        }

        // ── Search + grade ────────────────────────────────────────────────
        for (const config of BACKEND_CONFIGS) {
          const grades = new Map<string, ReturnType<typeof gradeQuestion>>()
          for (const entry of answerKey) {
            const hits = deps.search
              ? await deps.search(config, sessionId, entry.question.text, SEARCH_K)
              : await config.run(sessionId, entry.question.text, SEARCH_K)
            checks.push(
              check(
                `${config.name} · ${entry.question.id}: non-empty ranking`,
                hits.length > 0,
                `${hits.length} hits — a configuration that answers nothing is a broken run, ` +
                  'not a zero score',
              ),
            )
            grades.set(entry.question.id, gradeQuestion(entry.question.id, hits, entry.truth))
          }
          checks.push(
            check(
              `${config.name}: every fixture question graded`,
              grades.size === QUESTIONS.length,
              `${grades.size}/${QUESTIONS.length}`,
            ),
          )

          const summary = summarizeGrades(config.name, [...grades.values()])
          observations.push(...configObservations(summary))
          for (const { category, summary: cat } of categoryGrades(grades, byId)) {
            observations.push({
              name: `${config.name} · category ${category}`,
              value:
                `n=${cat.questions} · recall@${FIRST_PAGE_K}=${fmtPct(cat.recallAtK[FIRST_PAGE_K])} · ` +
                `recall@${SEARCH_K}=${fmtPct(cat.recallAtK[SEARCH_K])} · MRR ${cat.mrr.toFixed(3)}`,
            })
          }
          for (const entry of answerKey) {
            const g = grades.get(entry.question.id)!
            observations.push(
              questionRow(config.name, entry.question.id, entry.question.category, entry.truth, g),
            )
          }
        }
      } finally {
        const cleanup = deps.cleanup ?? ((id: string) => deleteSessionStash(id))
        await cleanup(sessionId)
      }

      return { checks, observations }
    },
  }
}

/** The registered instance — no injected deps, the real stash pipeline and
 *  the real backend configurations. */
export const retrievalQualityScenario = createRetrievalQualityScenario()
