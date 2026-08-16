/**
 * Document → Markdown conversion — Server Only
 *
 * Converts binary office/PDF uploads (docx, odt, pptx, pdf) to markdown so they
 * can flow through the existing text pipeline (chunk → embed → index → KNN).
 * Without this, binary uploads are stored but never searchable (the chunker
 * treats `content` as UTF-8 text and `ingestStashDocument` marks base64 docs
 * `failed`).
 *
 * Conversion is a *host pipeline step*, not an agentic tool, so — like the
 * direct-Redis app path — it talks to a plain HTTP sidecar rather than the MCP
 * gateway. The sidecar is a document-extraction service exposing a `/extract`
 * endpoint (default: the stable `kreuzberg-full` image; the `xberg` RC line is a
 * drop-in alternative — same `/extract` contract, just a different compose tag).
 *
 * Gated by `STASH_CONVERT_DOCS=1`. Off (default) → binaries behave exactly as
 * before (stored, not ingested). If the sidecar is unreachable the conversion
 * throws and the caller records `ingestStatus: 'failed'` — the upload itself
 * never fails.
 */

import { assertServerOnImport } from './harness-patterns/assert.server'

assertServerOnImport()

/** MIME type we tag derived text with once converted. */
export const MARKDOWN_MIME = 'text/markdown'

/** Whether document→markdown conversion is enabled for the Data Stash path. */
export function conversionEnabled(): boolean {
  return process.env.STASH_CONVERT_DOCS === '1'
}

/**
 * Base URL of the conversion sidecar. Dev default matches the compose service
 * publishing `8000:8000` on the host. Override with `DOC_CONVERT_URL` when the
 * app runs inside the compose network (e.g. `http://doc-convert:8000`).
 */
export function docConvertUrl(): string {
  return process.env.DOC_CONVERT_URL || 'http://localhost:8000'
}

/**
 * Binary MIME types we route through the converter. Deliberately a small,
 * explicit allowlist (the requested docx/odt/pptx/pdf + their legacy variants)
 * rather than "any non-text" — an unknown binary (zip, image, parquet) should
 * still be stored-but-not-ingested, not sent to the converter. Extend here to
 * add formats (e.g. xlsx) the sidecar also supports.
 */
const CONVERTIBLE_MIMES = new Set<string>([
  'application/pdf',
  // Word
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/msword', // .doc
  // OpenDocument text
  'application/vnd.oasis.opendocument.text', // .odt
  // PowerPoint
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'application/vnd.ms-powerpoint', // .ppt
  'application/vnd.oasis.opendocument.presentation', // .odp
])

/** Whether a stored binary doc of this MIME type should be converted. */
export function isConvertible(mimeType: string): boolean {
  return CONVERTIBLE_MIMES.has(mimeType.trim().toLowerCase())
}

/** Conversion request timeout (ms). Large/scanned PDFs with OCR can be slow;
 *  ingest runs in the background, so a generous default is fine. */
const CONVERT_TIMEOUT_MS = Number(process.env.DOC_CONVERT_TIMEOUT_MS) || 120_000

/**
 * Pull the extracted markdown out of the sidecar's `/extract` reply. The stable
 * kreuzberg 4.x server returns a BARE ARRAY (`[{ content, mime_type, … }]`); the
 * xberg RC wraps it as `{ results: [...] }`. Accept either, and tolerate a
 * `text`/`markdown` field name, so swapping the sidecar image needs no code
 * change. Returns the string, or null if the shape carries no usable content.
 */
export function extractMarkdown(body: unknown): string | null {
  const arr: unknown[] = Array.isArray(body)
    ? body
    : Array.isArray((body as { results?: unknown[] })?.results)
      ? (body as { results: unknown[] }).results
      : []
  const first = arr[0]
  if (!first || typeof first !== 'object') return null
  const rec = first as Record<string, unknown>
  const md = rec.content ?? rec.markdown ?? rec.text
  return typeof md === 'string' ? md : null
}

/**
 * Convert base64-encoded binary document bytes to markdown via the sidecar.
 * `fetchFn` is injectable so tests never open a socket.
 *
 * @throws on disabled/unreachable sidecar, non-2xx, timeout, or empty output —
 *         callers (ingest) turn a throw into `ingestStatus: 'failed'`.
 */
export async function convertToMarkdown(
  base64Content: string,
  filename: string,
  mimeType: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  const bytes = Buffer.from(base64Content, 'base64')
  const form = new FormData()
  const blob = new Blob([new Uint8Array(bytes)], {
    type: mimeType || 'application/octet-stream',
  })
  form.append('files', blob, filename || 'upload')
  // Request markdown explicitly — the sidecar defaults to `plain`, which drops
  // heading markers and would defeat the markdown-aware chunker (bindHeadings).
  form.append('config', JSON.stringify({ output_format: 'markdown' }))

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CONVERT_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetchFn(`${docConvertUrl()}/extract`, {
      method: 'POST',
      body: form,
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }

  if (!res.ok) {
    throw new Error(`doc-convert /extract failed: HTTP ${res.status}`)
  }
  const md = extractMarkdown(await res.json())
  if (md == null || md.trim() === '') {
    throw new Error('doc-convert returned no content')
  }
  return md
}
