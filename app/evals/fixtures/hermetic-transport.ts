/**
 * Hermetic fixtures for the `retrieval-quality` scenario — a FAKE Redis
 * transport and a FAKE deterministic embedder. No live eval is invoked,
 * nothing bills, no gateway is contacted — every stash call goes through the
 * injected `callTool`.
 *
 * The fake embedder is a hashed bag-of-words: same text → same vector; two
 * texts that share words land closer than texts that share none. Quality is
 * irrelevant — the fake exists so the REAL pipeline code has something to
 * rank. The fake transport implements just enough of the redis MCP surface
 * (`json_set/get`, `sadd/smembers/srem`, `delete`, `scan_all_keys` and the
 * vector commands) for `storeDocument` / `ingestDocument` / `searchDocuments`
 * / `deleteSessionStash` to run for real.
 *
 * WHAT THE HERMETIC LAYER CAN AND CANNOT SHOW: the pipeline wiring is real
 * (chunk → embed → index → search → grade); the SCORING is not. The vector
 * side ranks by cosine over a toy embedder, and the keyword side (when
 * `keyword_search_hash` is answered — see below) ranks by BM25 computed in
 * THIS FILE, not by RediSearch's own BM25 implementation. Numbers from a
 * hermetic run are wiring evidence, never a quality measurement — the live
 * run is the measurement, and it is a separate, owner-gated act.
 */
import { createHash } from 'node:crypto'
import type { RetrievalHit } from '@hames-ai/harness-patterns/patterns/retriever.server'
import { reciprocalRankFusion } from '@hames-ai/harness-patterns/patterns/retriever.server'
import {
  searchDocuments,
  searchDocumentsKeyword,
} from '@hames-ai/harness-patterns/stash/document-ingest.server'
import type { CallTool } from '@hames-ai/harness-patterns/stash/document-store.server'
import { createRedisBackend } from '@hames-ai/harness-patterns/retriever/redis-backend.server'
import { createRedisKeywordBackend } from '@hames-ai/harness-patterns/retriever/redis-keyword-backend.server'
import type { RetrievalIo } from '../scenarios/retrieval-quality'

export const DIM = 64

/** BM25 parameters, the standard defaults (Robertson & Spärck Jones lineage;
 *  the values Lucene and RediSearch use). */
const K1 = 1.2
const B = 0.75
/** Deterministic hashed bag-of-words. Same text → same vector; two texts that
 *  share words land closer than texts that share none. Quality is irrelevant
 *  here — the fake exists so the REAL KNN code has something to rank. */
export function fakeVector(text: string): number[] {
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

export const fakeEmbedOne = async (text: string) => ({
  provider: 'local' as const,
  model: 'hermetic-fake-embedder',
  dimensions: DIM,
  vector: fakeVector(text),
})

export const fakeEmbed = async (texts: string[]) => ({
  provider: 'local' as const,
  model: 'hermetic-fake-embedder',
  dimensions: DIM,
  vectors: texts.map(fakeVector),
})

/** In-memory stand-in for the redis MCP surface the stash pipeline uses. */
export function makeFakeCallTool(): CallTool {
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
        case 'keyword_search_hash': {
          // BM25 (k1=1.2, b=0.75) over the fake index's `text` fields — the
          // same ranking function RediSearch's SCORER BM25 implements,
          // computed here because the fake has no RediSearch. A chunk that
          // matches no query term is not a hit. Case-folding matches
          // RediSearch's default.
          const k = Number(args.k)
          const terms = String(args.query ?? '')
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter(Boolean)
          const docTerms = new Map<string, Map<string, number>>()
          for (const [key, fields] of hashes) {
            const text = fields.get('text')
            if (text == null) continue
            const tf = new Map<string, number>()
            for (const t of text.toLowerCase().split(/[^a-z0-9]+/)) {
              if (t) tf.set(t, (tf.get(t) ?? 0) + 1)
            }
            docTerms.set(key, tf)
          }
          const N = docTerms.size || 1
          const avgdl = [...docTerms.values()].reduce((s, m) => s + m.size, 0) / N || 1
          const scored: Array<{ key: string; score: number; meta: string }> = []
          for (const [key, tf] of docTerms) {
            let score = 0
            for (const term of terms) {
              const f = tf.get(term)
              if (!f) continue
              const df = [...docTerms.values()].filter((m) => m.has(term)).length || 1
              const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
              score += idf * ((f * (K1 + 1)) / (f + K1 * (1 - B + B * (tf.size / avgdl))))
            }
            if (score > 0) scored.push({ key, score, meta: hashes.get(key)?.get('meta') ?? '' })
          }
          scored.sort((a, b) => b.score - a.score)
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

/**
 * The hermetic {@link RetrievalIo}: the PRODUCTION backend factories and the
 * PRODUCTION RRF merge, each reaching the stash through the injected fake
 * transport instead of the real one — what lets the hermetic loopback grade
 * the same composition the live run grades.
 */
export function hermeticIo(callTool: CallTool): RetrievalIo {
  const searchVector = (
    sessionId: string,
    text: string,
    opts?: { k?: number; excludeIds?: string[] },
  ) => searchDocuments(sessionId, text, { ...opts, callTool, embedOneFn: fakeEmbedOne })
  const searchKeyword = (
    sessionId: string,
    text: string,
    opts?: { k?: number; excludeIds?: string[] },
  ) => searchDocumentsKeyword(sessionId, text, { ...opts, callTool })
  return {
    vectorBackend: (sessionId) =>
      createRedisBackend(sessionId, { ensureIngested: false, searchFn: searchVector }),
    keywordBackend: (sessionId) =>
      createRedisKeywordBackend(sessionId, { ensureIngested: false, searchFn: searchKeyword }),
    fuse: (lists: RetrievalHit[][], k: number) => reciprocalRankFusion(lists, k),
  }
}
