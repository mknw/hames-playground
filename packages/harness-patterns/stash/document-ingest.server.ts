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

import { assertServerOnImport } from '../assert.server'
import { resolveStashCallTool } from '../stash-transport.server'
import {
  DEFAULT_TTL_SECONDS,
  deleteDocument,
  getDocument,
  getDocumentStrict,
  listDocuments,
  listSessionDocumentIds,
  parseKeyList,
  redisWriteError,
  sessionDocKeyPrefix,
  setDocumentFlags,
  type CallTool,
  type IngestStatus,
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
  provenance?: StashDocument['provenance']
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

/** Read the embedding space a session's corpus was built with, if any.
 *
 *  `null` covers both "this session has no ingested corpus" and "the store
 *  could not be read". The two are indistinguishable in the return value for
 *  compatibility with every existing caller, so the second one is LOGGED —
 *  otherwise a Redis outage reaches the user as the sentence "no matching
 *  documents", which is a statement about their corpus rather than about the
 *  store (sf-H2). {@link searchDocuments} adds the same distinction to its own
 *  "no matches" answer. */
export async function getEmbeddingSpace(
  sessionId: string,
  callTool: CallTool = resolveStashCallTool(),
): Promise<EmbeddingSpace | null> {
  const res = await callTool('json_get', { name: spaceKey(sessionId), path: '$' })
  if (!res.success) {
    console.warn(
      `[ingest] could not read the embedding space for session ${sessionId} ` +
        `(${res.error ?? 'unknown error'}) — treated as "no corpus".`,
    )
    return null
  }
  if (res.data == null) return null
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
  const callTool = opts.callTool ?? resolveStashCallTool()
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
        ...(doc.provenance ? { provenance: doc.provenance } : {}),
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
// Clear a session's stash
// ============================================================================

/** Escape Redis glob metacharacters so a session id matches only itself. */
function escapeGlob(s: string): string {
  return s.replace(/[\\*?[\]]/g, '\\$&')
}

/** Chunk keys are `stashvec:{session}:{space}:{docId}:{n}`; after the session
 *  prefix exactly three `:`-free parts remain. A longer remainder belongs to a
 *  session whose id merely starts with this one, and is never ours to delete. */
const CHUNK_REMAINDER = /^[^:]+:[^:]+:\d+$/

/** Document keys are `stash:doc:{session}:{docId}`; after the session prefix
 *  exactly one `:`-free part remains. Same prefix-safety as {@link CHUNK_REMAINDER}. */
const DOC_REMAINDER = /^[^:]+$/

/**
 * Remove everything a session holds in the stash: each indexed document (via
 * {@link deleteDocument}, which also drops its index entry), any document key
 * the index no longer lists, every chunk record, and the recorded embedding
 * space. Idempotent, and attempts every
 * step before reporting: a failure partway still deletes whatever it can.
 *
 * @throws one error naming each step that failed (after all were attempted).
 */
export async function deleteSessionStash(
  sessionId: string,
  callTool: CallTool = resolveStashCallTool(),
): Promise<void> {
  const failures: string[] = []
  const attempt = async (what: string, run: () => Promise<void>) => {
    try {
      await run()
    } catch (err) {
      failures.push(`${what}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const dropKey = async (key: string) => {
    const err = redisWriteError(await callTool('delete', { key }))
    if (err) throw new Error(err)
  }
  const scanKeys = async (pattern: string): Promise<string[]> => {
    const scan = await callTool('scan_all_keys', { pattern, batch_size: 500 })
    if (!scan.success) throw new Error(scan.error ?? 'scan failed')
    return parseKeyList(scan.data)
  }

  await attempt('documents', async () => {
    for (const id of await listSessionDocumentIds(sessionId, callTool)) {
      await attempt(`document ${id}`, () => deleteDocument(sessionId, id, callTool))
    }
  })

  // Documents whose index entry is already gone (a half-finished delete, a
  // failed index write after the store) are invisible to the index read above,
  // so the keyspace is scanned for them too.
  const docPrefix = sessionDocKeyPrefix(sessionId)
  await attempt('unindexed documents', async () => {
    for (const key of await scanKeys(`${escapeGlob(docPrefix)}*`)) {
      if (!key.startsWith(docPrefix) || !DOC_REMAINDER.test(key.slice(docPrefix.length))) continue
      await attempt(`document ${key}`, () => dropKey(key))
    }
  })

  const chunkPrefix = `stashvec:${sessionId}:`
  await attempt('chunks', async () => {
    for (const key of await scanKeys(`stashvec:${escapeGlob(sessionId)}:*`)) {
      if (!key.startsWith(chunkPrefix) || !CHUNK_REMAINDER.test(key.slice(chunkPrefix.length))) {
        continue
      }
      await attempt(`chunk ${key}`, () => dropKey(key))
    }
  })

  await attempt('embedding space', () => dropKey(spaceKey(sessionId)))

  if (failures.length > 0) {
    throw new Error(`Failed to clear the stash of session ${sessionId}: ${failures.join('; ')}`)
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
 * so callers on the upload hot path don't need their own try/catch. "Never
 * throws" is enforced here rather than assumed — the status writes are Redis
 * writes and `setDocumentFlags` throws on a rejected one, which used to escape
 * this function and abort `ensureSessionIngested`'s whole loop (sf-H2).
 *
 * The REASON a document failed is logged AND recorded on the document as
 * `ingestError` (#420). It used to be discarded entirely, so an embedder outage
 * and an unchunkable file were indistinguishable — the panel said 'failed' and
 * nothing anywhere said why; then it reached the log only, which is where #420
 * found it after the tool that stored the file had already reported success.
 */
export async function ingestStashDocument(
  sessionId: string,
  docId: string,
  opts: IngestOptions = {},
): Promise<IngestResult | null> {
  const callTool = opts.callTool ?? resolveStashCallTool()
  const doc = await getDocument(sessionId, docId, callTool)
  if (!doc) return null

  // Binary docs are only ingestable if we can convert them to text. A
  // convertible type (docx/pdf/pptx/odt) with conversion enabled is handled in
  // the try below; any other base64 is marked failed so we don't retry forever.
  const needsConversion = doc.encoding === 'base64'
  if (needsConversion && !(conversionEnabled() && isConvertible(doc.mimeType))) {
    await markIngestStatus(
      sessionId,
      docId,
      'failed',
      callTool,
      isConvertible(doc.mimeType)
        ? 'Document conversion is not enabled on this server, so this file has no text to index.'
        : `${doc.mimeType} has no text conversion, so this file cannot be indexed.`,
    )
    return null
  }

  // Mark 'pending' up front so the panel shows "embedding…" while we
  // convert/embed (both slow). The upload-gate path already persisted 'pending'
  // in the store write, so skip the redundant round-trip there — re-writing the
  // same value only burns a gateway call and a list-cache invalidation.
  if (doc.ingestStatus !== 'pending') {
    await markIngestStatus(sessionId, docId, 'pending', callTool)
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
    await markIngestStatus(sessionId, docId, 'indexed', callTool)
    return result
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.error(`[ingest] ${doc.filename} (${docId}) failed for session ${sessionId}:`, reason)
    await markIngestStatus(sessionId, docId, 'failed', callTool, reason)
    return null
  }
}

/** Ceiling on a recorded failure reason. It is shown in a tooltip and handed to
 *  a model in a tool result, and an upstream error body has no length bound. */
const MAX_INGEST_ERROR_CHARS = 500

/**
 * Write an ingest status without letting the write itself break the caller.
 *
 * `setDocumentFlags` throws when Redis rejects the write, and every call site
 * above is on the "best-effort, never throws" path — including the one inside
 * the failure handler, where a throw would replace the real ingest error with a
 * Redis one AND propagate out of a function documented not to throw. The status
 * is a progress indicator; losing it must not cost the ingest run (sf-H2).
 */
async function markIngestStatus(
  sessionId: string,
  docId: string,
  ingestStatus: IngestStatus,
  callTool: CallTool,
  reason?: string,
): Promise<void> {
  // A failure records its reason; any other status clears the previous one, so
  // a retry that is under way or succeeded never shows a stale failure.
  const ingestError =
    ingestStatus === 'failed' ? (reason ?? 'unknown error').slice(0, MAX_INGEST_ERROR_CHARS) : null
  try {
    await setDocumentFlags(sessionId, docId, { ingestStatus, ingestError }, callTool)
  } catch (err) {
    console.warn(
      `[ingest] could not persist ingestStatus='${ingestStatus}' for ${docId}:`,
      err instanceof Error ? err.message : err,
    )
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
 *
 * Also skips documents the user hid or archived: those are excluded from the
 * agent's context, so there is nothing to make searchable. They are picked up by
 * a later run once un-hidden (their status is still absent or `'failed'`).
 */
export async function ensureSessionIngested(
  sessionId: string,
  opts: IngestOptions = {},
): Promise<void> {
  const callTool = opts.callTool ?? resolveStashCallTool()
  const metas = await listDocuments(sessionId, callTool)
  for (const m of metas) {
    if (m.hidden || m.archived) continue
    if (m.ingestStatus === 'indexed' || m.ingestStatus === 'pending') continue
    // Skip binaries we can't turn into text; convertible ones (with conversion
    // enabled) fall through to ingestStashDocument, which converts them.
    if (m.encoding === 'base64' && !(conversionEnabled() && isConvertible(m.mimeType))) continue
    // `ingestStashDocument` is documented not to throw, and now enforces that
    // for its own status writes — but this loop is the safety net for a whole
    // corpus and must not lose documents 3..N to an unexpected throw on
    // document 2 (sf-H2). Per-document isolation, loudly.
    try {
      await ingestStashDocument(sessionId, m.id, opts)
    } catch (err) {
      console.error(
        `[ingest] safety-net ingest of ${m.filename} (${m.id}) threw; continuing with the rest:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
}

// ============================================================================
// Search
// ============================================================================

/** Most chunks one search will ask the index for while looking past hits that are
 *  filtered out (see {@link searchDocuments}). */
const MAX_SEARCH_SPAN = 200

/**
 * Whether a document may reach the agent's context: neither hidden nor archived,
 * judged by its CURRENT flags. The flags are read from the stored document
 * rather than from the cached {@link listDocuments} result or from the chunk's
 * own payload, because both can be older than the user's last hide/archive.
 *
 * Fails closed: a document whose flags cannot be read (or a chunk that names no
 * document) is treated as not visible, and the reason is logged. A document
 * that is simply absent has no flags to honour, so it is not filtered here.
 */
async function isDocumentVisible(
  sessionId: string,
  docId: string,
  callTool: CallTool,
): Promise<boolean> {
  if (!docId) {
    console.warn(
      `[ingest] dropped a search hit with no document id for session ${sessionId} ` +
        '— its hidden/archived flags cannot be checked.',
    )
    return false
  }
  try {
    const doc = await getDocumentStrict(sessionId, docId, callTool)
    return !(doc?.hidden || doc?.archived)
  } catch (err) {
    console.warn(
      `[ingest] dropped search hits of document ${docId} for session ${sessionId}: ` +
        `its hidden/archived flags could not be read (${err instanceof Error ? err.message : String(err)}).`,
    )
    return false
  }
}

/**
 * Embed `query` with the session's recorded model and KNN-search its index.
 * Returns [] when the session has no ingested corpus yet. The query is always
 * embedded with the *recorded* provider/model, and {@link assertSameSpace}
 * re-checks dimensionality — a search can never compare across embedding spaces.
 *
 * Hits of hidden or archived documents are dropped (see {@link isDocumentVisible}):
 * hiding a document does not remove its chunks from the index, so the flags are
 * honoured here, at search time, which is also what makes un-hiding instant.
 * Since filtered hits would otherwise shrink the answer below `k` while visible
 * matches remain, the index is asked for a wider span (up to a bound) until `k` visible hits
 * are found or it runs out.
 */
export async function searchDocuments(
  sessionId: string,
  query: string,
  opts: SearchOptions = {},
): Promise<SearchHit[]> {
  const callTool = opts.callTool ?? resolveStashCallTool()
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

  const k = opts.k ?? 5
  // One flag read per document per search, however many spans are tried.
  const visibility = new Map<string, Promise<boolean>>()
  const visible = (docId: string) => {
    let v = visibility.get(docId)
    if (!v) visibility.set(docId, (v = isDocumentVisible(sessionId, docId, callTool)))
    return v
  }

  let span = k
  for (;;) {
    const hits = await store.search(q.vector, span)

    const out: SearchHit[] = []
    for (const h of hits) {
      const content = str(h.payload.content)
      if (content == null) continue
      const docId = str(h.payload.doc_id) ?? ''
      if (!(await visible(docId))) continue
      out.push({
        docId,
        ...(h.payload.provenance === 'sandbox-output'
          ? { provenance: 'sandbox-output' as const }
          : {}),
        source: str(h.payload.source) ?? '',
        chunkIndex: num(h.payload.chunk_index) ?? 0,
        content,
        startOffset: num(h.payload.start_offset),
        endOffset: num(h.payload.end_offset),
        score: h.score,
      })
      if (out.length >= k) break
    }

    if (out.length >= k || hits.length < span || span >= MAX_SEARCH_SPAN) return out
    span = Math.min(span * 2, MAX_SEARCH_SPAN)
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined
}
function num(v: unknown): number | undefined {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return undefined
}
