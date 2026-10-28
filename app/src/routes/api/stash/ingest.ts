/**
 * Data Stash Ingest API (#8/#9)
 *
 *   POST /api/stash/ingest  — chunk → embed → index a stored document for search
 *     body: { sessionId, docId }
 *     202:  { ok, docId, ingestStatus: 'pending' } — the outcome lands on the
 *           document's `ingestStatus` (`indexed`, or `failed` + `ingestError`)
 *     200:  { ok, docId, ingestStatus: 'indexed' } — already searchable; nothing ran
 *
 * The explicit ingest: the Data Stash panel's "Index for search" button (#832).
 * Upload runs the same ingest on its own when the session's agent composes a
 * redis retriever. Either way it needs an embedding backend (local llama-server
 * :8090 by default) and binds the session's corpus to one embedding model. See
 * document-ingest.server.ts.
 *
 * It runs the way upload's does: `pending` is stored before the answer, so the
 * panel's "embedding…" and the composer's block agree with the server from the
 * click, and the embed — slow on the serial gateway — runs after it through the
 * status-tracked `ingestStashDocument`. This route used to await `ingestDocument`
 * itself, which indexed the chunks and wrote no status at all, so nothing the
 * panel reads ever said the copy had become searchable.
 *
 * The server decides how a copy is indexed, as it does for upload and for the
 * retriever's safety net: the embedder, its endpoint and key, the chunking and
 * the one-model-per-corpus guard all come from the server's own configuration,
 * never from the request. A caller-supplied embedding config would have the app
 * post the document's text to a URL of the caller's choosing, past the boot
 * check that refuses an untrusted embedder.
 */

import type { APIEvent } from '@solidjs/start/server'
import {
  getDocument,
  setDocumentFlags,
} from '@hames-ai/harness-patterns/stash/document-store.server'
import { ingestStashDocument } from '@hames-ai/harness-patterns/stash/document-ingest.server'
import { claimSession, json, withUser } from '../../../lib/stash/http.server'

export async function POST(event: APIEvent) {
  return withUser(async (userId) => {
    let body: { sessionId?: string; docId?: string }
    try {
      body = await event.request.json()
    } catch {
      return json({ error: 'Request body must be JSON' }, 400)
    }
    const { sessionId, docId } = body
    if (!sessionId || !docId) {
      return json({ error: 'sessionId and docId are required' }, 400)
    }
    // Like upload, ingest can be the first touch of a session that has no
    // conversation row yet, so it records ownership rather than requiring it —
    // and refuses a session that already belongs to someone else.
    const denied = await claimSession(sessionId, userId)
    if (denied) return denied

    const doc = await getDocument(sessionId, docId)
    // The store key already scopes the lookup to the named session; the record
    // must say the same, or this is another session's document. Ingest indexes
    // under the record's own session, so a mismatch would write into that one.
    if (!doc || doc.sessionId !== sessionId) {
      return json({ error: 'Document not found' }, 404)
    }
    // Binary (base64) documents hold raw bytes, not text — chunking/embedding
    // them would index garbage. RAG ingestion is text-only (#89).
    if (doc.encoding === 'base64') {
      return json(
        { error: 'Cannot ingest a binary document; text search applies to text content only' },
        415,
      )
    }
    // One run per copy. A copy already `pending` has a run in flight — two tabs,
    // a list that has not caught up, or a direct POST would start a second one,
    // which contends on the serial gateway and, the status write being last-writer-
    // wins, could write `failed` over the `indexed` the first one wrote. A copy
    // already `indexed` holds the text it was indexed from: a document's content
    // is fixed when it is stored under a freshly minted id. This reads, then
    // writes, so it bounds repeated clicks, not two requests in the same instant.
    if (doc.ingestStatus === 'pending') {
      return json({ ok: true, docId, ingestStatus: 'pending' }, 202)
    }
    if (doc.ingestStatus === 'indexed') {
      return json({ ok: true, docId, ingestStatus: 'indexed' }, 200)
    }

    try {
      const marked = await setDocumentFlags(sessionId, docId, {
        ingestStatus: 'pending',
        ingestError: null,
      })
      if (!marked) return json({ error: 'Document not found' }, 404)
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : 'Ingest failed' }, 500)
    }

    // Records its own outcome on the document and is documented not to throw. A
    // throw anyway would leave the `pending` above standing — an "embedding…"
    // that never ends — so it is recorded as the failure it is, and logged.
    void ingestStashDocument(sessionId, docId).catch(async (err: unknown) => {
      const reason = err instanceof Error ? err.message : String(err)
      console.error(`[ingest] ${docId} threw for session ${sessionId}:`, reason)
      // Capped as the package caps its own recorded reasons.
      await setDocumentFlags(sessionId, docId, {
        ingestStatus: 'failed',
        ingestError: reason.slice(0, 500),
      }).catch(() => console.error(`[ingest] ${docId}: could not record the failure either`))
    })
    return json({ ok: true, docId, ingestStatus: 'pending' }, 202)
  })
}
