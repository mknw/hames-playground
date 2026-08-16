/**
 * Data Stash Upload Service — Server Only
 *
 * Request-parsing for the `POST /api/stash/upload` route, kept separate from
 * the route handler so it is unit-testable without spinning up the router.
 *
 * Two intake shapes are supported:
 *   - `multipart/form-data` with a `file` field (+ optional `sessionId`) — the
 *     browser file-picker / drag-drop path.
 *   - `application/json` `{ sessionId, filename, mimeType, content, ttlSeconds? }`
 *     — the programmatic path (and what #89 / the sandbox lane can call).
 *
 * Both yield a {@link StoreDocumentInput} for `document-store.server.ts`. Text
 * formats are stored as UTF-8; recognized binary formats (xlsx, pdf, images, …)
 * are base64-encoded with `encoding: 'base64'` so the original bytes round-trip
 * through the sandbox `/work` flow (#89). Semantic text extraction from binaries
 * (for RAG/search) is still left to the caller.
 */

import { assertServerOnImport } from '../harness-patterns/assert.server'
import type { StoreDocumentInput } from '../document-store.server'

assertServerOnImport()

/** Extension → MIME fallback for uploads that arrive without a usable type. */
const MIME_BY_EXT: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  json: 'application/json',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  log: 'text/plain',
  // Common binary types — so a file arriving without a usable `blob.type`
  // (e.g. the JSON intake path) is still classified binary and base64-encoded.
  pdf: 'application/pdf',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  zip: 'application/zip',
  parquet: 'application/vnd.apache.parquet',
  // Audio — the agent-trigger endpoint stores voice recordings here. Mapped so
  // a file arriving without a usable `blob.type` is still classified binary
  // (audio/* fails isTextMime → base64) rather than corrupted as UTF-8 text.
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  caf: 'audio/x-caf',
}

/** Best-effort MIME from a filename extension; defaults to `text/plain`. */
export function guessMimeType(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot < 0 || dot === filename.length - 1) return 'text/plain'
  const ext = filename.slice(dot + 1).toLowerCase()
  return MIME_BY_EXT[ext] ?? 'text/plain'
}

/**
 * Whether a MIME type holds UTF-8 text we can store verbatim. Everything else
 * (xlsx, pdf, images, zip, …) is treated as binary → base64. Covers `text/*`
 * plus the structured text application types and `+json`/`+xml` suffixes.
 */
export function isTextMime(mimeType: string): boolean {
  const m = mimeType.toLowerCase()
  if (m.startsWith('text/')) return true
  return /^application\/(json|xml|yaml|x-yaml|x-ndjson|.*\+json|.*\+xml)$/.test(m)
}

/**
 * Parse an upload request body into a {@link StoreDocumentInput}.
 * @throws Error (message safe to surface as a 400) on malformed input.
 */
export async function parseUploadRequest(
  request: Request,
): Promise<StoreDocumentInput & { agentId?: string }> {
  const contentType = request.headers.get('content-type') ?? ''

  if (contentType.includes('multipart/form-data')) {
    const form = await request.formData()
    const file = form.get('file')
    // Duck-type rather than `instanceof File`: the runtime and test (jsdom)
    // realms can hand back File objects from different constructors, so an
    // instanceof check is unreliable. A Blob/File exposes async `text()`.
    if (file == null || typeof file === 'string' || typeof (file as Blob).text !== 'function') {
      throw new Error('multipart upload requires a "file" field')
    }
    const blob = file as File
    const sessionId = String(form.get('sessionId') ?? '').trim()
    // Optional: the conversation's selected agent, so the auto-ingest gate can
    // resolve the harness even before the session is persisted (uploads made
    // before the first chat message).
    const agentId = String(form.get('agentId') ?? '').trim() || undefined
    const filename = blob.name || 'upload'
    const ttlRaw = form.get('ttlSeconds')
    const ttlSeconds =
      ttlRaw != null && ttlRaw !== '' ? Number(ttlRaw) : undefined
    const mimeType = blob.type || guessMimeType(filename)
    const isText = isTextMime(mimeType)
    const content = isText
      ? await blob.text()
      : Buffer.from(await blob.arrayBuffer()).toString('base64')
    return {
      sessionId,
      filename,
      mimeType,
      content,
      ...(isText ? {} : { encoding: 'base64' as const }),
      ...(Number.isFinite(ttlSeconds) ? { ttlSeconds } : {}),
      ...(agentId ? { agentId } : {}),
    }
  }

  // Default: JSON body.
  let body: Partial<StoreDocumentInput> & { agentId?: string }
  try {
    body = (await request.json()) as Partial<StoreDocumentInput> & { agentId?: string }
  } catch {
    throw new Error('Request body must be JSON or multipart/form-data')
  }
  if (typeof body.content !== 'string') {
    throw new Error('content (string) is required')
  }
  const filename = body.filename?.trim() || 'upload.txt'
  const agentId = typeof body.agentId === 'string' ? body.agentId.trim() || undefined : undefined
  return {
    sessionId: String(body.sessionId ?? '').trim(),
    filename,
    mimeType: body.mimeType?.trim() || guessMimeType(filename),
    content: body.content,
    ...(body.encoding === 'base64' ? { encoding: 'base64' as const } : {}),
    ...(typeof body.ttlSeconds === 'number' ? { ttlSeconds: body.ttlSeconds } : {}),
    ...(agentId ? { agentId } : {}),
  }
}
