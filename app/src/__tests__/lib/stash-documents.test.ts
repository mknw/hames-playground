/**
 * stash-documents — the shared read path for a session's uploaded documents
 * (#226 B4).
 *
 * Two pollers hit the same endpoint on different intervals and shared a cache
 * only one of them wrote. What is pinned here is the fix: concurrent reads
 * coalesce onto one request, every read warms the cache both pollers see, and
 * a failed read leaves what was already there alone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  cacheDocuments,
  cachedDocuments,
  clearDocumentCache,
  hasPendingIngest,
  refreshDocuments,
} from '~/lib/stash-documents'
import type { StashDocumentMeta } from '~/lib/document-store.server'

const doc = (id: string, over: Partial<StashDocumentMeta> = {}): StashDocumentMeta =>
  ({ id, filename: `${id}.md`, ...over }) as StashDocumentMeta

let fetchMock: ReturnType<typeof vi.fn>

const listing = (docs: StashDocumentMeta[]) =>
  new Response(JSON.stringify({ documents: docs }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })

beforeEach(() => {
  clearDocumentCache()
  fetchMock = vi.fn(async () => listing([]))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearDocumentCache()
})

describe('stash-documents — the cache', () => {
  it('reads as unseen before the first fetch, which is what triggers the cold-load spinner', () => {
    expect(cachedDocuments('s1')).toBeUndefined()
  })

  it('distinguishes "no documents yet" from "never read"', async () => {
    await refreshDocuments('s1')
    expect(cachedDocuments('s1')).toEqual([])
    expect(cachedDocuments('s2')).toBeUndefined()
  })

  it('warms the cache both pollers read from — not just the caller’s', async () => {
    fetchMock.mockResolvedValue(listing([doc('a')]))
    await refreshDocuments('s1')
    expect(cachedDocuments('s1')).toEqual([doc('a')])
  })

  it('accepts a list the caller already knows to be current (an optimistic add)', () => {
    cacheDocuments('s1', [doc('a')])
    expect(cachedDocuments('s1')).toEqual([doc('a')])
  })

  it('keeps sessions apart', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      listing(url.includes('s1') ? [doc('a')] : [doc('b')]),
    )
    await refreshDocuments('s1')
    await refreshDocuments('s2')
    expect(cachedDocuments('s1')).toEqual([doc('a')])
    expect(cachedDocuments('s2')).toEqual([doc('b')])
  })
})

describe('stash-documents — single flight', () => {
  it('coalesces concurrent reads of one session onto a single request', async () => {
    let release: (r: Response) => void = () => {}
    fetchMock.mockImplementation(() => new Promise<Response>((r) => (release = r)))

    // The panel's 4s poll and the route's 3s poll, overlapping.
    const a = refreshDocuments('s1')
    const b = refreshDocuments('s1')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    release(listing([doc('a')]))
    expect(await a).toEqual([doc('a')])
    expect(await b).toEqual([doc('a')])
  })

  it('does not coalesce different sessions', () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}))
    void refreshDocuments('s1')
    void refreshDocuments('s2')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('starts a fresh request once the previous one has settled', async () => {
    await refreshDocuments('s1')
    await refreshDocuments('s1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('clears the in-flight slot after a failure, so the next poll is not wedged', async () => {
    fetchMock.mockRejectedValueOnce(new Error('offline'))
    await expect(refreshDocuments('s1')).rejects.toThrow('offline')

    fetchMock.mockResolvedValue(listing([doc('a')]))
    await expect(refreshDocuments('s1')).resolves.toEqual([doc('a')])
  })

  it('leaves the cache untouched when a read fails', async () => {
    cacheDocuments('s1', [doc('a')])
    fetchMock.mockRejectedValue(new Error('offline'))
    await expect(refreshDocuments('s1')).rejects.toThrow('offline')
    expect(cachedDocuments('s1')).toEqual([doc('a')])
  })
})

describe('stash-documents — the pending-ingest rule', () => {
  it('is true while any source is still embedding', () => {
    expect(hasPendingIngest([doc('a', { ingestStatus: 'indexed' })])).toBe(false)
    expect(
      hasPendingIngest([
        doc('a', { ingestStatus: 'indexed' }),
        doc('b', { ingestStatus: 'pending' }),
      ]),
    ).toBe(true)
  })

  it('is false for a session with no documents at all', () => {
    expect(hasPendingIngest([])).toBe(false)
  })
})
