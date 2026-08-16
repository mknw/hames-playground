/**
 * Vector Store — Server Only
 *
 * A thin, reusable wrapper over the Redis (RediSearch HNSW) vector primitives:
 * ensure an index, upsert (vector + opaque JSON payload), KNN search. Shared by
 * the Data Stash ingest/search (`document-ingest.server.ts`) and the Semantic
 * Cache agent so the embed→index→KNN plumbing lives in one tested place.
 *
 * The caller supplies the index name, key prefix and dimensionality — typically
 * with an embedding-space tag baked into the names (see {@link spaceTag}) so one
 * index never mixes models (vectors from different models aren't comparable; see
 * `embeddings.server.ts`).
 *
 * Two gateway quirks are encapsulated here (see CLAUDE.md → Redis MCP quirks):
 *   - payloads are base64-encoded before `hset` because the gateway auto-parses
 *     JSON-looking string args into objects (which `hset` then rejects);
 *   - `vector_search_hash` results may arrive as one text block per match —
 *     handled by `callTool`'s aggregation + the tolerant {@link decodeMeta}.
 *
 * Requires redis-stack (RediSearch). On arm64 colima run the redis service as
 * `platform: linux/amd64` (see docs/DATA_STASH.md) — the native arm64
 * `redisearch.so` SIGILL-crashes on vector ops.
 */

import { assertServerOnImport } from './harness-patterns/assert.server'
import { stashCallTool } from './redis-direct.server'
import { redisWriteError, type CallTool } from './document-store.server'
import type { EmbeddingSpace } from './embeddings.server'

assertServerOnImport()

// ============================================================================
// Types
// ============================================================================

export interface VectorHit {
  /** The upsert id (recovered from the stored payload). */
  id: string
  /** Vector distance (lower = closer) when the backend reports one. */
  score?: number
  /** The decoded JSON payload stored alongside the vector. */
  payload: Record<string, unknown>
}

export interface VectorStoreOptions {
  /** RediSearch index name (should encode the embedding space — see {@link spaceTag}). */
  indexName: string
  /** Key prefix; each record lives at `${prefix}${id}` and is indexed by the prefix. */
  prefix: string
  /** Vector dimensionality; must match the embedding model's output. */
  dim: number
  /** Distance metric for the index. Default COSINE. */
  distanceMetric?: 'COSINE' | 'L2' | 'IP'
  /** Injectable MCP caller (tests); defaults to the real client. */
  callTool?: CallTool
}

export interface VectorStore {
  readonly indexName: string
  readonly prefix: string
  /** Create the HNSW index, tolerating "already exists". */
  ensureIndex(): Promise<void>
  /** Store a vector + JSON payload at `${prefix}${id}` (2 Redis writes). */
  upsert(id: string, vector: number[], payload?: Record<string, unknown>, ttlSeconds?: number): Promise<void>
  /** KNN search; returns hits with decoded payloads, closest first. */
  search(queryVector: number[], k?: number): Promise<VectorHit[]>
}

const META_FIELD = 'meta'
/** Internal payload key carrying the upsert id, so search can recover it. */
const VID_KEY = '_vid'

// ============================================================================
// Factory
// ============================================================================

export function createVectorStore(opts: VectorStoreOptions): VectorStore {
  const callTool = opts.callTool ?? stashCallTool()
  const metric = opts.distanceMetric ?? 'COSINE'

  async function ensureIndex(): Promise<void> {
    const res = await callTool('create_vector_index_hash', {
      index_name: opts.indexName,
      prefix: opts.prefix,
      dim: opts.dim,
      distance_metric: metric,
    })
    const err = redisWriteError(res)
    if (err && !/exist/i.test(err)) {
      throw new Error(`Failed to create vector index ${opts.indexName}: ${err}`)
    }
  }

  async function upsert(
    id: string,
    vector: number[],
    payload: Record<string, unknown> = {},
    ttlSeconds?: number,
  ): Promise<void> {
    const key = `${opts.prefix}${id}`

    const vec = await callTool('set_vector_in_hash', { name: key, vector })
    const vecErr = redisWriteError(vec)
    if (vecErr) throw new Error(`Failed to store vector for "${id}": ${vecErr}`)

    const meta = encodeMeta({ ...payload, [VID_KEY]: id })
    const m = await callTool('hset', {
      name: key,
      key: META_FIELD,
      value: meta,
      ...(ttlSeconds ? { expire_seconds: ttlSeconds } : {}),
    })
    const mErr = redisWriteError(m)
    if (mErr) throw new Error(`Failed to store payload for "${id}": ${mErr}`)
  }

  async function search(queryVector: number[], k = 5): Promise<VectorHit[]> {
    const res = await callTool('vector_search_hash', {
      index_name: opts.indexName,
      query_vector: queryVector,
      k,
      return_fields: [META_FIELD],
    })
    if (!res.success || res.data == null) return []
    return parseHits(res.data)
  }

  return { indexName: opts.indexName, prefix: opts.prefix, ensureIndex, upsert, search }
}

// ============================================================================
// Naming helpers (shared so one index never mixes embedding models)
// ============================================================================

export function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

/** `provider_model_dim` — equal tags ⇒ comparable vectors / same index. */
export function spaceTag(space: EmbeddingSpace): string {
  return `${space.provider}_${sanitize(space.model)}_${space.dimensions}`
}

// ============================================================================
// Payload encode / decode
// ============================================================================

/**
 * Encode a payload as an opaque, non-JSON string. The MCP gateway auto-parses
 * JSON-looking string args into objects (so a raw JSON `hset` value is rejected
 * as a dict, and a payload that is itself valid JSON would be mangled); the
 * `b64:` prefix keeps it unambiguously a string.
 */
export function encodeMeta(obj: Record<string, unknown>): string {
  return 'b64:' + Buffer.from(JSON.stringify(obj), 'utf8').toString('base64')
}

/** Inverse of {@link encodeMeta}; tolerant of an already-object or plain-JSON value. */
export function decodeMeta(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string') return {}
  let s = raw
  if (s.startsWith('b64:')) {
    try {
      s = Buffer.from(s.slice(4), 'base64').toString('utf8')
    } catch {
      return {}
    }
  }
  try {
    return JSON.parse(s) as Record<string, unknown>
  } catch {
    return {}
  }
}

// ============================================================================
// Search result parsing — tolerant of the gateway's shapes
// ============================================================================

function parseHits(data: unknown): VectorHit[] {
  let rows: unknown = data
  if (typeof rows === 'string') {
    try {
      rows = JSON.parse(rows)
    } catch {
      return []
    }
  }
  if (rows && typeof rows === 'object' && !Array.isArray(rows)) {
    const obj = rows as Record<string, unknown>
    const wrapped = obj.results ?? obj.documents ?? obj.matches
    if (Array.isArray(wrapped)) {
      rows = wrapped
    } else if ('meta' in obj || '_vid' in obj || 'id' in obj || 'score' in obj) {
      // The gateway aggregates N≥2 matches into an array, but returns a SINGLE
      // match as one bare hit object (one text block, not wrapped). Treat a
      // lone hit-shaped object as a one-element result set — otherwise a
      // single-match KNN search silently yields zero hits.
      rows = [obj]
    } else {
      rows = []
    }
  }
  if (!Array.isArray(rows)) return []

  const hits: VectorHit[] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    const payload = decodeMeta(r.meta)
    const id = str(payload[VID_KEY]) ?? str(r.id) ?? str(r.key) ?? ''
    hits.push({
      id,
      score: num(r.score ?? r.distance ?? r.__vector_score),
      payload,
    })
  }
  return hits
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined
}
function num(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}
