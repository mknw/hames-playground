/**
 * The app's Data Stash bridge for `graph_file_ingest` (#420).
 *
 * The tool used to fire the index run and forget it, so an embedder that was
 * not running reached the server log and nothing else: the agent was told
 * `ingesting: true`, the person was told the file was copied, and neither
 * learned that it could not be searched. The bridge in `app-tools/index.server`
 * now reports how the run ENDED, with the reason the store wrote — the same
 * `ingestError` the Data Stash panel shows on the chip, not a second wording.
 *
 * Driven through the composed registry, so what is asserted is the bridge as
 * the shipped tool reaches it: Graph and the two stash modules are stubbed,
 * everything between them is real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

vi.mock('../../../lib/auth/graph-token.server', () => ({
  GraphAuthRequiredError: class GraphAuthRequiredError extends Error {},
  GRAPH_BASE: 'https://graph.microsoft.com/v1.0',
  DEFAULT_GRAPH_SCOPES: ['User.Read'],
  // Metadata first, then the bytes — the order the tool asks in.
  graphFetch: async (_userId: string, path: string) =>
    path.endsWith('/content')
      ? Buffer.from('quarterly notes').toString('base64')
      : { name: 'notes.md', file: { mimeType: 'text/markdown' }, size: 15, webUrl: null },
}))

const ingestStashDocument = vi.fn<(sessionId: string, docId: string) => Promise<unknown>>()
vi.mock('@hames-ai/harness-patterns/stash/document-ingest.server', () => ({
  ingestStashDocument: (sessionId: string, docId: string) => ingestStashDocument(sessionId, docId),
}))

const getDocument = vi.fn<(sessionId: string, docId: string) => Promise<unknown>>()
vi.mock('@hames-ai/harness-patterns/stash/document-store.server', () => ({
  MAX_CONTENT_BYTES: 5 * 1024 * 1024,
  storeDocument: async () => ({ id: 'doc-1', size: 15 }),
  getDocument: (sessionId: string, docId: string) => getDocument(sessionId, docId),
}))

import { runWithRequestContext } from '../../../lib/harness-client/request-user.server'
import { runAppTool } from '../../../lib/app-tools/index.server'

const ingest = () =>
  runWithRequestContext({ userId: 'oid-1', sessionId: 'sess-1' }, () =>
    runAppTool('graph_file_ingest', { item_id: '01ABC' }),
  )

beforeEach(() => {
  ingestStashDocument.mockReset()
  getDocument.mockReset()
})

describe('graph_file_ingest through the app bridge (#420)', () => {
  it('reports a run that indexed as searchable, without re-reading the document', async () => {
    ingestStashDocument.mockResolvedValue({ docId: 'doc-1', chunks: 1 })

    const res = await ingest()

    expect(res.success).toBe(true)
    expect(res.data).toMatchObject({ ingesting: true, indexStatus: 'indexed' })
    expect(ingestStashDocument).toHaveBeenCalledWith('sess-1', 'doc-1')
    // The read-back is the failure path's alone.
    expect(getDocument).not.toHaveBeenCalled()
  })

  // Mutation: return `{ status: 'failed' }` without reading the document back
  // → `indexError` is the generic "no reason" and the chip's reason is lost.
  it('reports a failed run with the reason the store RECORDED', async () => {
    ingestStashDocument.mockResolvedValue(null)
    getDocument.mockResolvedValue({
      id: 'doc-1',
      ingestStatus: 'failed',
      ingestError:
        'Embedding request to local failed: fetch failed (is llama-server --embedding running at http://localhost:8090/v1?)',
    })

    const res = await ingest()

    // Stored — the copy worked, so this is not a failed tool call.
    expect(res.success).toBe(true)
    expect(res.data).toMatchObject({
      indexStatus: 'failed',
      indexError: expect.stringContaining('Embedding request to local failed'),
    })
  })

  // A run that failed but could not write its status (the store still says
  // 'pending', and holds no reason). The tool reports any non-indexed outcome
  // as failed on its own (`graph-file-ingest.test.ts`), so what this pins is
  // the bridge's half: it says the reason is missing rather than inventing one.
  it('a failed run whose reason was never recorded says so', async () => {
    ingestStashDocument.mockResolvedValue(null)
    getDocument.mockResolvedValue({ id: 'doc-1', ingestStatus: 'pending' })

    const res = await ingest()

    expect(res.data).toMatchObject({
      indexStatus: 'failed',
      indexError: 'the reason was not recorded',
    })
  })

  it('says so when the document vanished before the run read it', async () => {
    ingestStashDocument.mockResolvedValue(null)
    getDocument.mockResolvedValue(null)

    const res = await ingest()

    expect(res.data).toMatchObject({
      indexStatus: 'failed',
      indexError: 'the document is no longer in the Data Stash',
    })
  })
})
