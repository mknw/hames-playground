/**
 * api-client — the client → REST seam (#226 B4).
 *
 * Before this module the same nine calls were hand-rolled at four call sites,
 * so "what does a 500 mean here" was answered nine times and nowhere. These
 * tests pin the two things a caller depends on: the exact request that goes on
 * the wire (method, URL, encoding), and what a non-OK status turns into —
 * including the three messages that are load-bearing because a user reads them
 * verbatim.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  API,
  ApiError,
  applyToolResultAction,
  deleteStashDocument,
  getStashDocument,
  listStashDocuments,
  openChatStream,
  patchStashDocument,
  ptyStreamUrl,
  resizePty,
  sendPtyInput,
  stashDocumentDownloadUrl,
  uploadStashDocument,
} from '~/lib/api-client'
import type { HarnessSettings } from '~/lib/settings'
import type { StashDocumentMeta } from '~/lib/document-store.server'

let fetchMock: ReturnType<typeof vi.fn>

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

/** The last request, as (url, init). */
const lastCall = () => fetchMock.mock.calls.at(-1) as [string, RequestInit | undefined]
const lastBody = () => JSON.parse(lastCall()[1]!.body as string)

const doc = (over: Partial<StashDocumentMeta> = {}): StashDocumentMeta =>
  ({ id: 'd1', filename: 'notes.md', ...over }) as StashDocumentMeta

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse({}))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('api-client — chat stream', () => {
  it('POSTs the turn and hands back the raw response for the caller to iterate', async () => {
    const streamed = new Response('event: done\ndata: {}\n\n', { status: 200 })
    fetchMock.mockResolvedValue(streamed)
    const signal = new AbortController().signal

    const response = await openChatStream(
      {
        sessionId: 's1',
        message: 'hello',
        agentId: 'search',
        settings: { maxConcurrentRuns: 3 } as unknown as HarnessSettings,
      },
      signal,
    )

    expect(response).toBe(streamed)
    const [url, init] = lastCall()
    expect(url).toBe(API.events)
    expect(init!.method).toBe('POST')
    expect(init!.signal).toBe(signal)
    expect(lastBody()).toEqual({
      sessionId: 's1',
      message: 'hello',
      agentId: 'search',
      settings: { maxConcurrentRuns: 3 },
    })
  })

  it('raises the exact message the chat error bubble shows', async () => {
    fetchMock.mockResolvedValue(new Response('nope', { status: 503 }))
    await expect(
      openChatStream(
        { sessionId: 's1', message: 'x', agentId: 'a', settings: {} as HarnessSettings },
        new AbortController().signal,
      ),
    ).rejects.toThrow(new ApiError('Server error: 503', 503))
  })

  it('lets an abort propagate untouched — a torn-down stream is not an ApiError', async () => {
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'))
    await expect(
      openChatStream(
        { sessionId: 's1', message: 'x', agentId: 'a', settings: {} as HarnessSettings },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(DOMException)
  })
})

describe('api-client — tool-result stash', () => {
  it('POSTs the flag change', async () => {
    await applyToolResultAction('s1', 'e1', 'archive')
    expect(lastCall()[0]).toBe(API.toolResultStash)
    expect(lastBody()).toEqual({ sessionId: 's1', eventId: 'e1', action: 'archive' })
  })

  it('raises on a non-OK status rather than silently dropping the change', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 500 }))
    await expect(applyToolResultAction('s1', 'e1', 'hide')).rejects.toMatchObject({
      name: 'ApiError',
      status: 500,
    })
  })
})

describe('api-client — document list', () => {
  it('encodes the session id and unwraps the documents array', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ documents: [doc()] }))
    const docs = await listStashDocuments('a/b c')

    expect(lastCall()[0]).toBe(`${API.stashDocuments}?sessionId=a%2Fb%20c`)
    expect(docs).toEqual([doc()])
  })

  it('reads a non-OK status as "no documents" — both callers are polls', async () => {
    fetchMock.mockResolvedValue(new Response('boom', { status: 500 }))
    await expect(listStashDocuments('s1')).resolves.toEqual([])
  })

  it('reads a body without a documents key as empty', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    await expect(listStashDocuments('s1')).resolves.toEqual([])
  })

  it('survives a 200 whose body is not JSON at all', async () => {
    fetchMock.mockResolvedValue(new Response('<html>proxy error</html>', { status: 200 }))
    await expect(listStashDocuments('s1')).resolves.toEqual([])
  })

  it('lets a network failure through — that one is the caller’s to interpret', async () => {
    fetchMock.mockRejectedValue(new Error('offline'))
    await expect(listStashDocuments('s1')).rejects.toThrow('offline')
  })
})

describe('api-client — document upload', () => {
  const file = () => new File(['hello'], 'notes.md', { type: 'text/markdown' })

  it('POSTs multipart with the session, the agent and the file', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, document: doc() }, 201))
    const stored = await uploadStashDocument({ sessionId: 's1', agentId: 'kg', file: file() })

    const [url, init] = lastCall()
    expect(url).toBe(API.stashDocuments)
    expect(init!.method).toBe('POST')
    const form = init!.body as FormData
    expect(form.get('sessionId')).toBe('s1')
    expect(form.get('agentId')).toBe('kg')
    expect((form.get('file') as File).name).toBe('notes.md')
    expect(stored).toEqual(doc())
  })

  it('omits agentId entirely when there is none', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true }, 201))
    await uploadStashDocument({ sessionId: 's1', file: file() })
    expect((lastCall()[1]!.body as FormData).has('agentId')).toBe(false)
  })

  it('surfaces the server’s own message, which the upload zone shows verbatim', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'File too large' }, 413))
    await expect(uploadStashDocument({ sessionId: 's1', file: file() })).rejects.toThrow(
      'File too large',
    )
  })

  it('falls back to a status-bearing message when the server explains nothing', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 500 }))
    await expect(uploadStashDocument({ sessionId: 's1', file: file() })).rejects.toThrow(
      'Upload failed (500)',
    )
  })
})

describe('api-client — one document', () => {
  it('GETs the document scoped to its session and unwraps it', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ document: { content: 'hi', encoding: 'utf8' } }))
    const body = await getStashDocument('d/1', 's1')

    expect(lastCall()[0]).toBe('/api/stash/document/d%2F1?sessionId=s1')
    expect(body).toEqual({ content: 'hi', encoding: 'utf8' })
  })

  it('resolves undefined when the route returns no document', async () => {
    fetchMock.mockResolvedValue(jsonResponse({}))
    await expect(getStashDocument('d1', 's1')).resolves.toBeUndefined()
  })

  it('raises the bare `HTTP <status>` the viewer prints verbatim', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 404 }))
    await expect(getStashDocument('d1', 's1')).rejects.toThrow('HTTP 404')
  })

  it('PATCHes the flags alongside the session id', async () => {
    await patchStashDocument('d1', 's1', { archived: true, hidden: false })
    const [url, init] = lastCall()
    expect(url).toBe('/api/stash/document/d1')
    expect(init!.method).toBe('PATCH')
    expect(lastBody()).toEqual({ sessionId: 's1', archived: true, hidden: false })
  })

  it('raises the server’s message on a failed patch', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'Document not found' }, 404))
    await expect(patchStashDocument('d1', 's1', { hidden: true })).rejects.toThrow(
      'Document not found',
    )
  })

  it('DELETEs with the session in the query string', async () => {
    await deleteStashDocument('d1', 's1')
    const [url, init] = lastCall()
    expect(url).toBe('/api/stash/document/d1?sessionId=s1')
    expect(init!.method).toBe('DELETE')
  })

  it('raises on a failed delete rather than leaving the optimistic removal standing', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 403 }))
    await expect(deleteStashDocument('d1', 's1')).rejects.toMatchObject({ status: 403 })
  })

  it('builds a download URL rather than fetching — the anchor click streams it', () => {
    expect(stashDocumentDownloadUrl('d 1', 's/1')).toBe(
      '/api/stash/document/d%201?sessionId=s%2F1&download',
    )
  })
})

describe('api-client — sandbox PTY', () => {
  it('POSTs the new geometry', async () => {
    await resizePty('s1', 120, 40)
    expect(lastCall()[0]).toBe(API.ptyResize)
    expect(lastBody()).toEqual({ sessionId: 's1', cols: 120, rows: 40 })
  })

  it('POSTs keystrokes', async () => {
    await sendPtyInput('s1', '')
    expect(lastCall()[0]).toBe(API.ptyInput)
    expect(lastBody()).toEqual({ sessionId: 's1', data: '' })
  })

  it('does not raise on a non-OK PTY write — the next event corrects it', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 400 }))
    await expect(resizePty('s1', 80, 24)).resolves.toBeUndefined()
    await expect(sendPtyInput('s1', 'x')).resolves.toBeUndefined()
  })

  it('builds the EventSource URL, with the agent id only when there is one', () => {
    expect(ptyStreamUrl('s 1')).toBe('/api/sandbox/pty/stream?sessionId=s%201')
    expect(ptyStreamUrl('s1', 'sandbox/x')).toBe(
      '/api/sandbox/pty/stream?sessionId=s1&agentId=sandbox%2Fx',
    )
  })
})
