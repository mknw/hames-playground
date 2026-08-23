/**
 * Data Stash single-document API (Issue #6)
 *
 *   GET    /api/stash/document/:id?sessionId            — full document (content + meta)
 *   GET    /api/stash/document/:id?sessionId&download   — raw file stream
 *                                               (base64-decoded for binary)
 *   DELETE /api/stash/document/:id?sessionId  — remove from Redis + index
 *   PATCH  /api/stash/document/:id            — toggle hide/archive flags
 *                                               body: { sessionId, hidden?, archived? }
 *
 * Documents are keyed by (sessionId, id); the session is supplied as a query
 * param (GET/DELETE) or in the JSON body (PATCH). Every method resolves the
 * session's owner first and answers 404 unless it is the caller's — see
 * `lib/stash/ownership.server.ts`.
 */

import type { APIEvent } from '@solidjs/start/server'
import {
  getDocument,
  deleteDocument,
  setDocumentFlags,
  stripContent,
} from '../../../../lib/document-store.server'
import {
  claimSession,
  json,
  requireSessionOwner,
  withUser,
} from '../../../../lib/stash/http.server'

function sessionParam(event: APIEvent): string | null {
  return new URL(event.request.url).searchParams.get('sessionId')
}

export async function GET(event: APIEvent) {
  return withUser(async (userId) => {
    const sessionId = sessionParam(event)
    if (!sessionId) return json({ error: 'sessionId is required' }, 400)
    const denied = await requireSessionOwner(sessionId, userId)
    if (denied) return denied
    const doc = await getDocument(sessionId, event.params.id)
    if (!doc) return json({ error: 'Document not found' }, 404)

    // ?download → stream the raw file with its original content-type, so the
    // DataStash UI can offer a real download. Binary docs are base64-decoded
    // back to bytes; text docs stream verbatim.
    if (new URL(event.request.url).searchParams.has('download')) {
      const isBinary = doc.encoding === 'base64'
      const body = isBinary ? Buffer.from(doc.content, 'base64') : doc.content
      const filename = doc.filename.replace(/["\r\n]/g, '')
      return new Response(body as BodyInit, {
        headers: {
          'Content-Type': doc.mimeType || 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Content-Length': String(
            isBinary ? (body as Buffer).length : Buffer.byteLength(doc.content, 'utf8'),
          ),
        },
      })
    }

    // Non-download: the viewer wants readable text. A converted binary
    // (docx/pdf/pptx/odt) keeps its base64 original in `content` for downloads,
    // so serve its derived markdown as the viewable `content` (utf8) instead —
    // chunk offsets from citations index into THIS text. Drop the heavy base64
    // blob and the duplicate `derivedText` field from the payload.
    if (doc.derivedText != null) {
      const { derivedText, ...rest } = doc
      return json({ document: { ...rest, content: derivedText, encoding: 'utf8' as const } })
    }

    return json({ document: doc })
  })
}

export async function DELETE(event: APIEvent) {
  return withUser(async (userId) => {
    const sessionId = sessionParam(event)
    if (!sessionId) return json({ error: 'sessionId is required' }, 400)
    const denied = await requireSessionOwner(sessionId, userId)
    if (denied) return denied
    // `ok: true` used to be unconditional: both Redis writes were fired and
    // neither checked, so a rejected delete answered "deleted" (sf-H4). The
    // store now throws on a failed write and this is where it becomes a 500 —
    // a privacy-relevant deletion must never be reported as done when it isn't.
    try {
      await deleteDocument(sessionId, event.params.id)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Delete failed'
      console.error(`[stash] delete failed for ${event.params.id}:`, msg)
      return json({ error: msg }, 500)
    }
    return json({ ok: true })
  })
}

export async function PATCH(event: APIEvent) {
  return withUser(async (userId) => {
    let body: { sessionId?: string; hidden?: boolean; archived?: boolean }
    try {
      body = await event.request.json()
    } catch {
      return json({ error: 'Request body must be JSON' }, 400)
    }
    if (!body.sessionId) return json({ error: 'sessionId is required' }, 400)
    // The write gate, because `setDocumentFlags` refreshes the document's TTL:
    // re-claiming moves the ownership window along with it, so a session whose
    // documents are still being edited never outlives the record of who owns it.
    const denied = await claimSession(body.sessionId, userId)
    if (denied) return denied

    const updated = await setDocumentFlags(body.sessionId, event.params.id, {
      hidden: body.hidden,
      archived: body.archived,
    })
    if (!updated) return json({ error: 'Document not found' }, 404)
    return json({ ok: true, document: stripContent(updated) })
  })
}
