/**
 * Data Stash Upload API (Issue #6)
 *
 *   POST /api/stash/upload          — store an uploaded document in Redis
 *   GET  /api/stash/upload?sessionId — list a session's uploaded documents (meta)
 *
 * Storage is delegated to `document-store.server.ts`; this route only handles
 * intake (multipart or JSON), auth, and shaping the HTTP response. Companion
 * routes for a single document live in `stash/document/[id].ts`.
 */

import type { APIEvent } from '@solidjs/start/server'
import { storeDocument, listDocuments } from '../../../lib/document-store.server'
import { ingestStashDocument } from '../../../lib/document-ingest.server'
import { loadSession } from '../../../lib/harness-client/session.server'
import { agentUsesRedisRetriever } from '../../../lib/harness-client/registry.server'
import { parseUploadRequest } from '../../../lib/stash/upload-service.server'
import { conversionEnabled, isConvertible } from '../../../lib/doc-convert.server'
import { claimSession, json, sessionNotFound, withUser } from '../../../lib/stash/http.server'
import { resolveSessionOwner } from '../../../lib/stash/ownership.server'

export async function POST(event: APIEvent) {
  return withUser(async (userId) => {
    let input
    try {
      input = await parseUploadRequest(event.request)
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : 'Invalid upload' }, 400)
    }
    if (!input.sessionId) return json({ error: 'sessionId is required' }, 400)

    // An upload is the session's first touch as often as not (a file dropped
    // before the first chat message), so this both records the uploader as the
    // owner of a fresh session and rejects a session that is already someone
    // else's. Everything downstream — reads, ingest, flag edits — is checked
    // against what this establishes.
    const denied = await claimSession(input.sessionId, userId)
    if (denied) return denied

    try {
      const { agentId, ...storeInput } = input

      // Harness-aware Data Stash: if this session's agent composes a retriever
      // wired to the local redis vector store, auto-ingest the upload. The GATE
      // DECISION is fast (memoized per agentId), and we decide it BEFORE storing
      // so the very first write persists `ingestStatus: 'pending'`. That closes
      // the status gap: Redis reflects "embedding…" from t=0, so a status poll
      // (chip / composer-block) can never read a no-status doc and flicker. The
      // actual embed (slow on the serial gateway) runs in the background; the
      // client reconciles to indexed/failed via `GET ?sessionId`. The agentId
      // hint lets this work even before the session is persisted (drop-then-chat).
      const ingest = await willAutoIngest(
        input.sessionId,
        userId,
        storeInput.encoding,
        storeInput.mimeType,
        agentId,
      )
      const doc = await storeDocument({
        ...storeInput,
        ...(ingest ? { ingestStatus: 'pending' as const } : {}),
      })
      const { content: _content, ...meta } = doc
      void _content

      if (ingest) {
        void ingestStashDocument(input.sessionId, doc.id).catch(() => {})
      }

      return json({ ok: true, document: meta }, 201)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Upload failed'
      // Size-limit rejections from the store map to 413; everything else 500.
      return json({ error: msg }, /too large/i.test(msg) ? 413 : 500)
    }
  })
}

/**
 * Fast gate decision: should this upload be auto-ingested? True only for a
 * text doc whose (client-hinted or persisted) agent composes a redis retriever.
 * `agentUsesRedisRetriever` is memoized per agentId, so this is cheap after the
 * first call. Best-effort: never throws (returns false); the retriever's lazy
 * `ensureSessionIngested` net still covers anything missed on first search.
 */
async function willAutoIngest(
  sessionId: string,
  userId: string,
  encoding: 'utf8' | 'base64' | undefined,
  mimeType: string,
  agentId: string | undefined,
): Promise<boolean> {
  // Binary is ingestable only if we can convert it to text — a convertible type
  // (docx/pdf/pptx/odt) with conversion enabled. Other binaries (zip, images,
  // parquet) are stored but not searchable, so don't fire the gate for them.
  if (encoding === 'base64' && !(conversionEnabled() && isConvertible(mimeType))) {
    return false
  }
  try {
    const resolvedAgentId = agentId ?? (await loadSession(sessionId, userId))?.agentId
    if (!resolvedAgentId) return false // session not persisted + no agent hint
    return await agentUsesRedisRetriever(resolvedAgentId, sessionId)
  } catch {
    return false
  }
}

export async function GET(event: APIEvent) {
  return withUser(async (userId) => {
    const sessionId = new URL(event.request.url).searchParams.get('sessionId')
    if (!sessionId) return json({ error: 'sessionId is required' }, 400)
    // The panel lists a session's documents from the moment it opens, which
    // includes a brand-new session nobody has claimed yet. An unclaimed session
    // holds no documents (every write path claims before it stores), so it
    // lists as empty — the honest answer, and one that keeps a fresh chat from
    // opening on an error. Anyone else's session is 404, as everywhere.
    const owner = await resolveSessionOwner(sessionId)
    if (owner === null) return json({ documents: [] })
    if (owner !== userId) return sessionNotFound()
    const documents = await listDocuments(sessionId)
    return json({ documents })
  })
}
