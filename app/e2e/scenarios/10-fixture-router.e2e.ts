/**
 * The fixture-router tests (#433 S9): the two fakes this layer gained for the
 * HITL scenarios, tested as fakes.
 *
 * `lib/fake-graph.ts` answers the `graphFetch` seam from `fixtures/graph/`, and
 * `lib/fake-converter.ts` answers `DOC_CONVERT_URL` from
 * `fixtures/converter/`. Both are a fidelity liability by construction
 * (Decision 14 on #433), so this file pins the two properties that keep the
 * liability bounded:
 *
 *   - **They fail closed.** A request no fixture models is an error that names
 *     what was refused, and it is recorded, so a scenario can fail on it. The
 *     sharpest form of that is the first describe's last test: through the real
 *     tool code, an unmodelled call has to come back as a FAILED tool result,
 *     because a router that answered `{ value: [] }` would make the calendar
 *     tool report an empty day, a wrong answer that reads as a right one.
 *   - **What they do answer is what the real code reads.** The Graph fixtures
 *     go through the REAL `@hames-ai/connectors` tools (shaping, size guard,
 *     403 translation), and the converter is driven through the production
 *     client, `convertToMarkdown`. A fixture the real code cannot read is red
 *     here, before a HITL scenario three files later fails on it.
 *
 * Nothing here needs Postgres or a turn: the Graph tests compose the tools over
 * a fake of their own, and the converter tests start a converter of their own.
 * The last describe checks the wiring `bootApp` does, and that is the only part
 * that boots the app.
 */
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { bootApp, type AppHandles } from '../lib/app'
import {
  composeGraphTools,
  createFakeGraph,
  fixtureFile,
  GRAPH_BASE,
  type FakeGraph,
} from '../lib/fake-graph'
import { startFakeConverter, type FakeConverter } from '../lib/fake-converter'
import type { AppToolRegistry } from '@hames-ai/connectors/app-tools/registry'
import type {
  GraphFetchInit,
  GraphStashBridge,
  GraphStashDocumentInput,
} from '@hames-ai/connectors/graph/graph-tools.server'

const USER = 'e2e-fixture-router-user'
const SESSION = 'e2e-fixture-router-session'
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const ME_DRIVE = 'b!e2e-onedrive-synthetic-user'
const FABRIKAM_DRIVE = 'b!e2e-drive-fabrikam-sender'
const SITE_DRIVE = 'b!e2e-drive-contoso-site'

type Json = Record<string, unknown>

/** A Data Stash that keeps what it is given, so a test can read the bytes. */
function recordingStash(): { stash: GraphStashBridge; stored: GraphStashDocumentInput[] } {
  const stored: GraphStashDocumentInput[] = []
  const stash: GraphStashBridge = {
    loadStore: async () => ({
      // The Data Stash's own ceiling (`MAX_CONTENT_BYTES`, 5 MiB). Not
      // imported: that module pulls the stash transport, and through it the
      // MCP client, whose gateway URL is frozen at first import.
      maxContentBytes: 5 * 1024 * 1024,
      storeDocument: async (input) => {
        stored.push(input)
        const encoding = input.encoding === 'base64' ? 'base64' : 'utf8'
        return { id: `stored-${stored.length}`, size: Buffer.from(input.content, encoding).length }
      },
    }),
    ingest: async () => ({ status: 'indexed' }),
  }
  return { stash, stored }
}

describe('the Graph fixture router', () => {
  let graph: FakeGraph
  let tools: AppToolRegistry
  let stored: GraphStashDocumentInput[]

  const run = (name: string, args: Record<string, unknown> = {}) => tools.runAppTool(name, args)
  const fetchAs = (path: string, init?: GraphFetchInit) => graph.graphFetch(USER, path, init)

  beforeAll(async () => {
    graph = createFakeGraph()
    const recording = recordingStash()
    stored = recording.stored
    tools = await composeGraphTools(graph, {
      resolveContext: { userId: () => USER, sessionId: () => SESSION },
      stash: recording.stash,
    })
  })

  beforeEach(() => {
    graph.reset()
    stored.length = 0
  })

  describe('fails closed', () => {
    it('refuses a path no route models, names the method and path, and records it', async () => {
      await expect(fetchAs('/me/calendarView?startDateTime=x')).rejects.toThrow(
        '[fake-graph] no fixture for GET /me/calendarView?startDateTime=x: no route models this path',
      )
      expect(graph.unmatched).toEqual([
        'GET /me/calendarView?startDateTime=x: no route models this path',
      ])
      expect(graph.requests).toEqual([
        { userId: USER, method: 'GET', path: '/me/calendarView?startDateTime=x', route: null },
      ])
      expect(() => graph.assertAllMatched()).toThrow(
        '1 request(s) had no fixture:\n  GET /me/calendarView',
      )
    })

    it('refuses an id no fixture holds, on a route it does model', async () => {
      await expect(fetchAs('/me/drive/items/NO-SUCH-ITEM?$select=name')).rejects.toThrow(
        `no drive item NO-SUCH-ITEM on drive ${ME_DRIVE}`,
      )
      // The external file exists, on its own drive and not on the user's.
      await expect(
        fetchAs('/me/drive/items/E2E-ITEM-EXT-DOCX/content', { responseType: 'base64' }),
      ).rejects.toThrow(`no drive item E2E-ITEM-EXT-DOCX on drive ${ME_DRIVE}`)
      await expect(fetchAs('/me/messages/NO-SUCH-MESSAGE')).rejects.toThrow(
        'no message NO-SUCH-MESSAGE',
      )
      await expect(
        fetchAs('/me/messages/E2E-MSG-INTERNAL/attachments/NO-SUCH-ATTACHMENT'),
      ).rejects.toThrow('message E2E-MSG-INTERNAL has no attachment NO-SUCH-ATTACHMENT')
      await expect(fetchAs('/me/mailFolders/sentitems/messages')).rejects.toThrow(
        'no messages are modelled in mail folder sentitems',
      )
      await expect(
        fetchAs('/me/drive/items/E2E-ITEM-FOLDER/content', { responseType: 'base64' }),
      ).rejects.toThrow('drive item E2E-ITEM-FOLDER has no content fixture')
      expect(graph.unmatched).toHaveLength(6)
    })

    it('refuses a query option, filter, expansion or order the route does not model', async () => {
      const refused: Array<[string, string]> = [
        ['/me?$expand=manager', 'query option $expand is not modelled on the me route'],
        [
          "/me/mailFolders/inbox/messages?$filter=importance eq 'high'",
          `$filter clause "importance eq 'high'" is not modelled`,
        ],
        ['/me/mailFolders/inbox/messages?$orderby=subject', '$orderby=subject is not modelled'],
        ['/me/messages/E2E-MSG-INTERNAL?$expand=extensions', '$expand=extensions is not modelled'],
        ['/me/drive/root/children?$top=0', '$top=0 is not a positive integer'],
        ['/me?$select=mail&$select=id', 'a query option appears twice'],
      ]
      for (const [path, reason] of refused) {
        await expect(fetchAs(path), path).rejects.toThrow(reason)
      }
      expect(graph.unmatched).toHaveLength(refused.length)
    })

    it('refuses a host that is not Graph, a write, and a body asked for in the wrong encoding', async () => {
      await expect(fetchAs('https://graph.example.invalid/v1.0/me')).rejects.toThrow(
        `only ${GRAPH_BASE} is Graph`,
      )
      await expect(fetchAs('/search/query', { method: 'POST', body: {} })).rejects.toThrow(
        'POST is not modelled',
      )
      await expect(fetchAs('/me/drive/items/E2E-ITEM-INT-DOCX/content')).rejects.toThrow(
        'the drive item content route answers bytes, and the caller asked for JSON',
      )
      await expect(fetchAs('/me', { responseType: 'base64' })).rejects.toThrow(
        'the me route answers JSON, and the caller asked for bytes',
      )
      expect(graph.unmatched).toHaveLength(4)
      // The control: an absolute URL on Graph itself is a paging link, and is answered.
      await expect(fetchAs(`${GRAPH_BASE}/me`)).resolves.toMatchObject({
        mail: 'synthetic.user@contoso.com',
      })
      expect(graph.unmatched).toHaveLength(4)
    })

    it('through the real tool code, an unmodelled call is a failed tool result naming the route, never an empty answer', async () => {
      // Neither the calendar nor Microsoft Search is modelled. A router that
      // answered an empty collection would make the first report an empty day
      // and the second report no matches: plausible, and wrong.
      const day = await run('graph_calendar_today')
      expect(day.success, JSON.stringify(day)).toBe(false)
      expect(day.data).toBeNull()
      expect(day.error).toMatch(/^\[fake-graph\] no fixture for GET \/me\/calendarView\?/)

      const search = await run('graph_files_search', { query: 'synthetic' })
      expect(search.success, JSON.stringify(search)).toBe(false)
      expect(search.error).toMatch(/^\[fake-graph\] no fixture for POST \/search\/query/)

      expect(graph.unmatched).toHaveLength(2)
      expect(() => graph.assertAllMatched()).toThrow('2 request(s) had no fixture')
    })
  })

  describe('the shapes the HITL scenarios read, through the real tool code', () => {
    // Every request these tools make has to be modelled: a red here means the
    // real code asked for something the fixtures do not hold.
    afterEach(() => graph.assertAllMatched())

    it('graph_me: the signed-in user is on the home domain', async () => {
      expect(await run('graph_me')).toMatchObject({
        success: true,
        data: {
          displayName: 'Synthetic User',
          mail: 'synthetic.user@contoso.com',
          userPrincipalName: 'synthetic.user@contoso.com',
        },
      })
    })

    it('graph_mail_attachments: a message from outside the home tenancy and one from inside, newest first', async () => {
      const result = await run('graph_mail_attachments', { direction: 'received' })
      expect(result.success, JSON.stringify(result)).toBe(true)
      const { messages } = result.data as {
        messages: Array<{ with: string[]; attachments: Json[] }>
      }
      expect(messages.map((m) => m.with)).toEqual([['Sender One'], ['Colleague One']])
      expect(messages[0].attachments).toEqual([
        {
          name: 'sample-external.docx',
          size: fixtureFile('sample-external.docx').length,
          contentType: DOCX,
        },
        {
          name: 'sample-external-notes.txt',
          size: fixtureFile('sample-external-notes.txt').length,
          contentType: 'text/plain',
        },
      ])
      expect(messages[1].attachments).toEqual([
        {
          name: 'sample-internal.docx',
          size: fixtureFile('sample-internal.docx').length,
          contentType: DOCX,
        },
      ])
    })

    it('graph_files_list: the OneDrive root, a folder, and a shortcut to an external file', async () => {
      const root = await run('graph_files_list')
      expect(root.success, JSON.stringify(root)).toBe(true)
      const items = (root.data as { items: Json[] }).items
      expect(items.map((i) => [i.name, i.drive_id, i.item_id, i.isFolder])).toEqual([
        ['sample-internal.docx', ME_DRIVE, 'E2E-ITEM-INT-DOCX', false],
        ['sample-notes.txt', ME_DRIVE, 'E2E-ITEM-UNKNOWN-TXT', false],
        ['synthetic-folder', ME_DRIVE, 'E2E-ITEM-FOLDER', true],
        // The shortcut resolves to the item on the external drive, which is the
        // pair graph_file_ingest takes.
        ['sample-external.docx', FABRIKAM_DRIVE, 'E2E-ITEM-EXT-DOCX', false],
      ])

      const folder = await run('graph_files_list', { folder_item_id: 'E2E-ITEM-FOLDER' })
      expect((folder.data as { items: Json[] }).items).toMatchObject([
        { name: 'sample-oversize.pdf', path: 'synthetic-folder', size: 2_000_000_000 },
      ])
    })

    it('graph_file_ingest stores the exact fixture bytes, from OneDrive, an external drive and a SharePoint library', async () => {
      const ingested = [
        await run('graph_file_ingest', { item_id: 'E2E-ITEM-INT-DOCX' }),
        await run('graph_file_ingest', { item_id: 'E2E-ITEM-EXT-DOCX', drive_id: FABRIKAM_DRIVE }),
        await run('graph_file_ingest', { item_id: 'E2E-ITEM-EXT-PDF', drive_id: FABRIKAM_DRIVE }),
        await run('graph_file_ingest', { item_id: 'E2E-ITEM-SITE-TXT', drive_id: SITE_DRIVE }),
      ]
      for (const result of ingested) expect(result.success, JSON.stringify(result)).toBe(true)
      expect(ingested.map((r) => (r.data as Json).mimeType)).toEqual([
        DOCX,
        DOCX,
        'application/pdf',
        'text/plain',
      ])

      expect(stored.map((s) => [s.sessionId, s.filename, s.encoding ?? 'utf8'])).toEqual([
        [SESSION, 'sample-internal.docx', 'base64'],
        [SESSION, 'sample-external.docx', 'base64'],
        [SESSION, 'sample-external.pdf', 'base64'],
        [SESSION, 'sample-site-notes.txt', 'utf8'],
      ])
      const bytes = (s: GraphStashDocumentInput) =>
        Buffer.from(s.content, s.encoding === 'base64' ? 'base64' : 'utf8')
      expect(bytes(stored[0]).equals(fixtureFile('sample-internal.docx'))).toBe(true)
      expect(bytes(stored[1]).equals(fixtureFile('sample-external.docx'))).toBe(true)
      expect(bytes(stored[2]).equals(fixtureFile('sample-external.pdf'))).toBe(true)
      expect(bytes(stored[3]).equals(fixtureFile('sample-site-notes.txt'))).toBe(true)
    })

    it('graph_file_ingest refuses an oversized file before downloading it', async () => {
      const result = await run('graph_file_ingest', { item_id: 'E2E-ITEM-OVERSIZE-PDF' })
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/is 2000000000 bytes, above the Data Stash limit/)
      // Metadata only: the bytes were never asked for.
      expect(graph.requests.map((r) => r.route)).toEqual(['drive item'])
      expect(stored).toEqual([])
    })

    it('graph_file_ingest turns a modelled 403 into the per-item denial, and a folder into "no file content"', async () => {
      const denied = await run('graph_file_ingest', { item_id: 'E2E-ITEM-DENIED' })
      expect(denied.success).toBe(false)
      expect(denied.error).toMatch(/denied access to item E2E-ITEM-DENIED \(403\)/)
      expect(graph.requests.at(-1)?.route).toBe('modelled error')

      const folder = await run('graph_file_ingest', { item_id: 'E2E-ITEM-FOLDER' })
      expect(folder.success).toBe(false)
      expect(folder.error).toMatch(/has no file content/)
      expect(stored).toEqual([])
    })
  })

  describe('the fields provenance will read', () => {
    afterEach(() => graph.assertAllMatched())

    /** The `$select` spec §6.1 widens `graph_file_ingest`'s metadata read to. */
    const PROVENANCE_SELECT =
      'name,file,size,webUrl,createdBy,lastModifiedBy,shared,remoteItem,parentReference'

    /** The domain of every email on the item's identities, in a fixed order. */
    async function identityDomains(path: string): Promise<string[]> {
      const item = (await fetchAs(`${path}?$select=${PROVENANCE_SELECT}`)) as Json
      const shared = (item.shared ?? {}) as Json
      return [item.createdBy, item.lastModifiedBy, shared.owner, shared.sharedBy]
        .map((identity) => ((identity as Json | undefined)?.user as Json | undefined)?.email)
        .filter((email): email is string => typeof email === 'string')
        .map((email) => email.split('@')[1])
    }

    it('a widened $select returns the identities: home, external, mixed, and none with an email', async () => {
      expect(await identityDomains('/me/drive/items/E2E-ITEM-INT-DOCX')).toEqual([
        'contoso.com',
        'contoso.com',
      ])
      expect(await identityDomains(`/drives/${FABRIKAM_DRIVE}/items/E2E-ITEM-EXT-DOCX`)).toEqual([
        'fabrikam.com',
        'fabrikam.com',
        'fabrikam.com',
        'fabrikam.com',
      ])
      expect(await identityDomains(`/drives/${SITE_DRIVE}/items/E2E-ITEM-SITE-TXT`)).toEqual([
        'contoso.com',
        'fabrikam.com',
      ])
      expect(await identityDomains('/me/drive/items/E2E-ITEM-UNKNOWN-TXT')).toEqual([])
    })

    it('$select projects: a field that was not asked for is not returned', async () => {
      // Today's ingest select, which carries no provenance at all.
      const item = (await fetchAs(
        `/drives/${FABRIKAM_DRIVE}/items/E2E-ITEM-EXT-DOCX?$select=name,file,size,webUrl`,
      )) as Json
      expect(Object.keys(item).sort()).toEqual(['file', 'id', 'name', 'size', 'webUrl'])
    })

    it('a message carries its sender, and its attachment comes back as JSON with contentBytes and as raw bytes', async () => {
      const external = await fetchAs(
        '/me/messages/E2E-MSG-EXTERNAL?$select=from,sender,receivedDateTime',
      )
      expect(external).toEqual({
        id: 'E2E-MSG-EXTERNAL',
        from: { emailAddress: { name: 'Sender One', address: 'sender.one@fabrikam.com' } },
        sender: { emailAddress: { name: 'Sender One', address: 'sender.one@fabrikam.com' } },
        receivedDateTime: '2026-10-02T09:00:00Z',
      })
      const internal = (await fetchAs('/me/messages/E2E-MSG-INTERNAL?$select=from')) as Json
      expect(internal.from).toEqual({
        emailAddress: { name: 'Colleague One', address: 'colleague.one@contoso.com' },
      })

      const listed = (await fetchAs('/me/messages/E2E-MSG-EXTERNAL/attachments?$select=name')) as {
        value: Json[]
      }
      expect(listed.value.map((a) => [a.id, a.name])).toEqual([
        ['E2E-ATT-EXT-DOCX', 'sample-external.docx'],
        ['E2E-ATT-EXT-TXT', 'sample-external-notes.txt'],
      ])

      const attachment = (await fetchAs(
        '/me/messages/E2E-MSG-EXTERNAL/attachments/E2E-ATT-EXT-DOCX',
      )) as Json
      expect(attachment).toMatchObject({
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: 'sample-external.docx',
        contentType: DOCX,
        size: fixtureFile('sample-external.docx').length,
        isInline: false,
      })
      const decoded = Buffer.from(String(attachment.contentBytes), 'base64')
      expect(decoded.equals(fixtureFile('sample-external.docx'))).toBe(true)

      const raw = await fetchAs(
        '/me/messages/E2E-MSG-EXTERNAL/attachments/E2E-ATT-EXT-DOCX/$value',
        {
          responseType: 'base64',
        },
      )
      expect(raw).toBe(attachment.contentBytes)
    })
  })
})

describe('the fake converter', () => {
  let converter: FakeConverter
  let convertToMarkdown: (b64: string, filename: string, mimeType: string) => Promise<string>
  let previousUrl: string | undefined

  beforeAll(async () => {
    converter = await startFakeConverter()
    // The production client reads this per call, so pointing it here is all
    // the wiring there is; it is put back for whatever runs next.
    previousUrl = process.env.DOC_CONVERT_URL
    process.env.DOC_CONVERT_URL = converter.url
    ;({ convertToMarkdown } = await import('@hames-ai/harness-patterns/stash/doc-convert.server'))
  })

  afterAll(async () => {
    if (previousUrl === undefined) delete process.env.DOC_CONVERT_URL
    else process.env.DOC_CONVERT_URL = previousUrl
    await converter.close()
  })

  beforeEach(() => converter.reset())

  it('answers each synthetic input with its own Markdown, through the production client, the same way twice', async () => {
    const { entries } = JSON.parse(
      readFileSync(new URL('../fixtures/converter/manifest.json', import.meta.url), 'utf8'),
    ) as { entries: Array<{ file: string; mimeType: string; markdown: string }> }
    expect(entries.map((e) => e.file)).toEqual([
      'sample-internal.docx',
      'sample-external.docx',
      'sample-external.pdf',
    ])
    for (const { file, mimeType, markdown } of entries) {
      const b64 = fixtureFile(file).toString('base64')
      const first = await convertToMarkdown(b64, file, mimeType)
      expect(first, file).toBe(markdown)
      expect(await convertToMarkdown(b64, file, mimeType), file).toBe(first)
    }
    converter.assertAllMatched()
    expect(converter.requests.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200])
  })

  it('refuses bytes no manifest entry holds, naming the digest, the filename and the type', async () => {
    const bytes = Buffer.from('not one of the synthetic inputs')
    const digest = createHash('sha256').update(bytes).digest('hex')
    await expect(convertToMarkdown(bytes.toString('base64'), 'unknown.docx', DOCX)).rejects.toThrow(
      'doc-convert /extract failed: HTTP 422',
    )
    expect(converter.unmatched).toEqual([
      `POST /extract: no manifest entry for sha256 ${digest} (unknown.docx, ${DOCX})`,
    ])
    expect(() => converter.assertAllMatched()).toThrow(digest)
  })

  it('refuses known bytes under a type the manifest does not declare for them', async () => {
    const b64 = fixtureFile('sample-external.docx').toString('base64')
    await expect(
      convertToMarkdown(b64, 'sample-external.docx', 'application/octet-stream'),
    ).rejects.toThrow('doc-convert /extract failed: HTTP 422')
    expect(converter.unmatched).toHaveLength(1)
    expect(converter.unmatched[0]).toContain(
      `is sample-external.docx, which the manifest declares as ${DOCX}`,
    )
  })

  it('refuses a config it cannot honour, naming an unknown field, and accepts the pinned one', async () => {
    const post = (config: string | null) => {
      const form = new FormData()
      const pdf = new Blob([new Uint8Array(fixtureFile('sample-external.pdf'))], {
        type: 'application/pdf',
      })
      form.append('files', pdf, 'sample-external.pdf')
      if (config !== null) form.append('config', config)
      return fetch(`${converter.url}/extract`, { method: 'POST', body: form })
    }
    const refused: Array<[string | null, string]> = [
      [
        JSON.stringify({ output_format: 'markdown', structured_extraction: {} }),
        'unknown config field `structured_extraction`',
      ],
      [JSON.stringify({ output_format: 'plain' }), 'the fake answers "markdown" only'],
      [null, 'no config part'],
    ]
    for (const [config, reason] of refused) {
      const res = await post(config)
      expect(res.status, String(config)).toBe(400)
      expect(((await res.json()) as { message: string }).message).toContain(reason)
    }
    expect(converter.unmatched).toHaveLength(refused.length)

    // Spec §5.3 step 3's pinned config, which the sanitizer slice will send.
    const pinned = await post(
      JSON.stringify({ output_format: 'markdown', max_archive_depth: 0, use_cache: false }),
    )
    expect(pinned.status).toBe(200)
    expect(await pinned.json()).toEqual([
      { content: 'Synthetic external PDF.\n', mime_type: 'application/pdf', metadata: {} },
    ])
    expect(converter.unmatched).toHaveLength(refused.length)
  })

  it('refuses any route but POST /extract', async () => {
    const get = await fetch(`${converter.url}/extract`)
    expect(get.status).toBe(405)
    const other = await fetch(`${converter.url}/v1/extract`, { method: 'POST' })
    expect(other.status).toBe(404)
    expect(((await other.json()) as { message: string }).message).toContain(
      'no route POST /v1/extract',
    )
    expect(converter.unmatched).toEqual([
      'GET /extract: GET /extract is not modelled',
      'POST /v1/extract: no route POST /v1/extract; the fake serves POST /extract only',
    ])
  })
})

describe('the wiring bootApp does', () => {
  let app: AppHandles

  beforeAll(async () => {
    app = await bootApp()
  })

  it('points DOC_CONVERT_URL at its own fake converter', () => {
    expect(app.fakeConverter.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(process.env.DOC_CONVERT_URL).toBe(app.fakeConverter.url)
  })

  it('installGraphTools puts the router behind the real callTool, and its return value takes it away', async () => {
    // Reached only now, after the boot: `mcp-client.server.ts` freezes the
    // gateway URL at first import (see lib/app.ts).
    const { callTool, listTools } = await import('@hames-ai/harness-patterns/mcp-client.server')
    const { runWithRequestContext } =
      await import('../../src/lib/harness-client/request-user.server')
    const names = async () => (await listTools()).map((t) => t.name)
    expect(await names()).not.toContain('graph_me')

    const uninstall = await app.installGraphTools()
    try {
      expect(await names()).toContain('graph_me')
      app.fakeGraph.reset()
      const me = await runWithRequestContext({ userId: app.userId, sessionId: null }, () =>
        callTool('graph_me', {}),
      )
      expect(me).toMatchObject({ success: true, data: { mail: 'synthetic.user@contoso.com' } })
      expect(app.fakeGraph.requests).toEqual([
        {
          userId: app.userId,
          method: 'GET',
          path: expect.stringMatching(/^\/me\?\$select=/),
          route: 'me',
        },
      ])

      // No stash backend in this layer: the default refuses, by name.
      const ingest = await runWithRequestContext(
        { userId: app.userId, sessionId: 'e2e-fixture-router' },
        () => callTool('graph_file_ingest', { item_id: 'E2E-ITEM-INT-DOCX' }),
      )
      expect(ingest.success).toBe(false)
      expect(ingest.error).toContain('composed with no Data Stash')
      app.fakeGraph.assertAllMatched()
    } finally {
      uninstall()
    }
    expect(await names()).not.toContain('graph_me')
  })
})
