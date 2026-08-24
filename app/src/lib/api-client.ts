/**
 * The client → REST seam (#226 B4).
 *
 * The app has two client→server transports. Server actions go through
 * `harness-client` and are typed end to end. Every REST endpoint used to be
 * hand-fetched at the call site — nine `fetch` calls across four files, each
 * with its own inline response type, its own idea of what a non-OK status
 * means, and its own copy of the URL. Two of them polled the *same* endpoint
 * on different intervals.
 *
 * This module is the other half of that seam: one place that owns the URLs,
 * the request/response types and the error contract. Nothing outside it
 * writes an `/api/...` string.
 *
 * Error contract: every call rejects with `ApiError` on a non-OK status,
 * carrying the status and the parsed body when there was one. The message is
 * whatever the calling surface has to show a user, so it is chosen per
 * endpoint rather than templated here. Network failures reject with whatever
 * `fetch` threw — callers that must not surface those (the PTY writes, the
 * embedding poll) say so explicitly at their own call site.
 *
 * Read caching and polling are deliberately NOT here — see
 * `lib/stash-documents.ts`, which layers the shared document cache over
 * `listStashDocuments`.
 */
import type { StashDocumentMeta } from '~/lib/document-store.server'
import type { HarnessSettings } from '~/lib/settings'

export type { StashDocumentMeta }

// ============================================================================
// Endpoints
// ============================================================================

/** Every client-visible REST path, in one table. */
export const API = {
  events: '/api/events',
  /** Tool-result stash flags (hide / archive), not documents. */
  toolResultStash: '/api/stash',
  stashDocuments: '/api/stash/upload',
  stashDocument: (id: string) => `/api/stash/document/${encodeURIComponent(id)}`,
  ptyResize: '/api/sandbox/pty/resize',
  ptyInput: '/api/sandbox/pty/input',
  ptyStream: '/api/sandbox/pty/stream',
} as const

// ============================================================================
// Errors
// ============================================================================

export class ApiError extends Error {
  readonly status: number
  readonly body: unknown

  constructor(message: string, status: number, body?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.body = body
  }
}

/** Parse a JSON body, tolerating an empty or malformed one (204s, HTML errors). */
async function readJson<T>(response: Response): Promise<T | undefined> {
  return (await response.json().catch(() => undefined)) as T | undefined
}

const jsonRequest = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

// ============================================================================
// Chat stream
// ============================================================================

export interface ChatTurnRequest {
  sessionId: string
  message: string
  agentId: string
  settings: HarnessSettings
}

/**
 * Open the SSE stream for one turn. Returns the raw `Response` because the
 * body is a stream the caller iterates (`parseChatStream`), not a value.
 *
 * The message wording is load-bearing: it is what the error bubble shows.
 */
export async function openChatStream(
  request: ChatTurnRequest,
  signal: AbortSignal,
): Promise<Response> {
  const response = await fetch(API.events, { ...jsonRequest(request), signal })
  if (!response.ok) throw new ApiError(`Server error: ${response.status}`, response.status)
  return response
}

// ============================================================================
// Data Stash — tool results
// ============================================================================

export type StashToolResultAction = 'hide' | 'unhide' | 'archive' | 'unarchive'

/** Persist a hide/archive flag on one tool-result event. */
export async function applyToolResultAction(
  sessionId: string,
  eventId: string,
  action: StashToolResultAction,
): Promise<void> {
  const response = await fetch(API.toolResultStash, jsonRequest({ sessionId, eventId, action }))
  if (!response.ok) {
    throw new ApiError(`Stash action failed (${response.status})`, response.status)
  }
}

// ============================================================================
// Data Stash — documents
// ============================================================================

/** The document body the viewer renders. `encoding: 'base64'` has no preview. */
export interface StashDocumentBody {
  content?: string
  encoding?: string
}

/**
 * List a session's uploaded documents.
 *
 * A non-OK status reads as "no documents" rather than an error: both callers
 * (the composer's embedding gate and the panel's status poll) are polls, and a
 * transient 500 must not be reported to the user as a failure. A *network*
 * failure still rejects — that is the caller's to interpret.
 */
export async function listStashDocuments(sessionId: string): Promise<StashDocumentMeta[]> {
  const url = `${API.stashDocuments}?sessionId=${encodeURIComponent(sessionId)}`
  const response = await fetch(url)
  if (!response.ok) return []
  const body = await readJson<{ documents?: StashDocumentMeta[] }>(response)
  return body?.documents ?? []
}

/** Store one uploaded file. Resolves with the stored metadata the route echoes
 *  back, which already carries `ingestStatus` for the optimistic row. */
export async function uploadStashDocument(input: {
  sessionId: string
  agentId?: string
  file: File
}): Promise<StashDocumentMeta | undefined> {
  const form = new FormData()
  form.set('sessionId', input.sessionId)
  if (input.agentId) form.set('agentId', input.agentId)
  form.set('file', input.file)

  const response = await fetch(API.stashDocuments, { method: 'POST', body: form })
  const body = await readJson<{ error?: string; document?: StashDocumentMeta }>(response)
  if (!response.ok) {
    throw new ApiError(body?.error ?? `Upload failed (${response.status})`, response.status, body)
  }
  return body?.document
}

/** Fetch one document's full text. */
export async function getStashDocument(
  id: string,
  sessionId: string,
): Promise<StashDocumentBody | undefined> {
  const url = `${API.stashDocument(id)}?sessionId=${encodeURIComponent(sessionId)}`
  const response = await fetch(url)
  // Wording is load-bearing: the viewer shows this string verbatim.
  if (!response.ok) throw new ApiError(`HTTP ${response.status}`, response.status)
  const body = await readJson<{ document?: StashDocumentBody }>(response)
  return body?.document
}

/**
 * Direct URL for the raw file (base64-decoded server-side for binary). An
 * anchor click is what streams it, so the server's `Content-Disposition`
 * filename is honoured — this cannot be a `fetch`. It doubles as the `<audio>`
 * src: media elements ignore `Content-Disposition`, so one route serves both
 * download and playback.
 */
export function stashDocumentDownloadUrl(id: string, sessionId: string): string {
  return `${API.stashDocument(id)}?sessionId=${encodeURIComponent(sessionId)}&download`
}

export interface StashDocumentPatch {
  hidden?: boolean
  archived?: boolean
}

export async function patchStashDocument(
  id: string,
  sessionId: string,
  patch: StashDocumentPatch,
): Promise<void> {
  const response = await fetch(API.stashDocument(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, ...patch }),
  })
  if (!response.ok) {
    const body = await readJson<{ error?: string }>(response)
    throw new ApiError(body?.error ?? `Update failed (${response.status})`, response.status, body)
  }
}

export async function deleteStashDocument(id: string, sessionId: string): Promise<void> {
  const url = `${API.stashDocument(id)}?sessionId=${encodeURIComponent(sessionId)}`
  const response = await fetch(url, { method: 'DELETE' })
  if (!response.ok) {
    const body = await readJson<{ error?: string }>(response)
    throw new ApiError(body?.error ?? `Delete failed (${response.status})`, response.status, body)
  }
}

// ============================================================================
// Sandbox PTY
// ============================================================================

/**
 * Report the terminal's new geometry.
 *
 * The PTY writes are the one pair that does not raise on a non-OK status: they
 * are fire-and-forget from a `ResizeObserver` and an `onData` handler, where a
 * rejection has nowhere to go and the next event corrects the state anyway.
 * Callers still attach a `.catch` for the network case.
 */
export async function resizePty(sessionId: string, cols: number, rows: number): Promise<void> {
  await fetch(API.ptyResize, jsonRequest({ sessionId, cols, rows }))
}

/** Forward keystrokes (and pasted control sequences) to the PTY. Same
 *  fire-and-forget contract as `resizePty`. */
export async function sendPtyInput(sessionId: string, data: string): Promise<void> {
  await fetch(API.ptyInput, jsonRequest({ sessionId, data }))
}

/**
 * URL for the PTY output stream. An `EventSource`, not a `fetch` — the agent
 * id rides along so the server can hydrate `/work` for durable-workspace
 * agents when this Shell is the first to boot the container (#97 Gap 3).
 */
export function ptyStreamUrl(sessionId: string, agentId?: string): string {
  const base = `${API.ptyStream}?sessionId=${encodeURIComponent(sessionId)}`
  return agentId ? `${base}&agentId=${encodeURIComponent(agentId)}` : base
}
