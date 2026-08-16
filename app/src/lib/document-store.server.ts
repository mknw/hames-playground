/**
 * Document Store — Server Only (Issue #6)
 *
 * Redis-backed persistence for user-uploaded Data Stash documents.
 *
 * Documents live alongside tool results in the Data Stash and are referenced
 * by the agent across turns via the same `ref:<id>` mechanism (see
 * `simpleLoop.server.ts` → `PriorResult` / `resolveRefs`). This module owns
 * only the *storage* layer: write/read/list/delete a document and toggle its
 * stash flags. Chunking (#9) and embedding (#8) build on top of the returned
 * `StashDocument` shape — they never re-implement Redis access.
 *
 * Storage layout (RedisJSON, one document per key):
 *
 *   stash:doc:{sessionId}:{docId}   →  JSON blob (StashDocument)
 *   stash:docs:{sessionId}          →  SET of docIds for the session (index)
 *
 * Each document key carries a configurable TTL via `expire` so stale uploads
 * don't accumulate. The index set is refreshed with the same TTL on every
 * write so a fully-expired session leaves no dangling index.
 *
 * Redis is reached through the MCP Gateway's `callTool`. The MCP tool param
 * quirks (see CLAUDE.md → "Redis MCP Tool Parameters") are encapsulated here:
 *   - json_set / json_get: `name` is the Redis key, `path` the JSON path
 *   - expire:              `name` + `expire_seconds`
 *   - sadd / smembers / srem: `name` is the SET key
 *   - delete:              `key` (note: not `name`)
 */

import { assertServerOnImport } from './harness-patterns/assert.server'
import { stashCallTool, directCallTool, gatewayCallTool } from './redis-direct.server'
import type { ToolCallResult } from './harness-patterns/types'
import type { PriorResult } from '../../baml_client/types'

assertServerOnImport()

// ============================================================================
// Types — the public contract chunking (#9) and embedding (#8) consume
// ============================================================================

/** Metadata stored alongside the document content. */
export interface StashDocumentMeta {
  /** Stable per-session document id (also the `ref:<id>` target). */
  id: string
  /** Session that owns this document. */
  sessionId: string
  /** Original filename as uploaded. */
  filename: string
  /** MIME type, e.g. `text/plain`, `application/json`, `text/csv`. */
  mimeType: string
  /** Content size in bytes (UTF-8). */
  size: number
  /** Upload timestamp (epoch ms). */
  uploadedAt: number
  /** Hidden from LLM context (mirrors tool-result stash semantics). */
  hidden?: boolean
  /** Moved to the Archived section (also excluded from LLM context). */
  archived?: boolean
  /**
   * Content encoding. `'utf8'` (default, omitted) → `content` is literal text.
   * `'base64'` → `content` is base64 of the original binary bytes (xlsx, pdf,
   * images); decode before use. `size` is always the ORIGINAL byte count.
   * Added for the sandbox `/work` round-trip (#89) — binary deliverables need
   * byte-faithful storage, which the text-only upload path could not provide.
   */
  encoding?: 'utf8' | 'base64'
  /**
   * Vector-ingestion status (chunk→embed→index into the local Data Stash vector
   * store). Set by the harness-aware auto-ingest path: `'pending'` queued/in
   * progress, `'indexed'` searchable, `'failed'` ingest errored (e.g. embedder
   * offline). Absent → never ingested (no redis-retriever in the harness).
   */
  ingestStatus?: IngestStatus
  /**
   * True when a text derivation exists (see {@link StashDocument.derivedText}) —
   * a binary upload (docx/pdf/pptx/odt) converted to markdown for ingest.
   * Meta-only convenience flag, computed from `derivedText` presence in
   * {@link stripContent} (never stored separately). The panel uses it to offer
   * the file viewer on converted binaries whose `encoding` is still `'base64'`.
   */
  converted?: boolean
}

export type IngestStatus = 'pending' | 'indexed' | 'failed'

/** A stored document: metadata + its (already text-extracted) content. */
export interface StashDocument extends StashDocumentMeta {
  /**
   * Text content of the document. Upstream callers (the upload route) are
   * responsible for extracting text from binary formats (PDF, etc.) before
   * storing — this layer treats `content` as opaque UTF-8 text.
   */
  content: string
  /**
   * Markdown derived from a binary `content` (docx/pdf/pptx/odt) by the ingest
   * converter (xberg sidecar). Present only on converted binaries; `content`
   * still holds the original base64 bytes (so `?download` and the `/work` sync
   * serve the real file). This is the text that gets chunked/embedded and shown
   * in the file viewer — chunk char-offsets index into THIS, not `content`.
   */
  derivedText?: string
}

/** Input for {@link storeDocument}. `id` and `uploadedAt` are minted here. */
export interface StoreDocumentInput {
  sessionId: string
  filename: string
  mimeType: string
  content: string
  /** Override the generated id (e.g. for deterministic tests). */
  id?: string
  /** TTL override in seconds; falls back to {@link DEFAULT_TTL_SECONDS}. */
  ttlSeconds?: number
  /**
   * Content encoding; defaults to `'utf8'`. Set `'base64'` when `content` is
   * base64-encoded binary (the size limit then applies to the decoded bytes).
   */
  encoding?: 'utf8' | 'base64'
  /**
   * Initial vector-ingestion status, persisted in the SAME first write. The
   * upload route sets `'pending'` here when it will auto-ingest, so Redis
   * reflects "embedding…" from t=0 — otherwise a status poll landing before the
   * background ingest's own `setDocumentFlags('pending')` reads no status and
   * the UI flickers (chip blanks, composer un-blocks). Absent → not ingested.
   */
  ingestStatus?: IngestStatus
}

// ============================================================================
// Configuration
// ============================================================================

/** Default document TTL: 7 days. Keeps uploads around across a working
 *  session without letting them accumulate forever. */
export const DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60

/**
 * Maximum stored content size (bytes). Redis values can be far larger, but
 * uploads beyond this are rejected here to protect the LLM context budget —
 * the chunking/embedding pipeline (#9/#8) is the path for large documents, not
 * full inlining. Callers can raise this per-call once that pipeline lands.
 */
export const MAX_CONTENT_BYTES = 5 * 1024 * 1024 // 5 MiB

const DOC_KEY_PREFIX = 'stash:doc'
const INDEX_KEY_PREFIX = 'stash:docs'

/** A `callTool`-shaped function. Injectable so the store is unit-testable
 *  without a live MCP gateway (tests pass a stub; prod uses the MCP client). */
export type CallTool = (
  name: string,
  args: Record<string, unknown>,
) => Promise<ToolCallResult>

// ============================================================================
// Key helpers
// ============================================================================

function docKey(sessionId: string, docId: string): string {
  return `${DOC_KEY_PREFIX}:${sessionId}:${docId}`
}

function indexKey(sessionId: string): string {
  return `${INDEX_KEY_PREFIX}:${sessionId}`
}

function newDocId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // Fallback for non-secure contexts (mirrors session-id.ts rationale).
  return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function byteLength(str: string): number {
  return typeof Buffer !== 'undefined'
    ? Buffer.byteLength(str, 'utf8')
    : new TextEncoder().encode(str).length
}

/** Decoded byte count of a base64 string (server-only — Buffer always present;
 *  whitespace-tolerant fallback otherwise). Used so the size limit and stored
 *  `size` reflect the ORIGINAL bytes, not the ≈33%-larger base64 string. */
function base64ByteLength(b64: string): number {
  if (typeof Buffer !== 'undefined') return Buffer.from(b64, 'base64').length
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '')
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding)
}

/**
 * Coerce a `smembers` result into a string[] of ids. The Redis MCP may hand the
 * set back as a real array, a JSON string (`'["a","b"]'`), a double-encoded
 * string, or wrapped in `{ result: [...] }` — only some of which survive
 * `callTool`'s single JSON.parse. `getDocument` already tolerates this for
 * RedisJSON via {@link unwrapJsonGet}; `listDocuments` needs the same robustness
 * (a strict `Array.isArray` check silently dropped every uploaded doc against
 * the live gateway).
 */
function parseSetMembers(data: unknown): string[] {
  let value: unknown = data
  // Unwrap up to a couple layers of JSON-string encoding. A bare, non-JSON
  // scalar is a single set member returned as one text block (the live MCP
  // returns one text block per member, so callTool yields a string for a
  // 1-member set and an array for N members).
  for (let i = 0; i < 3 && typeof value === 'string'; i++) {
    const s = value.trim()
    if (!s) return []
    if (!/^[[{"]/.test(s)) return [s]
    try {
      value = JSON.parse(s)
    } catch {
      return [s]
    }
  }
  // Some MCP shapes wrap the array in an object.
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>
    let inner = obj.result ?? obj.members ?? obj.data
    if (typeof inner === 'string') {
      try {
        inner = JSON.parse(inner)
      } catch {
        /* leave as-is */
      }
    }
    value = inner
  }
  if (Array.isArray(value)) {
    return value.filter((m): m is string => typeof m === 'string')
  }
  return typeof value === 'string' && value.trim() ? [value.trim()] : []
}

/**
 * RedisJSON returns the value at `$` wrapped in a single-element array
 * (`["...stringified..."]` or `[{...}]`), and the MCP layer may hand it back
 * either parsed or as a JSON string. Normalise to the contained value.
 */
function unwrapJsonGet(data: unknown): unknown {
  let value: unknown = data
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return undefined
    }
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value[0] : undefined
  }
  return value
}

/**
 * The Redis MCP server reports some command-level failures (auth errors,
 * WRONGTYPE, misconfiguration) as a *normal text payload* with `success: true`
 * — the MCP transport succeeded, but the Redis command did not. The shared
 * `callTool` only demotes `"<Name> Error:"`-prefixed strings, so a write that
 * actually failed otherwise looks like a stored document. Detect that shape on
 * writes so a failed write surfaces instead of silently "succeeding".
 *
 * Returns the error text when the result indicates a Redis-level failure, else
 * null. Conservative on success payloads: a RedisJSON SET returns `"OK"`, SADD
 * returns a count — neither matches these patterns.
 */
export function redisWriteError(result: ToolCallResult): string | null {
  if (!result.success) return result.error ?? 'unknown error'
  const candidates: unknown[] = [result.data]
  if (result.data && typeof result.data === 'object' && 'result' in result.data) {
    candidates.push((result.data as { result?: unknown }).result)
  }
  for (const c of candidates) {
    if (typeof c === 'string' && (/^error\b/i.test(c.trim()) || /\b(NO)?AUTH\b/.test(c) || /WRONGTYPE|misconfigur/i.test(c))) {
      return c
    }
  }
  return null
}

// ============================================================================
// Store
// ============================================================================

/**
 * Persist an uploaded document in Redis and register it in the session index.
 * Returns the stored document (with its minted `id` and `uploadedAt`).
 *
 * @throws if the content exceeds {@link MAX_CONTENT_BYTES} or Redis rejects
 *         the write — callers surface this as a 4xx/5xx on the upload route.
 */
export async function storeDocument(
  input: StoreDocumentInput,
  callTool: CallTool = stashCallTool(),
): Promise<StashDocument> {
  const encoding = input.encoding ?? 'utf8'
  // `size` is the ORIGINAL byte count: for base64 that's the decoded length
  // (the limit applies to the real file, not the larger encoded string).
  const size =
    encoding === 'base64' ? base64ByteLength(input.content) : byteLength(input.content)
  if (size > MAX_CONTENT_BYTES) {
    throw new Error(
      `Document too large: ${size} bytes exceeds limit of ${MAX_CONTENT_BYTES} bytes`,
    )
  }

  const doc: StashDocument = {
    id: input.id ?? newDocId(),
    sessionId: input.sessionId,
    filename: input.filename,
    mimeType: input.mimeType,
    size,
    uploadedAt: Date.now(),
    content: input.content,
    // Omit when utf8 so existing docs/tests stay byte-identical.
    ...(encoding === 'base64' ? { encoding } : {}),
    // Persist the initial ingest status in this first write (no separate
    // setDocumentFlags round-trip), so a poll can never read a status gap.
    ...(input.ingestStatus ? { ingestStatus: input.ingestStatus } : {}),
  }

  const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS
  const key = docKey(doc.sessionId, doc.id)

  const set = await callTool('json_set', {
    name: key,
    path: '$',
    value: JSON.stringify(doc),
    expire_seconds: ttl,
  })
  const setErr = redisWriteError(set)
  if (setErr) {
    throw new Error(`Failed to store document: ${setErr}`)
  }

  // Register in the per-session index, refreshing its TTL to outlive the docs.
  const idx = await callTool('sadd', {
    name: indexKey(doc.sessionId),
    value: doc.id,
    expire_seconds: ttl,
  })
  const idxErr = redisWriteError(idx)
  if (idxErr) {
    throw new Error(`Failed to index document: ${idxErr}`)
  }

  invalidateDocumentList(doc.sessionId)
  return doc
}

// ============================================================================
// Read
// ============================================================================

/** Retrieve a full document (content + metadata), or null if absent/expired. */
export async function getDocument(
  sessionId: string,
  docId: string,
  callTool: CallTool = stashCallTool(),
): Promise<StashDocument | null> {
  const res = await callTool('json_get', {
    name: docKey(sessionId, docId),
    path: '$',
  })
  if (!res.success || res.data == null) return null

  const value = unwrapJsonGet(res.data)
  if (value == null || typeof value !== 'object') return null
  return value as StashDocument
}

/** Retrieve a document's metadata without its content. */
export async function getDocumentMeta(
  sessionId: string,
  docId: string,
  callTool: CallTool = stashCallTool(),
): Promise<StashDocumentMeta | null> {
  const doc = await getDocument(sessionId, docId, callTool)
  if (!doc) return null
  return stripContent(doc)
}

// ── listDocuments cache ──────────────────────────────────────────────────
// listDocuments is `smembers` + one `json_get` per doc, all serial on the MCP
// gateway (~1.6s/call) → 12-21s for a handful of docs. The panel refetches it
// (mount, status polls), so without a cache every refresh re-pays that. Cache
// the result per session in-process; invalidate on any write. Only cache reads
// that use the real gateway client — tests inject a fake `callTool` and must not
// share state across cases.
interface ListCacheEntry {
  docs: StashDocumentMeta[]
  at: number
}
const listCache = new Map<string, ListCacheEntry>()
const LIST_CACHE_TTL_MS = 30_000

/** Drop a session's cached document list (call after any write). */
export function invalidateDocumentList(sessionId: string): void {
  listCache.delete(sessionId)
}

/**
 * List metadata for every (non-expired) document in a session. Documents whose
 * keys have expired but linger in the index are pruned from the index as a
 * side-effect, so the index self-heals. Cached per session (see above).
 */
export async function listDocuments(
  sessionId: string,
  callTool: CallTool = stashCallTool(),
): Promise<StashDocumentMeta[]> {
  const cacheable = callTool === gatewayCallTool || callTool === directCallTool
  if (cacheable) {
    const hit = listCache.get(sessionId)
    if (hit && Date.now() - hit.at < LIST_CACHE_TTL_MS) return hit.docs
  }
  const members = await callTool('smembers', { name: indexKey(sessionId) })
  if (!members.success) return []

  const ids = parseSetMembers(members.data)
  const out: StashDocumentMeta[] = []

  for (const id of ids) {
    const doc = await getDocument(sessionId, id, callTool)
    if (doc) {
      out.push(stripContent(doc))
    } else {
      // Key expired/missing — drop the stale index entry.
      await callTool('srem', { name: indexKey(sessionId), value: id })
    }
  }

  // Newest first, matching the conversations list ordering.
  out.sort((a, b) => b.uploadedAt - a.uploadedAt)
  if (cacheable) listCache.set(sessionId, { docs: out, at: Date.now() })
  return out
}

// ============================================================================
// Mutate flags (hide / unhide / archive / unarchive)
// ============================================================================

/**
 * Patch a document's stash flags in place (hide/archive), preserving its TTL.
 * Mirrors `enrichToolResult` semantics for tool results so the existing
 * DataStashPanel actions apply uniformly to uploads. Returns the updated
 * document, or null if it no longer exists.
 */
export async function setDocumentFlags(
  sessionId: string,
  docId: string,
  patch: {
    hidden?: boolean
    archived?: boolean
    ingestStatus?: IngestStatus
    /** Derived markdown for a converted binary (see {@link StashDocument.derivedText}). */
    derivedText?: string
  },
  callTool: CallTool = stashCallTool(),
): Promise<StashDocument | null> {
  const doc = await getDocument(sessionId, docId, callTool)
  if (!doc) return null

  if (patch.hidden !== undefined) doc.hidden = patch.hidden
  if (patch.archived !== undefined) doc.archived = patch.archived
  if (patch.ingestStatus !== undefined) doc.ingestStatus = patch.ingestStatus
  if (patch.derivedText !== undefined) doc.derivedText = patch.derivedText

  // Rewriting via json_set at `$` would clear any existing expiry, so we
  // re-apply a TTL. There is no `ttl` tool on the Redis MCP surface to read the
  // remaining time, so we refresh to the default window — a flag edit signals
  // the document is still in use, making a fresh window reasonable.
  const key = docKey(sessionId, docId)
  const set = await callTool('json_set', {
    name: key,
    path: '$',
    value: JSON.stringify(doc),
    expire_seconds: DEFAULT_TTL_SECONDS,
  })
  const setErr = redisWriteError(set)
  if (setErr) {
    throw new Error(`Failed to update document: ${setErr}`)
  }
  invalidateDocumentList(sessionId)
  return doc
}

// ============================================================================
// Delete
// ============================================================================

/** Remove a document from Redis and from the session index. Idempotent. */
export async function deleteDocument(
  sessionId: string,
  docId: string,
  callTool: CallTool = stashCallTool(),
): Promise<void> {
  // `delete` uses `key` (not `name`) — see CLAUDE.md Redis quirks.
  await callTool('delete', { key: docKey(sessionId, docId) })
  await callTool('srem', { name: indexKey(sessionId), value: docId })
  invalidateDocumentList(sessionId)
}

// ============================================================================
// Agent-facing adapter — surface a document as a PriorResult / ref
// ============================================================================

/**
 * Convert a stored document into the `PriorResult` shape simpleLoop already
 * uses for tool results, so uploads can be passed through `turns_previous_runs`
 * and expanded via `ref:<id>` without touching the harness-patterns layer.
 *
 * `summary` is a short, deterministic preview here; the embedding/summarization
 * pipeline (#8) can replace it with a model-authored summary later.
 */
export function toPriorResult(
  doc: StashDocumentMeta & { content?: string },
  previewChars = 200,
): PriorResult {
  // Base64 (binary) content is not human-readable — fall back to a metadata
  // preview rather than slicing the encoded blob into the summary.
  const isBinary = doc.encoding === 'base64'
  const preview = doc.content && !isBinary
    ? doc.content.slice(0, previewChars).replace(/\s+/g, ' ').trim() +
      (doc.content.length > previewChars ? '…' : '')
    : `${doc.filename} (${doc.mimeType}, ${doc.size} bytes)`
  return {
    ref_id: doc.id,
    tool: `upload:${doc.filename}`,
    summary: preview,
    expanded_in_turn: null,
  }
}

// ============================================================================
// Internal helpers
// ============================================================================

export function stripContent(doc: StashDocument): StashDocumentMeta {
  const { content: _content, derivedText, ...meta } = doc
  void _content
  // Surface a boolean instead of the (potentially large) derived markdown, so
  // the meta list stays light but the panel still knows a converted binary is
  // viewable/ingested. Kept out of the stored JSON — computed on every read.
  return { ...meta, ...(derivedText != null ? { converted: true } : {}) }
}
