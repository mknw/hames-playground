/**
 * Data Stash routes — the answers that are not the happy path.
 *
 * `stash-ownership.test.ts` covers who may read what; this covers what each
 * route says when the request is the caller's own but still cannot be served:
 * malformed bodies, missing documents, a binary asked to be embedded, a store
 * that is down, and the two payload shapes the viewer depends on (a converted
 * document's readable text, and a raw ?download).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

vi.mock('../../../lib/auth/server', () => ({
  getAuthenticatedUser: async () => ({ id: 'alice', email: 'alice@example.test' }),
}))
vi.mock('../../../lib/auth/dev-bypass', () => ({
  isBypassEnabled: () => false,
  BYPASS_USER: { id: 'dev-bypass-user', email: 'dev@local' },
}))

// Alice owns every session named here.
vi.mock('../../../lib/db/conversations.server', () => ({
  getConversationOwner: async () => 'alice',
}))
vi.mock('../../../lib/db/session-claims.server', () => ({
  getSessionClaimOwner: async () => 'alice',
  claimSession: async () => 'alice',
}))

interface Doc {
  id: string
  sessionId: string
  filename: string
  mimeType: string
  content: string
  encoding?: 'utf8' | 'base64'
  derivedText?: string
  ingestStatus?: 'pending' | 'indexed' | 'failed' | 'not_indexed'
  ingestError?: string
}
let doc: Doc | null = null
const storeDocument = vi.fn<(input: Record<string, unknown>) => Promise<Doc>>()
const deleteDocument = vi.fn<(...args: unknown[]) => Promise<void>>(async () => {})
const listDocuments = vi.fn(async () => [])
const setDocumentFlags = vi.fn<(...args: unknown[]) => Promise<Doc | null>>()
vi.mock('@hames-ai/harness-patterns/stash/document-store.server', () => ({
  DEFAULT_TTL_SECONDS: 604800,
  storeDocument: (...a: unknown[]) => storeDocument(...(a as [never])),
  getDocument: async () => doc,
  listDocuments: () => listDocuments(),
  deleteDocument: (...a: unknown[]) => deleteDocument(...(a as [never])),
  setDocumentFlags: (...a: unknown[]) => setDocumentFlags(...a),
  stripContent: (d: Doc) => d,
}))

const ingestStashDocument =
  vi.fn<(sessionId: string, docId: string, opts?: unknown) => Promise<{ chunks: number } | null>>()
const searchDocuments = vi.fn<() => Promise<unknown[]>>()
vi.mock('@hames-ai/harness-patterns/stash/document-ingest.server', () => ({
  searchDocuments: () => searchDocuments(),
  ingestStashDocument: (...a: unknown[]) => ingestStashDocument(...(a as [never, never])),
}))

vi.mock('../../../lib/harness-client/registry.server', () => ({
  agentUsesRedisRetriever: async () => false,
}))
vi.mock('../../../lib/harness-client/session.server', () => ({ loadSession: async () => null }))
vi.mock('@hames-ai/harness-patterns/stash/doc-convert.server', () => ({
  conversionEnabled: () => false,
  isConvertible: () => false,
}))

const upload = await import('../../../routes/api/stash/upload')
const document = await import('../../../routes/api/stash/document/[id]')
const search = await import('../../../routes/api/stash/search')
const ingest = await import('../../../routes/api/stash/ingest')

function evt(request: Request, params: Record<string, string> = {}) {
  return { params, request } as never
}
function jsonReq(url: string, body: unknown, method = 'POST'): Request {
  return new Request(url, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const textDoc = (over: Partial<Doc> = {}): Doc => ({
  id: 'doc-1',
  sessionId: 's1',
  filename: 'notes.txt',
  mimeType: 'text/plain',
  content: 'hello world',
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  doc = textDoc()
  storeDocument.mockResolvedValue(textDoc())
  ingestStashDocument.mockResolvedValue({ chunks: 3 })
  // Resolves null for an id that isn't stored — the PATCH 404 below reads that.
  setDocumentFlags.mockResolvedValue(null)
  searchDocuments.mockResolvedValue([])
})

describe('POST /api/stash/upload', () => {
  it('400s a body it cannot parse, and one with no sessionId', async () => {
    const bad = await upload.POST(evt(jsonReq('http://x/u', 'not json')))
    expect(bad.status).toBe(400)

    const noSession = await upload.POST(
      evt(jsonReq('http://x/u', { filename: 'a.txt', content: 'x' })),
    )
    expect(noSession.status).toBe(400)
    expect((await noSession.json()).error).toMatch(/sessionId/)
    expect(storeDocument).not.toHaveBeenCalled()
  })

  it('413s an oversized document and 500s any other store failure', async () => {
    storeDocument.mockRejectedValue(new Error('Document too large (12 MB > 10 MB)'))
    const tooBig = await upload.POST(
      evt(jsonReq('http://x/u', { sessionId: 's1', filename: 'big.txt', content: 'x' })),
    )
    expect(tooBig.status).toBe(413)

    storeDocument.mockRejectedValue(new Error('redis down'))
    const broken = await upload.POST(
      evt(jsonReq('http://x/u', { sessionId: 's1', filename: 'a.txt', content: 'x' })),
    )
    expect(broken.status).toBe(500)
    expect((await broken.json()).error).toBe('redis down')
  })

  it('does not mark an upload as embedding when no retriever agent is behind it', async () => {
    const res = await upload.POST(
      evt(jsonReq('http://x/u', { sessionId: 's1', filename: 'a.txt', content: 'x' })),
    )
    expect(res.status).toBe(201)
    expect(storeDocument.mock.calls[0][0]).not.toHaveProperty('ingestStatus')
  })

  it('400s a list with no sessionId', async () => {
    const res = await upload.GET(evt(new Request('http://x/api/stash/upload')))
    expect(res.status).toBe(400)
    expect(listDocuments).not.toHaveBeenCalled()
  })
})

describe('GET /api/stash/document/:id', () => {
  it('400s without a sessionId and 404s a document that is not there', async () => {
    expect((await document.GET(evt(new Request('http://x/d'), { id: 'doc-1' }))).status).toBe(400)

    doc = null
    const missing = await document.GET(evt(new Request('http://x/d?sessionId=s1'), { id: 'doc-1' }))
    expect(missing.status).toBe(404)
  })

  it('serves a converted document’s readable text, not its base64 original', async () => {
    doc = textDoc({
      filename: 'report.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      content: Buffer.from('PK-zip-bytes').toString('base64'),
      encoding: 'base64',
      derivedText: '# Report\n\nBody text.',
    })
    const res = await document.GET(evt(new Request('http://x/d?sessionId=s1'), { id: 'doc-1' }))
    const body = await res.json()

    // Citations index into this text, so it is what the viewer must receive.
    expect(body.document.content).toBe('# Report\n\nBody text.')
    expect(body.document.encoding).toBe('utf8')
    // ...and the heavy blob + duplicate field are dropped from the payload.
    expect(body.document).not.toHaveProperty('derivedText')
  })

  it('decodes a binary download back to bytes and names the file', async () => {
    doc = textDoc({
      filename: 'memo.m4a',
      mimeType: 'audio/mp4',
      content: Buffer.from('BYTES').toString('base64'),
      encoding: 'base64',
    })
    const res = await document.GET(
      evt(new Request('http://x/d?sessionId=s1&download'), { id: 'doc-1' }),
    )

    expect(await res.text()).toBe('BYTES')
    expect(res.headers.get('Content-Type')).toBe('audio/mp4')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="memo.m4a"')
    expect(res.headers.get('Content-Length')).toBe('5')
  })

  it('strips quotes and newlines out of the download filename', async () => {
    doc = textDoc({ filename: 'we"ird\nname.txt' })
    const res = await document.GET(
      evt(new Request('http://x/d?sessionId=s1&download'), { id: 'doc-1' }),
    )
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="weirdname.txt"')
  })

  it('falls back to a generic content type when the document has none', async () => {
    doc = textDoc({ mimeType: '' })
    const res = await document.GET(
      evt(new Request('http://x/d?sessionId=s1&download'), { id: 'doc-1' }),
    )
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
  })

  it('400s a DELETE or PATCH that names no session', async () => {
    const del = await document.DELETE(
      evt(new Request('http://x/d', { method: 'DELETE' }), { id: 'doc-1' }),
    )
    expect(del.status).toBe(400)

    const patch = await document.PATCH(
      evt(jsonReq('http://x/d', { hidden: true }, 'PATCH'), { id: 'doc-1' }),
    )
    expect(patch.status).toBe(400)
  })

  // sf-H4. The route answered `ok: true` unconditionally, so a rejected Redis
  // write was reported as a completed deletion.
  it('500s a DELETE whose store write failed, instead of reporting ok', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    deleteDocument.mockRejectedValueOnce(new Error('Failed to delete document doc-1: NOAUTH'))

    const res = await document.DELETE(
      evt(new Request('http://x/d?sessionId=s1', { method: 'DELETE' }), { id: 'doc-1' }),
    )

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'Failed to delete document doc-1: NOAUTH',
    })
    err.mockRestore()
  })

  it('still 200s a DELETE that succeeded', async () => {
    deleteDocument.mockResolvedValueOnce(undefined)
    const res = await document.DELETE(
      evt(new Request('http://x/d?sessionId=s1', { method: 'DELETE' }), { id: 'doc-1' }),
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('400s a PATCH body that is not JSON, and 404s a flag edit on a missing document', async () => {
    const malformed = await document.PATCH(
      evt(jsonReq('http://x/d', 'not json', 'PATCH'), { id: 'doc-1' }),
    )
    expect(malformed.status).toBe(400)

    // setDocumentFlags resolves null for an id that isn't stored.
    const missing = await document.PATCH(
      evt(jsonReq('http://x/d', { sessionId: 's1', hidden: true }, 'PATCH'), { id: 'ghost' }),
    )
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'Document not found' })
  })
})

describe('GET /api/stash/search', () => {
  it('400s without a sessionId or query', async () => {
    expect((await search.GET(evt(new Request('http://x/s?sessionId=s1')))).status).toBe(400)
    expect((await search.GET(evt(new Request('http://x/s?q=hello')))).status).toBe(400)
    expect(searchDocuments).not.toHaveBeenCalled()
  })

  it('ignores a non-numeric k rather than failing the search', async () => {
    const res = await search.GET(evt(new Request('http://x/s?sessionId=s1&q=hi&k=lots')))
    expect(res.status).toBe(200)
    expect(searchDocuments).toHaveBeenCalledTimes(1)
  })

  it('500s with the backend’s reason when the embedding server is unreachable', async () => {
    searchDocuments.mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:8090'))
    const res = await search.GET(evt(new Request('http://x/s?sessionId=s1&q=hi')))
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/ECONNREFUSED/)
  })
})

describe('POST /api/stash/ingest', () => {
  // The flag write finds the document, as it does in the store.
  beforeEach(() => {
    setDocumentFlags.mockImplementation(async () => doc)
  })

  const post = (body: unknown) => ingest.POST(evt(jsonReq('http://x/i', body)))
  /** Let the ingest the route started after answering settle. */
  const settled = () => new Promise((r) => setTimeout(r, 0))

  it('400s a body that is not JSON, or one missing docId', async () => {
    expect((await post('not json')).status).toBe(400)

    const noDoc = await post({ sessionId: 's1' })
    expect(noDoc.status).toBe(400)
    expect(ingestStashDocument).not.toHaveBeenCalled()
  })

  it('404s a document that is not in the session', async () => {
    doc = null
    const res = await post({ sessionId: 's1', docId: 'ghost' })
    expect(res.status).toBe(404)
    expect(ingestStashDocument).not.toHaveBeenCalled()
  })

  // The store keys a lookup by the session it names, so this is a second line:
  // a record that says it belongs to another session is refused before ingest,
  // which would index it under THAT session. MUTATION: drop the
  // `doc.sessionId !== sessionId` clause → 202 and an ingest of s2's copy.
  it("404s a record that names another session, the caller's own session notwithstanding", async () => {
    doc = textDoc({ sessionId: 's2' })
    const res = await post({ sessionId: 's1', docId: 'doc-1' })
    expect(res.status).toBe(404)
    expect(setDocumentFlags).not.toHaveBeenCalled()
    expect(ingestStashDocument).not.toHaveBeenCalled()
  })

  it('415s a binary document — embedding raw bytes would index garbage', async () => {
    doc = textDoc({ encoding: 'base64', content: 'QkxPQg==' })
    const res = await post({ sessionId: 's1', docId: 'doc-1' })

    expect(res.status).toBe(415)
    expect((await res.json()).error).toMatch(/binary/)
    expect(ingestStashDocument).not.toHaveBeenCalled()
  })

  // The panel's "Index for search" (#832) reads `pending` → `indexed` off the
  // document, and only a stored status says so. MUTATIONS: drop the pending
  // write → no flag call; move it after the ingest starts → order reversed; call
  // `ingestDocument(doc, …)` as the route used to → no status-tracked run.
  it('stores pending before answering, then runs the status-tracked ingest', async () => {
    const res = await post({ sessionId: 's1', docId: 'doc-1' })
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ ok: true, docId: 'doc-1', ingestStatus: 'pending' })
    expect(setDocumentFlags).toHaveBeenCalledWith('s1', 'doc-1', {
      ingestStatus: 'pending',
      ingestError: null,
    })
    expect(ingestStashDocument).toHaveBeenCalledTimes(1)
    expect(setDocumentFlags.mock.invocationCallOrder[0]).toBeLessThan(
      ingestStashDocument.mock.invocationCallOrder[0],
    )
  })

  // The server decides the embedder, as upload and the retriever's safety net do:
  // an `embedding` from the body would have the app post the document's text to
  // the caller's `baseUrl` with the caller's key, past the boot refusal of an
  // untrusted embedder (#836 security review). MUTATION: hand the body's
  // `chunk` / `embedding` / `allowSpaceChange` to the ingest again → red.
  it('indexes with the server’s own embedder, whatever the body asks for', async () => {
    const res = await post({
      sessionId: 's1',
      docId: 'doc-1',
      chunk: { size: 400 },
      embedding: { provider: 'local', baseUrl: 'https://collector.example/v1', apiKey: 'k' },
      allowSpaceChange: true,
    })
    expect(res.status).toBe(202)
    expect(ingestStashDocument.mock.calls).toEqual([['s1', 'doc-1']])
  })

  // One run per copy (#836 reviews): a click on a copy whose run is in flight, or
  // that is already searchable, starts nothing and writes nothing. MUTATIONS: drop
  // the `pending` guard → a second ingest and a fresh `pending` write; drop the
  // `indexed` guard → a re-ingest of a searchable copy.
  it.each([
    ['pending', 202],
    ['indexed', 200],
  ] as const)('starts no second run for a copy already %s', async (ingestStatus, status) => {
    doc = textDoc({ ingestStatus })
    const res = await post({ sessionId: 's1', docId: 'doc-1' })
    expect(res.status).toBe(status)
    expect(await res.json()).toEqual({ ok: true, docId: 'doc-1', ingestStatus })
    expect(setDocumentFlags).not.toHaveBeenCalled()
    expect(ingestStashDocument).not.toHaveBeenCalled()
  })

  // The retry the panel offers: a failed copy is indexed again. MUTATION: refuse
  // every copy that has a status → no retry.
  it('runs again for a copy whose index failed', async () => {
    doc = textDoc({ ingestStatus: 'failed', ingestError: 'embedder offline' })
    expect((await post({ sessionId: 's1', docId: 'doc-1' })).status).toBe(202)
    expect(ingestStashDocument).toHaveBeenCalledTimes(1)
  })

  it('500s with the reason when pending cannot be stored, and starts no ingest', async () => {
    setDocumentFlags.mockRejectedValue(new Error('Failed to update document: READONLY'))
    const res = await post({ sessionId: 's1', docId: 'doc-1' })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toMatch(/READONLY/)
    expect(ingestStashDocument).not.toHaveBeenCalled()
  })

  it('404s a document deleted between the lookup and the pending write', async () => {
    setDocumentFlags.mockResolvedValue(null)
    const res = await post({ sessionId: 's1', docId: 'doc-1' })
    expect(res.status).toBe(404)
    expect(ingestStashDocument).not.toHaveBeenCalled()
  })

  // The ingest is documented not to throw; if it does, the `pending` the route
  // stored must not stand as an "embedding…" that never ends. MUTATION: drop the
  // failure write from the route's `.catch` → the document stays pending.
  it('records a failure when the ingest throws anyway, so "embedding…" ends', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    ingestStashDocument.mockRejectedValue(new Error('gateway closed'))
    expect((await post({ sessionId: 's1', docId: 'doc-1' })).status).toBe(202)
    await settled()
    expect(setDocumentFlags).toHaveBeenLastCalledWith('s1', 'doc-1', {
      ingestStatus: 'failed',
      ingestError: 'gateway closed',
    })
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })
})
