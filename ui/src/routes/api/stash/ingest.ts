/**
 * Data Stash Ingest API (#8/#9)
 *
 *   POST /api/stash/ingest  — chunk → embed → index a stored document for search
 *     body: { sessionId, docId, chunk?, embedding?, allowSpaceChange? }
 *
 * Ingestion is an explicit step (not auto-run on upload): it requires an
 * embedding backend (local llama-server :8090 by default) and binds the
 * session's corpus to one embedding model. See document-ingest.server.ts.
 */

import type { APIEvent } from '@solidjs/start/server'
import { getDocument } from '../../../lib/document-store.server'
import { ingestDocument } from '../../../lib/document-ingest.server'
import { claimSession, json, withUser } from '../../../lib/stash/http.server'

export async function POST(event: APIEvent) {
  return withUser(async (userId) => {
    let body: {
      sessionId?: string
      docId?: string
      chunk?: Record<string, unknown>
      embedding?: Record<string, unknown>
      allowSpaceChange?: boolean
    }
    try {
      body = await event.request.json()
    } catch {
      return json({ error: 'Request body must be JSON' }, 400)
    }
    if (!body.sessionId || !body.docId) {
      return json({ error: 'sessionId and docId are required' }, 400)
    }
    // Like upload, ingest can be the first touch of a session that has no
    // conversation row yet, so it records ownership rather than requiring it —
    // and refuses a session that already belongs to someone else.
    const denied = await claimSession(body.sessionId, userId)
    if (denied) return denied

    const doc = await getDocument(body.sessionId, body.docId)
    if (!doc) return json({ error: 'Document not found' }, 404)
    // Binary (base64) documents hold raw bytes, not text — chunking/embedding
    // them would index garbage. RAG ingestion is text-only (#89).
    if (doc.encoding === 'base64') {
      return json(
        { error: 'Cannot ingest a binary document; text search applies to text content only' },
        415,
      )
    }

    try {
      const result = await ingestDocument(doc, {
        chunk: body.chunk,
        embedding: body.embedding,
        allowSpaceChange: body.allowSpaceChange,
      })
      return json({ ok: true, ...result })
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : 'Ingest failed' }, 500)
    }
  })
}
