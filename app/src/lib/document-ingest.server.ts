/**
 * Document Ingestion — Server Only (ties #6 + #9 + #8 together)
 *
 * The capstone of the store → chunk → embed pipeline. Takes a stored
 * {@link StashDocument} and makes it *searchable*:
 *
 *   chunkDocument(content)  →  embed(chunks)  →  vector store (RediSearch HNSW)
 *
 * and answers queries:
 *
 *   embedOne(query)  →  vector store KNN  →  top-k chunks (with provenance)
 *
 * The Redis vector plumbing (index, upsert, KNN, payload encoding) lives in the
 * shared `vector-store.server.ts` — this module owns the document-specific
 * policy: chunking, embedding, and the one-model-per-corpus guard.
 *
 * ── One embedding space per session corpus ────────────────────────────────
 * Vectors are only comparable within one model. The vector store's index name
 * AND key prefix both encode the embedding space (`provider_model_dim`), so a
 * chunk embedded with model A can never land in model B's index. The session's
 * space is recorded at `stash:space:{sessionId}`; re-ingesting with a different
 * model throws (unless `allowSpaceChange`), and queries are always embedded with
 * the recorded model — so a search can never compare across spaces.
 *
 * Redis + embedding are injectable so the orchestrator is unit-testable without
 * a live gateway or model server.
 */

import { assertServerOnImport } from './harness-patterns/assert.server'
import { stashCallTool } from './redis-direct.server'
import {
  DEFAULT_TTL_SECONDS,
  getDocument,
  listDocuments,
  setDocumentFlags,
  type CallTool,
  type StashDocument,
} from './document-store.server'
import { chunkDocument, type Chunk, type ChunkConfig } from './chunking.server'
import {
  conversionEnabled,
  convertToMarkdown,
  isConvertible,
  MARKDOWN_MIME,
} from './doc-convert.server'
import {
  embed as defaultEmbed,
  embedOne as defaultEmbedOne,
  assertSameSpace,
  type EmbeddingConfig,
  type EmbeddingResult,
  type EmbeddingSpace,
  type SingleEmbeddingResult,
} from './embeddings.server'
import { createVectorStore, sanitize, spaceTag } from './vector-store.server'

assertServerOnImport()

// ============================================================================
// Types
// ============================================================================

export interface IngestOptions {
  chunk?: Partial<ChunkConfig>
  embedding?: EmbeddingConfig
  ttlSeconds?: number
  /** Allow re-ingesting a session under a different embedding space (splits the
   *  corpus — off by default to preserve comparability). */
  allowSpaceChange?: boolean
  callTool?: CallTool
  embedFn?: (texts: string[], config?: EmbeddingConfig) => Promise<EmbeddingResult>
  /** Binary→markdown converter (injectable for tests, mirroring embedFn).
   *  Defaults to the doc-convert sidecar client. Called only for convertible
   *  base64 docs before chunking. */
  convertFn?: (base64Content: string, filename: string, mimeType: string) => Promise<string>
}

export interface IngestResult {
  docId: string
  sessionId: string
  chunks: number
  space: EmbeddingSpace
  indexName: string
  prefix: string
}

export interface SearchHit {
  docId: string
  source: string
  chunkIndex: number
  content: string
  startOffset?: number
  endOffset?: number
  /** Vector distance (lower = closer) when the backend reports one. */
  score?: number
}

export interface SearchOptions {
  k?: number
  /** Embedding override; provider/model are forced to the recorded space. */
  embedding?: EmbeddingConfig
  callTool?: CallTool
  embedOneFn?: (text: string, config?: EmbeddingConfig) => Promise<SingleEmbeddingResult>
}

// ============================================================================
// Naming (the space is baked into both the index name and the key prefix)
// ============================================================================

const SPACE_KEY_PREFIX = 'stash:space'

export function indexNameFor(sessionId: string, space: EmbeddingSpace): string {
  return `stash_idx_${sanitize(sessionId)}_${spaceTag(space)}`
}

export function prefixFor(sessionId: string, space: EmbeddingSpace): string {
  return `stashvec:${sessionId}:${spaceTag(space)}:`
}

function spaceKey(sessionId: string): string {
  return `${SPACE_KEY_PREFIX}:${sessionId}`
}

// ============================================================================
// Embedding-space bookkeeping
// ============================================================================

/** Read the embedding space a session's corpus was built with, if any. */
export async function getEmbeddingSpace(
  sessionId: string,
  callTool: CallTool = stashCallTool(),
): Promise<EmbeddingSpace | null> {
  const res = await callTool('json_get', { name: spaceKey(sessionId), path: '$' })
  if (!res.success || res.data == null) return null
  let value: unknown = res.data
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (Array.isArray(value)) value = value[0]
  if (value == null || typeof value !== 'object') return null
  const s = value as Partial<EmbeddingSpace>
  if (!s.provider || !s.model || typeof s.dimensions !== 'number') return null
  return { provider: s.provider, model: s.model, dimensions: s.dimensions }
}

async function recordSpace(
  callTool: CallTool,
  sessionId: string,
  space: EmbeddingSpace,
  ttl: number,
): Promise<void> {
  await callTool('json_set', {
    name: spaceKey(sessionId),
    path: '$',
    value: JSON.stringify(space),
    expire_seconds: ttl,
  })
}

// ============================================================================
// Ingest
// ============================================================================

/**
 * Chunk → embed → index a stored document into the vector store for search.
 *
 * @throws if the session already has a different embedding space (and
 *         `allowSpaceChange` is not set), or if Redis writes fail.
 */
export async function ingestDocument(
  doc: StashDocument,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const callTool = opts.callTool ?? stashCallTool()
  const embedFn = opts.embedFn ?? defaultEmbed
  const ttl = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS

  const chunks: Chunk[] = chunkDocument(doc.content, doc.mimeType, opts.chunk)
  const { vectors, ...space } = await embedFn(
    chunks.map((c) => c.content),
    opts.embedding,
  )

  // Enforce one model per session corpus.
  const existing = await getEmbeddingSpace(doc.sessionId, callTool)
  if (existing && !opts.allowSpaceChange) {
    assertSameSpace(existing, space)
  }

  const indexName = indexNameFor(doc.sessionId, space)
  const prefix = prefixFor(doc.sessionId, space)
  const store = createVectorStore({ indexName, prefix, dim: space.dimensions, callTool })
  await store.ensureIndex()

  // Sequential: the gateway runs the redis MCP over one serial stdio pipe, so
  // concurrent writes only queue and time out. Each chunk is 2 Redis calls.
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]
    await store.upsert(
      `${doc.id}:${c.index}`,
      vectors[i],
      {
        content: c.content,
        doc_id: doc.id,
        session_id: doc.sessionId,
        source: doc.filename,
        chunk_index: c.index,
        start_offset: c.startOffset,
        end_offset: c.endOffset,
        model: space.model,
        provider: space.provider,
        dim: space.dimensions,
      },
      ttl,
    )
  }

  await recordSpace(callTool, doc.sessionId, space, ttl)

  return {
    docId: doc.id,
    sessionId: doc.sessionId,
    chunks: chunks.length,
    space,
    indexName,
    prefix,
  }
}

// ============================================================================
// Status-tracked ingest (harness-aware Data Stash)
// ============================================================================

/**
 * Fetch a stored document and ingest it, recording the outcome as the doc's
 * {@link StashDocument.ingestStatus}. The status-aware wrapper around
 * {@link ingestDocument} used by the auto-ingest-on-upload gate and the
 * retriever's lazy safety net:
 *
 *  - missing doc            → `null` (nothing to do)
 *  - `base64` binary        → converted to markdown first when it's a
 *                             convertible type (docx/pdf/pptx/odt) and
 *                             conversion is enabled; otherwise status `'failed'`
 *                             (the text pipeline can't chunk it — don't retry)
 *  - convert/ingest throws  → status `'failed'`, returns `null`
 *  - ingest ok              → status `'indexed'`, returns the {@link IngestResult}
 *
 * Best-effort by contract: it never throws (failures live in the status field),
 * so callers on the upload hot path don't need their own try/catch.
 */
export async function ingestStashDocument(
  sessionId: string,
  docId: string,
  opts: IngestOptions = {},
): Promise<IngestResult | null> {
  const callTool = opts.callTool ?? stashCallTool()
  const doc = await getDocument(sessionId, docId, callTool)
  if (!doc) return null

  // Binary docs are only ingestable if we can convert them to text. A
  // convertible type (docx/pdf/pptx/odt) with conversion enabled is handled in
  // the try below; any other base64 is marked failed so we don't retry forever.
  const needsConversion = doc.encoding === 'base64'
  if (needsConversion && !(conversionEnabled() && isConvertible(doc.mimeType))) {
    await setDocumentFlags(sessionId, docId, { ingestStatus: 'failed' }, callTool)
    return null
  }

  // Mark 'pending' up front so the panel shows "embedding…" while we
  // convert/embed (both slow). The upload-gate path already persisted 'pending'
  // in the store write, so skip the redundant round-trip there — re-writing the
  // same value only burns a gateway call and a list-cache invalidation.
  if (doc.ingestStatus !== 'pending') {
    await setDocumentFlags(sessionId, docId, { ingestStatus: 'pending' }, callTool)
  }
  try {
    let ingestDoc = doc
    if (needsConversion) {
      // docx/pdf/… → markdown. Persist the derived text so the file viewer and
      // chat citations can render it (chunk offsets index into this markdown,
      // not the base64 original — which stays in `content` for downloads). Then
      // feed an in-memory text doc to the unchanged `ingestDocument`.
      const convertFn = opts.convertFn ?? convertToMarkdown
      const markdown = await convertFn(doc.content, doc.filename, doc.mimeType)
      await setDocumentFlags(sessionId, docId, { derivedText: markdown }, callTool)
      ingestDoc = { ...doc, content: markdown, mimeType: MARKDOWN_MIME, encoding: undefined }
    }
    const result = await ingestDocument(ingestDoc, opts)
    await setDocumentFlags(sessionId, docId, { ingestStatus: 'indexed' }, callTool)
    return result
  } catch {
    await setDocumentFlags(sessionId, docId, { ingestStatus: 'failed' }, callTool)
    return null
  }
}

/**
 * Idempotently ingest every not-yet-indexed document in a session. The
 * retriever's safety net: an upload that happened before the agent was known (so
 * the upload-time gate couldn't fire), or one whose ingest failed transiently
 * (embedder offline at upload time), becomes searchable on first retrieval.
 *
 * Ingests only what the upload-time gate can't or didn't handle:
 *  - `'failed'` — retried (usually a transient embedder-down at upload time);
 *  - absent (no status) — the gate never fired (e.g. uploaded before the
 *    session was persisted).
 * Skips `'indexed'` (searchable), `'pending'` (the gate is actively ingesting
 * it — re-ingesting would double the work and contend on the serial gateway),
 * and non-convertible `base64` binaries. A fully-indexed corpus costs
 * just one `listDocuments`.
 */
export async function ensureSessionIngested(
  sessionId: string,
  opts: IngestOptions = {},
): Promise<void> {
  const callTool = opts.callTool ?? stashCallTool()
  const metas = await listDocuments(sessionId, callTool)
  for (const m of metas) {
    if (m.ingestStatus === 'indexed' || m.ingestStatus === 'pending') continue
    // Skip binaries we can't turn into text; convertible ones (with conversion
    // enabled) fall through to ingestStashDocument, which converts them.
    if (m.encoding === 'base64' && !(conversionEnabled() && isConvertible(m.mimeType))) continue
    await ingestStashDocument(sessionId, m.id, opts)
  }
}

// ============================================================================
// Search
// ============================================================================

/**
 * Embed `query` with the session's recorded model and KNN-search its index.
 * Returns [] when the session has no ingested corpus yet. The query is always
 * embedded with the *recorded* provider/model, and {@link assertSameSpace}
 * re-checks dimensionality — a search can never compare across embedding spaces.
 */
export async function searchDocuments(
  sessionId: string,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  const callTool = opts.callTool ?? stashCallTool()
  const embedOneFn = opts.embedOneFn ?? defaultEmbedOne

  const recorded = await getEmbeddingSpace(sessionId, callTool)
  if (!recorded) return []

  const q = await embedOneFn(query, {
    ...opts.embedding,
    provider: recorded.provider,
    model: recorded.model,
    dimensions: recorded.dimensions,
  })
  assertSameSpace(recorded, { provider: q.provider, model: q.model, dimensions: q.dimensions })

  const store = createVectorStore({
    indexName: indexNameFor(sessionId, recorded),
    prefix: prefixFor(sessionId, recorded),
    dim: recorded.dimensions,
    callTool,
  })
  const hits = await store.search(q.vector, opts.k ?? 5)

  const out: SearchHit[] = []
  for (const h of hits) {
    const content = str(h.payload.content)
    if (content == null) continue
    out.push({
      docId: str(h.payload.doc_id) ?? '',
      source: str(h.payload.source) ?? '',
      chunkIndex: num(h.payload.chunk_index) ?? 0,
      content,
      startOffset: num(h.payload.start_offset),
      endOffset: num(h.payload.end_offset),
      score: h.score,
    })
  }
  return out
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined
}
function num(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}
