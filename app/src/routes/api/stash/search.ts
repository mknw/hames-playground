/**
 * Data Stash Search API (#8)
 *
 *   GET /api/stash/search?sessionId=&q=&k=  — KNN similarity over a session's
 *     ingested chunks. The query is embedded with the same model the corpus was
 *     ingested with (enforced in document-ingest.server.ts); returns [] when
 *     nothing has been ingested for the session. `k` is optional; a value
 *     that is not a finite number is a 400, and a number is truncated and
 *     clamped to 1..MAX_SEARCH_SPAN (#707).
 */

import type { APIEvent } from '@solidjs/start/server'
import {
  MAX_SEARCH_SPAN,
  searchDocuments,
} from '@hames-ai/harness-patterns/stash/document-ingest.server'
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
    const kNum = kRaw ? Number(kRaw) : undefined
    if (kNum !== undefined && !Number.isFinite(kNum)) {
      return json({ error: 'k must be a number' }, 400)
    }
    const k =
      kNum === undefined ? undefined : Math.min(Math.max(Math.trunc(kNum), 1), MAX_SEARCH_SPAN)
    const denied = await requireSessionOwner(sessionId, userId)
    if (denied) return denied

    try {
      const hits = await searchDocuments(sessionId, q, { k })
      return json({ hits })
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : 'Search failed' }, 500)
    }
  })
}
