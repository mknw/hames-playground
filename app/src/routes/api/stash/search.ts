/**
 * Data Stash Search API (#8)
 *
 *   GET /api/stash/search?sessionId=&q=&k=  — KNN similarity over a session's
 *     ingested chunks. The query is embedded with the same model the corpus was
 *     ingested with (enforced in document-ingest.server.ts); returns [] when
 *     nothing has been ingested for the session.
 */

import type { APIEvent } from '@solidjs/start/server'
import { searchDocuments } from '../../../lib/document-ingest.server'
import { json, requireSessionOwner, withUser } from '../../../lib/stash/http.server'

export async function GET(event: APIEvent) {
  return withUser(async (userId) => {
    const url = new URL(event.request.url)
    const sessionId = url.searchParams.get('sessionId')
    const q = url.searchParams.get('q')
    const kRaw = url.searchParams.get('k')
    if (!sessionId || !q) {
      return json({ error: 'sessionId and q are required' }, 400)
    }
    const denied = await requireSessionOwner(sessionId, userId)
    if (denied) return denied
    const k = kRaw && Number.isFinite(Number(kRaw)) ? Number(kRaw) : undefined

    try {
      const hits = await searchDocuments(sessionId, q, { k })
      return json({ hits })
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : 'Search failed' }, 500)
    }
  })
}
