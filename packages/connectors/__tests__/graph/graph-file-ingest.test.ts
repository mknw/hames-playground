/**
 * `graph_file_ingest` — the Microsoft Graph → Data Stash bridge (#110).
 *
 * Covers the contract the model and the stash both depend on: metadata before
 * download (so the size guard can refuse first), text vs. binary storage, an
 * index outcome that says whether the copy is SEARCHABLE (#420), a fail-closed
 * refusal without a conversation in scope, and no credential/session field in
 * the advertised schema.
 *
 * Moved co-located with the module (#225 PR-C2): the stash is now the injected
 * `stash` seam rather than two mocked host modules, and the GraphAuthRequired
 * Error is the REAL package class (the package owns it — `instanceof` is not a
 * mock artifact any more).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildGraphHarness, MAX_CONTENT_BYTES } from './harness'
import { GraphAuthRequiredError } from '../../graph/graph-auth'
import {
  driveItemPath,
  INGEST_OUTCOME_WAIT_MS,
  shapeDriveItem,
} from '../../graph/graph-tools.server'

const h = buildGraphHarness()
const { runAppTool, appToolDescriptions } = h
const graphFetch = h.graphFetch
// The stash seam's two halves — what the app-side tests reached through
// mocked host modules (`document-store.server` / `document-ingest.server`).
const storeDocument = h.stash.storeDocument
const ingestStashDocument = h.stash.ingest

interface IngestResultShape {
  documentId: string
  filename: string
  mimeType: string
  size: number
  ingesting: boolean
  indexStatus: 'indexed' | 'pending' | 'failed' | 'not_indexed'
  indexError?: string
  webUrl: string | null
}

/** Graph answers metadata first, then content — in that order. */
function graphAnswers(
  meta: Record<string, unknown>,
  content = Buffer.from('hello stash').toString('base64'),
) {
  graphFetch.mockReset()
  graphFetch.mockImplementation(async (_userId: string, path: string) =>
    path.endsWith('/content') ? content : meta,
  )
}

const FILE_META = {
  name: 'notes.md',
  file: { mimeType: 'text/markdown' },
  size: 11,
  webUrl: 'https://contoso.sharepoint.com/notes.md',
}

beforeEach(() => {
  h.restoreDefaults()
})

describe('advertisement', () => {
  it('registers graph_file_ingest with no credential/user/session field', () => {
    const def = appToolDescriptions().find((t) => t.name === 'graph_file_ingest')
    expect(def).toBeDefined()
    const schema = JSON.stringify(def!.inputSchema).toLowerCase()
    for (const bad of ['token', 'credential', 'secret', 'userid', 'user_id', 'session', 'oid']) {
      expect(schema, `schema leaks ${bad}`).not.toContain(bad)
    }
    expect(def!.inputSchema).toMatchObject({ required: ['item_id'] })
  })
})

describe('driveItemPath', () => {
  it("defaults to the caller's own drive and encodes ids", () => {
    expect(driveItemPath('01ABC')).toBe('/me/drive/items/01ABC')
    expect(driveItemPath('a/../b')).toBe('/me/drive/items/a%2F..%2Fb')
  })

  it('targets a named drive when given one', () => {
    expect(driveItemPath('01ABC', 'b!drive')).toBe('/drives/b!drive/items/01ABC')
  })
})

describe('shapeDriveItem', () => {
  it('reads name/mime/size/webUrl and flags files vs folders', () => {
    expect(shapeDriveItem(FILE_META)).toEqual({
      name: 'notes.md',
      mimeType: 'text/markdown',
      size: 11,
      webUrl: 'https://contoso.sharepoint.com/notes.md',
      isFile: true,
    })
    expect(shapeDriveItem({ name: 'Docs', folder: { childCount: 3 } }).isFile).toBe(false)
    expect(shapeDriveItem(null)).toMatchObject({ name: null, size: null, isFile: false })
  })
})

describe('happy path', () => {
  it('reads metadata with an explicit $select, then downloads as base64', async () => {
    graphAnswers(FILE_META)
    const res = await runAppTool('graph_file_ingest', { item_id: '01ABC' })
    expect(res.success).toBe(true)

    const [metaCall, contentCall] = graphFetch.mock.calls as Array<
      [string, string, { scopes?: string[]; responseType?: string }]
    >
    expect(metaCall[0]).toBe('oid-1') // scoped user, never an argument
    expect(metaCall[1]).toBe('/me/drive/items/01ABC?$select=name,file,size,webUrl')
    expect(metaCall[2].scopes).toEqual(['Files.Read.All'])
    expect(metaCall[2].responseType).toBeUndefined()

    expect(contentCall[1]).toBe('/me/drive/items/01ABC/content')
    expect(contentCall[2].responseType).toBe('base64')
    expect(contentCall[2].scopes).toEqual(['Files.Read.All'])
  })

  it('stores text formats as UTF-8 and reports the ingest that indexed it', async () => {
    graphAnswers(FILE_META)
    const res = await runAppTool('graph_file_ingest', { item_id: '01ABC' })

    expect(storeDocument).toHaveBeenCalledWith({
      sessionId: 'sess-1', // from request scope
      filename: 'notes.md',
      mimeType: 'text/markdown',
      content: 'hello stash', // decoded, not base64
      ingestStatus: 'pending',
    })
    await vi.waitFor(() => expect(ingestStashDocument).toHaveBeenCalledWith('sess-1', 'doc-1'))

    expect(res.data).toEqual<IngestResultShape>({
      documentId: 'doc-1',
      filename: 'notes.md',
      mimeType: 'text/markdown',
      size: 11,
      ingesting: true,
      indexStatus: 'indexed',
      webUrl: 'https://contoso.sharepoint.com/notes.md',
    })
    // The bytes never travel back to the model.
    expect(JSON.stringify(res.data)).not.toContain('hello stash')
  })

  it('keeps a non-convertible binary as base64 and does NOT ingest it', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64')
    graphAnswers({ name: 'chart.png', file: { mimeType: 'image/png' }, size: 4 }, png)

    const res = await runAppTool('graph_file_ingest', { item_id: '01PNG' })
    expect(storeDocument).toHaveBeenCalledWith({
      sessionId: 'sess-1',
      filename: 'chart.png',
      mimeType: 'image/png',
      content: png,
      encoding: 'base64',
    })
    // Ingest would only mark it 'failed' (no converter for images).
    expect(ingestStashDocument).not.toHaveBeenCalled()
    expect((res.data as IngestResultShape).ingesting).toBe(false)
    expect((res.data as IngestResultShape).indexStatus).toBe('not_indexed')
  })

  it('ingests a convertible binary (docx) when the converter is enabled', async () => {
    // The host's conversionEnabled reads STASH_CONVERT_DOCS; on the seam it
    // is the injected supplier, so "the converter is enabled" is a mock return.
    h.content.conversionEnabled.mockReturnValue(true)
    const docx = Buffer.from([0x50, 0x4b, 0x03, 0x04]) /* "PK" + zip magic */
      .toString('base64')
    graphAnswers(
      {
        name: 'spec.docx',
        file: {
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        },
        size: 4,
      },
      docx,
    )

    const res = await runAppTool('graph_file_ingest', { item_id: '01DOCX' })
    expect(storeDocument).toHaveBeenCalledWith(
      expect.objectContaining({ encoding: 'base64', ingestStatus: 'pending' }),
    )
    await vi.waitFor(() => expect(ingestStashDocument).toHaveBeenCalledWith('sess-1', 'doc-1'))
    expect((res.data as IngestResultShape).ingesting).toBe(true)
  })

  it('honours a drive_id and a filename override, and falls back on a missing MIME', async () => {
    graphAnswers({ name: 'raw', file: {}, size: 11 })
    const res = await runAppTool('graph_file_ingest', {
      item_id: '01ABC',
      drive_id: 'drive-9',
      filename: 'renamed.csv',
    })
    expect(graphFetch.mock.calls[0][1]).toContain('/drives/drive-9/items/01ABC')
    expect((res.data as IngestResultShape).filename).toBe('renamed.csv')
    // No file.mimeType → guessed from the (overridden) filename.
    expect((res.data as IngestResultShape).mimeType).toBe('text/csv')
  })
})

// #420: the copy-to-stash path used to answer `ingesting: true` at once and
// let the index run fail later, where only the server log saw it — an embedder
// that was not running looked exactly like success to the agent and the person.
describe('index outcome (#420)', () => {
  const data = async () =>
    (await runAppTool('graph_file_ingest', { item_id: '01ABC' })).data as IngestResultShape

  // Mutation: report `indexStatus: 'indexed'` whenever `ingesting` is true
  // (i.e. ignore the bridge's outcome) → reds here.
  it('a failed index run is reported as stored-but-not-searchable, with its reason', async () => {
    graphAnswers(FILE_META)
    ingestStashDocument.mockResolvedValue({
      status: 'failed',
      error: 'Embedding request to local failed: fetch failed',
    })
    const res = await runAppTool('graph_file_ingest', { item_id: '01ABC' })
    // Stored — the tool did its job, so it is not a failed call.
    expect(res.success).toBe(true)
    expect(res.data).toMatchObject({
      documentId: 'doc-1',
      ingesting: true,
      indexStatus: 'failed',
      indexError: 'Embedding request to local failed: fetch failed',
    })
  })

  // Mutation: let the rejection propagate (drop the `.then` rejection handler)
  // → the tool call fails although the file was stored.
  it('a bridge that rejects is a failed index, not a failed copy', async () => {
    graphAnswers(FILE_META)
    ingestStashDocument.mockRejectedValue(new Error('redis went away'))
    const res = await runAppTool('graph_file_ingest', { item_id: '01ABC' })
    expect(res.success).toBe(true)
    expect(res.data).toMatchObject({ indexStatus: 'failed', indexError: 'redis went away' })
  })

  // Mutation: call `stash.ingest(...)` directly instead of through
  // `Promise.resolve().then(...)` → the synchronous throw escapes the tool.
  it('a bridge that throws synchronously is a failed index too', async () => {
    graphAnswers(FILE_META)
    ingestStashDocument.mockImplementation(() => {
      throw new Error('bridge not ready')
    })
    const res = await runAppTool('graph_file_ingest', { item_id: '01ABC' })
    expect(res.success).toBe(true)
    expect(res.data).toMatchObject({ indexStatus: 'failed', indexError: 'bridge not ready' })
  })

  // Mutation: a failed outcome with no `error` reported as `failed` with no
  // `indexError` → the model has nothing to tell the person.
  it('names a missing reason rather than omitting it', async () => {
    graphAnswers(FILE_META)
    ingestStashDocument.mockResolvedValue({ status: 'failed' })
    expect(await data()).toMatchObject({
      indexStatus: 'failed',
      indexError: expect.stringMatching(/no reason/),
    })
  })

  // Mutation: drop the timer from the race (await the run alone) → the tool
  // hangs on a slow run instead of answering `pending`.
  // Mutation: resolve the bound with 'indexed' → reds on the status.
  it('a run still going at the bound is reported pending, and keeps going', async () => {
    vi.useFakeTimers()
    try {
      graphAnswers(FILE_META)
      let finish: (v: unknown) => void = () => {}
      ingestStashDocument.mockImplementation(() => new Promise((r) => (finish = r)))
      const call = runAppTool('graph_file_ingest', { item_id: '01ABC' })
      await vi.advanceTimersByTimeAsync(INGEST_OUTCOME_WAIT_MS)
      const res = await call
      expect(res.data).toMatchObject({ ingesting: true, indexStatus: 'pending' })
      expect(res.data).not.toHaveProperty('indexError')
      // The run was not cancelled: it is the same promise, still settleable.
      finish({ status: 'indexed' })
    } finally {
      vi.useRealTimers()
    }
  })

  // Mutation: `INGEST_OUTCOME_WAIT_MS = 0` → a run that ends just inside the
  // bound is reported pending.
  it('a run that ends inside the bound is reported as it ended', async () => {
    vi.useFakeTimers()
    try {
      graphAnswers(FILE_META)
      ingestStashDocument.mockImplementation(
        () =>
          new Promise((r) =>
            setTimeout(() => r({ status: 'indexed' }), INGEST_OUTCOME_WAIT_MS - 1_000),
          ),
      )
      const call = runAppTool('graph_file_ingest', { item_id: '01ABC' })
      await vi.advanceTimersByTimeAsync(INGEST_OUTCOME_WAIT_MS)
      expect((await call).data).toMatchObject({ indexStatus: 'indexed' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('tells the model what each status means, in the advertised description', () => {
    const def = appToolDescriptions().find((t) => t.name === 'graph_file_ingest')!
    expect(def.description).toMatch(/indexStatus/)
    expect(def.description).toMatch(/NOT searchable/)
  })
})

describe('refusals', () => {
  it('fails closed with no conversation in scope, before touching Graph', async () => {
    h.setScope({ sessionId: null })
    graphAnswers(FILE_META)
    const res = await runAppTool('graph_file_ingest', { item_id: '01ABC' })

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/conversation/i)
    expect(graphFetch).not.toHaveBeenCalled()
    expect(storeDocument).not.toHaveBeenCalled()
  })

  it('rejects an oversized file without downloading it', async () => {
    graphAnswers({ ...FILE_META, name: 'huge.csv', size: MAX_CONTENT_BYTES + 1 })
    const res = await runAppTool('graph_file_ingest', { item_id: '01BIG' })

    expect(res.success).toBe(false)
    expect(res.error).toMatch(/above the Data Stash limit/i)
    // Metadata only — the content call never happened.
    expect(graphFetch).toHaveBeenCalledTimes(1)
    expect(storeDocument).not.toHaveBeenCalled()
  })

  it('accepts a file exactly at the limit', async () => {
    graphAnswers({ ...FILE_META, size: MAX_CONTENT_BYTES })
    const res = await runAppTool('graph_file_ingest', { item_id: '01EDGE' })
    expect(res.success).toBe(true)
    expect(graphFetch).toHaveBeenCalledTimes(2)
  })

  it('proceeds when Graph reports no size (the store re-checks the limit)', async () => {
    graphAnswers({ name: 'notes.md', file: { mimeType: 'text/markdown' } })
    const res = await runAppTool('graph_file_ingest', { item_id: '01NOSIZE' })
    expect(res.success).toBe(true)
    expect(storeDocument).toHaveBeenCalled()
  })

  it('refuses a folder (no file facet) instead of downloading nothing', async () => {
    graphAnswers({ name: 'Reports', folder: { childCount: 2 } })
    const res = await runAppTool('graph_file_ingest', { item_id: '01FOLDER' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/no file content|folder/i)
    expect(graphFetch).toHaveBeenCalledTimes(1)
  })

  it('requires item_id', async () => {
    const res = await runAppTool('graph_file_ingest', { item_id: '  ' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/item_id is required/i)
    expect(graphFetch).not.toHaveBeenCalled()
  })

  it('surfaces a sign-in-needed failure as a failed result, not a throw', async () => {
    graphFetch.mockReset()
    graphFetch.mockRejectedValue(new Error('sign in to connect Microsoft 365'))
    const res = await runAppTool('graph_file_ingest', { item_id: '01ABC' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/sign in/i)
    expect(res.data).toBeNull()
  })

  it("a 403 says re-auth won't help (SharePoint Embedded / Loop), NOT 'sign in'", async () => {
    // graphFetch's generic 403 message suggests a consent problem; for a
    // driveItem it almost always means a SharePoint Embedded container (#137),
    // where signing in again cannot help. The tool must not parrot bad advice.
    graphFetch.mockReset()
    graphFetch.mockRejectedValue(
      new GraphAuthRequiredError('Microsoft Graph denied the request (403)', 'oid-1', 403),
    )
    const res = await runAppTool('graph_file_ingest', { item_id: '01LOOP' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Loop|SharePoint Embedded/)
    expect(res.error).toMatch(/#137/)
    expect(res.error).toMatch(/signing in again will not help/i)
    expect(res.error).not.toMatch(/may lack consent for this scope/)
  })

  it('a 401 keeps the sign-in advice (expired token IS a re-auth case)', async () => {
    graphFetch.mockReset()
    graphFetch.mockRejectedValue(
      new GraphAuthRequiredError(
        'Microsoft Graph denied the request (401) — the account may lack consent for this scope.',
        'oid-1',
        401,
      ),
    )
    const res = await runAppTool('graph_file_ingest', { item_id: '01ABC' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/may lack consent/)
    expect(res.error).not.toMatch(/#137/)
  })

  it("reports a content response that isn't bytes", async () => {
    graphFetch.mockReset()
    graphFetch.mockImplementation(async (_u: string, path: string) =>
      path.endsWith('/content') ? null : FILE_META,
    )
    const res = await runAppTool('graph_file_ingest', { item_id: '01ABC' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/no content/i)
    expect(storeDocument).not.toHaveBeenCalled()
  })
})
