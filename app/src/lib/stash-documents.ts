/**
 * The one read path for a session's stashed documents (#226 B4).
 *
 * Two independent pollers hit `GET /api/stash/upload`: the Data Stash panel
 * every 4s while an ingest is pending, and the chat route every 3s to decide
 * whether the composer is blocked on embedding. They shared a module-level
 * `Map` that only one of them wrote, so the route's polls warmed nothing and
 * the panel's cache went stale behind them.
 *
 * This module owns that cache and a single-flight guard over the list call, so
 * the two pollers coalesce onto one request and both see what it returned. The
 * intervals stay where they are — each caller decides *when* it needs a read;
 * this decides what a read costs.
 */
import { listStashDocuments, type StashDocumentMeta } from '~/lib/api-client'

export type { StashDocumentMeta }

/**
 * Last known list per session. Ark's Tabs unmounts the inactive tab, so the
 * panel re-mounts every time it is selected — without the cache each re-mount
 * re-ran a ~12s list and the Suspense boundary flashed "Loading data…". The
 * panel seeds from here (instant) and refreshes behind the cached view.
 */
const cache = new Map<string, StashDocumentMeta[]>()
const inFlight = new Map<string, Promise<StashDocumentMeta[]>>()

/** What the last read saw, or `undefined` if this session has never been read
 *  (which is what tells the panel to show its cold-load spinner). */
export function cachedDocuments(sessionId: string): StashDocumentMeta[] | undefined {
  return cache.get(sessionId)
}

/** Record a list the caller already knows to be current — an optimistic add
 *  after an upload, or a removal the server has confirmed. */
export function cacheDocuments(sessionId: string, documents: StashDocumentMeta[]): void {
  cache.set(sessionId, documents)
}

/**
 * Read the list, coalescing concurrent callers onto one request.
 *
 * Rejects only on a network failure — a non-OK status reads as an empty list
 * (see `listStashDocuments`). A rejection leaves the cache untouched.
 */
export function refreshDocuments(sessionId: string): Promise<StashDocumentMeta[]> {
  const pending = inFlight.get(sessionId)
  if (pending) return pending

  const request = listStashDocuments(sessionId)
    .then((documents) => {
      cache.set(sessionId, documents)
      return documents
    })
    .finally(() => inFlight.delete(sessionId))

  inFlight.set(sessionId, request)
  return request
}

/** True while any uploaded source is still being embedded — the rule the
 *  composer's block and the panel's poll window both read. */
export function hasPendingIngest(documents: StashDocumentMeta[]): boolean {
  return documents.some((d) => d.ingestStatus === 'pending')
}

/** Drop everything. Test seam: the cache is module state by design (it has to
 *  outlive the panel's unmount), so a test that seeds it must be able to. */
export function clearDocumentCache(): void {
  cache.clear()
  inFlight.clear()
}
