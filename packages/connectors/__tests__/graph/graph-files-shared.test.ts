/**
 * graph_files_shared — "what was shared with me", from /me/insights/shared.
 *
 * Predominantly but NOT exclusively inbound. `lastShared.sharedBy` is the actor
 * of the share, and measured 2026-08-03 (N=25) that actor was the signed-in user
 * on 3 rows. An earlier 50-row sample was read as "zero shared by the signed-in
 * user" and the tool description asserted outright that it CANNOT list outbound
 * shares — this suite pinned that sentence, so the test was enforcing a false
 * claim. Both now say the accurate thing: some outbound rows surface, coverage
 * is unknown, so the tool must not be used to answer "what did I share with X".
 *
 * The `via` classification exists because Graph's own `sharingType` does not
 * identify the mechanism: measured 2026-08-03 over 25 rows, 23 said "Attachment"
 * while email attachments, Teams chat pastes and drive files sent as links all
 * hid behind it. See `docs/graph-api-notes.md` for the provenance.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { extract } from '@hames-ai/harness-patterns/patterns/decisionLoop-records.server'
import type { ContextEvent } from '@hames-ai/harness-patterns/types'
import { buildGraphHarness } from './harness'
import { GraphAuthRequiredError } from '../../graph/graph-auth'
import {
  shapeSharedInsight,
  deriveVia,
  parseOwaAttachmentUrl,
  type GraphSharedFilesResult,
} from '../../graph/graph-tools.server'

const h = buildGraphHarness()
const { runAppTool, appToolDescriptions } = h
const graphFetch = h.graphFetch

/** One /me/insights/shared row as Graph shapes it. */
function shared(title: string, by: string, refType = 'microsoft.graph.driveItem', how = 'Link') {
  return {
    resourceVisualization: { title },
    lastShared: {
      sharedBy: { displayName: by, address: `${by.split(' ')[0].toLowerCase()}@contoso.com` },
      sharedDateTime: '2026-07-30T08:00:00Z',
      sharingType: how,
    },
    resourceReference: {
      webUrl: `https://contoso.sharepoint.com/x/${encodeURIComponent(title)}`,
      id: refType === 'microsoft.graph.driveItem' ? `drives/b!DRV/items/01-${title}` : undefined,
      type: refType,
    },
  }
}

/**
 * An email-attachment row as insights really shapes it: the webUrl is the OWA
 * attachment popout carrying ItemId/AttachmentId/AttachmentName, and the title
 * has lost its extension (14 of 15 rows, measured 2026-08-03).
 */
function owaAttachment(
  itemId: string,
  attachmentName: string,
  by: string,
  sharedAt = '2026-08-02T01:04:54Z',
) {
  const q = new URLSearchParams({
    viewmodel: 'IAttachmentViewModelPopoutFactory',
    AttachmentId: `${itemId}EgAQAG2aQF8`,
    ItemId: itemId,
    AttachmentName: attachmentName,
  })
  return {
    resourceVisualization: { title: attachmentName.replace(/\.[^.]+$/, '') },
    lastShared: {
      sharedBy: { displayName: by, address: `${by.split(' ')[0].toLowerCase()}@contoso.com` },
      sharedDateTime: sharedAt,
      sharingType: 'Attachment',
    },
    resourceReference: {
      webUrl: `https://outlook.office.com/owa/?${q}`,
      type: 'microsoft.graph.fileAttachment',
    },
  }
}

/**
 * A file pasted into a Teams chat. It lives in the SENDER's OneDrive under a
 * LOCALIZED folder — French here, exactly as observed in this tenant, because
 * an English-only fixture would let a folder-name allowlist pass.
 */
function teamsPaste(
  name: string,
  by: string,
  sharedAt = '2026-08-03T12:01:58Z',
  folder = 'Fichiers de conversation Microsoft Teams',
) {
  const base = 'https://contoso-my.sharepoint.com/personal/pattif_contoso_com/Documents'
  return {
    resourceVisualization: { title: name },
    lastShared: {
      sharedBy: { displayName: by, address: `${by.split(' ')[0].toLowerCase()}@contoso.com` },
      sharedDateTime: sharedAt,
      sharingType: 'Attachment',
    },
    resourceReference: {
      webUrl: `${base}/${encodeURIComponent(folder)}/${encodeURIComponent(name)}`,
      id: `drives/b!DRV/items/01-${name}`,
      type: 'microsoft.graph.driveItem',
    },
  }
}

beforeEach(() => {
  h.restoreDefaults()
  graphFetch.mockResolvedValue({
    value: [
      shared('plan.docx', 'Lidia Holloway'),
      shared('invoice.pdf', 'Adele Vance', 'microsoft.graph.fileAttachment', 'Attachment'),
      shared('mystery', 'Pradeep Gupta', 'microsoft.graph.entity', 'Direct'),
      shared('dpa.docx', 'Adele Vance'),
    ],
  })
})

describe('advertisement', () => {
  it('takes address + name fallback + via + limit — no credential/user/session field', () => {
    const tool = appToolDescriptions().find((t) => t.name === 'graph_files_shared')!
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toEqual([
      'shared_by_address',
      'shared_by',
      'via',
      'limit',
    ])
    const schema = JSON.stringify(tool.inputSchema).toLowerCase()
    for (const banned of ['token', 'credential', 'secret', 'userid', 'user_id', 'session', 'oid']) {
      expect(schema).not.toContain(banned)
    }
  })

  it('warns the outbound direction is unreliable, without claiming it is impossible', () => {
    const tool = appToolDescriptions().find((t) => t.name === 'graph_files_shared')!
    // It used to say the tool CANNOT list the signed-in person's own shares.
    // Measured 2026-08-03, 3 of 25 rows named them as the sharer, so that was
    // false — and shipped to the model, which would decline a question it can
    // partly answer and explain the refusal with a wrong reason.
    expect(tool.description).toMatch(/NOT a reliable record of what they shared with others/)
    expect(tool.description).not.toMatch(/CANNOT list what the signed-in person shared/)
  })
})

describe('coverage on every shared-files result (#1036)', () => {
  it('counts actual raw and returned rows; a short page never proves all shares', async () => {
    const data = (await runAppTool('graph_files_shared', {})).data as GraphSharedFilesResult
    expect(data.coverage).toEqual({
      scope: 'recent-insights',
      complete: false,
      rawFetched: 4,
      returned: 3,
      cutByLimit: false,
      moreAvailable: false,
      sourceStatus: 'available',
      reasons: ['upstream-window'],
    })
    expect(data.match).toBe('unfiltered')
    // decisionLoop caps a route record from its head: coverage must precede items.
    expect(Object.keys(data).indexOf('coverage')).toBeLessThan(Object.keys(data).indexOf('items'))
  })

  it('retains coverage in a capped office route summary even with a long item list', async () => {
    graphFetch.mockResolvedValue({
      value: Array.from({ length: 25 }, (_, n) => shared(`example-${n}.pdf`, 'Alex Reed')),
    })
    const data = (await runAppTool('graph_files_shared', { limit: 25 })).data
    const event = (type: ContextEvent['type'], body: unknown): ContextEvent => ({
      type,
      data: body,
      ts: 0,
      patternId: 'doc',
    })
    const summary = extract(
      'actorCritic',
      [
        event('controller_action', {
          action: { tool_name: 'graph_files_shared', tool_args: '{}' },
        }),
        event('tool_result', { tool: 'graph_files_shared', result: data, success: true }),
        event('critic_result', {
          result: {
            is_sufficient: true,
            explanation: 'Found in recent sharing activity; partial coverage.',
          },
        }),
      ],
      2000,
    )
    expect(summary.ok).toBe(true)
    if (!summary.ok) throw new Error(summary.text)
    expect(summary.result.length).toBeLessThan(JSON.stringify(data).length)
    expect(summary.result).toContain('"complete":false')
    expect(summary.result).toContain('"scope":"recent-insights"')
    expect(summary.reasoning).toContain('recent sharing activity; partial coverage')
  })

  it('reports a local cut only when distinct matching rows were discarded', async () => {
    const data = (await runAppTool('graph_files_shared', { limit: 2 }))
      .data as GraphSharedFilesResult
    expect(data.coverage.rawFetched).toBe(4)
    expect(data.coverage.returned).toBe(2)
    expect(data.coverage.cutByLimit).toBe(true)
    expect(data.coverage.reasons).toEqual(['upstream-window', 'local-limit'])

    const duplicate = shared('same.pdf', 'Alex Reed')
    graphFetch.mockResolvedValue({ value: [duplicate, duplicate, shared('other.pdf', 'Sam Lee')] })
    const filtered = (await runAppTool('graph_files_shared', { shared_by: 'Alex', limit: 1 }))
      .data as GraphSharedFilesResult
    expect(filtered.coverage.rawFetched).toBe(3)
    expect(filtered.coverage.returned).toBe(1)
    expect(filtered.coverage.cutByLimit).toBe(false)
    expect(filtered.coverage.reasons).not.toContain('local-limit')
  })

  it('reports another upstream page without following it', async () => {
    graphFetch.mockResolvedValue({
      value: [shared('one.pdf', 'Alex Reed')],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/insights/shared?$skiptoken=next',
    })
    const data = (await runAppTool('graph_files_shared', {})).data as GraphSharedFilesResult
    expect(data.coverage.moreAvailable).toBe(true)
    expect(data.coverage.reasons).toEqual(['upstream-window', 'not-paged'])
    expect(data.coverage.complete).toBe(false)
    expect(graphFetch).toHaveBeenCalledTimes(1)
  })

  it.each([
    {},
    { shared_by: 'Unknown Person' },
    { shared_by_address: 'alex@example.org' },
    { via: 'email' },
  ])('keeps empty searches partial with known counts: %j', async (args) => {
    graphFetch.mockResolvedValue({ value: [] })
    const data = (await runAppTool('graph_files_shared', args)).data as GraphSharedFilesResult
    expect(data.items).toEqual([])
    expect(data.coverage).toEqual({
      scope: 'recent-insights',
      complete: false,
      rawFetched: 0,
      returned: 0,
      cutByLimit: false,
      moreAvailable: false,
      sourceStatus: 'available',
      reasons: ['upstream-window'],
    })
  })

  it('distinguishes an unavailable source from an empty search', async () => {
    graphFetch.mockRejectedValue(new GraphAuthRequiredError('denied', 'oid-1', 403))
    const data = (await runAppTool('graph_files_shared', { shared_by_address: 'alex@example.org' }))
      .data as GraphSharedFilesResult
    expect(data.items).toEqual([])
    expect(data.match).toBe('address')
    expect(data.coverage).toEqual({
      scope: 'recent-insights',
      complete: false,
      rawFetched: 0,
      returned: 0,
      cutByLimit: false,
      moreAvailable: 'unknown',
      sourceStatus: 'unavailable',
      reasons: ['upstream-window', 'source-unavailable'],
    })
  })
})

describe('resolved sharer address (#1036)', () => {
  it('escapes the OData literal and URL-encodes the whole predicate', async () => {
    await runAppTool('graph_files_shared', { shared_by_address: "alex.o'reed+docs@example.org" })
    const path = graphFetch.mock.calls[0][1] as string
    const url = new URL(path, 'https://graph.microsoft.com/v1.0')
    expect(url.searchParams.get('$filter')).toBe(
      "lastshared/sharedby/address eq 'alex.o''reed+docs@example.org'",
    )
    expect(path).toContain('%2F')
    expect(path).toContain('%20eq%20%27')
    expect(path).toContain('alex.o%27%27reed%2Bdocs%40example.org%27')
    expect(url.searchParams.get('$top')).toBe('50')
    expect(graphFetch.mock.calls[0][2]).toEqual({ scopes: ['Sites.Read.All'] })
  })

  it('uses the address even when the supplied name differs', async () => {
    const row = shared('one.pdf', 'Alex Reed')
    row.lastShared.sharedBy.address = 'ALEX@EXAMPLE.ORG'
    graphFetch.mockResolvedValue({ value: [row] })
    const data = (
      await runAppTool('graph_files_shared', {
        shared_by_address: 'alex@example.org',
        shared_by: 'Different Display Name',
      })
    ).data as GraphSharedFilesResult
    expect(data.items.map((r) => r.name)).toEqual(['one.pdf'])
    expect(data.match).toBe('address')
  })

  it('keeps an ignored upstream address filter empty, without relabelling other shares', async () => {
    const missing = shared('missing-address.pdf', 'Alex Reed')
    Reflect.deleteProperty(missing.lastShared.sharedBy, 'address')
    graphFetch.mockResolvedValue({ value: [shared('other.pdf', 'Sam Lee'), missing] })
    const data = (
      await runAppTool('graph_files_shared', {
        shared_by_address: 'alex@example.org',
      })
    ).data as GraphSharedFilesResult
    expect(data.items).toEqual([])
    expect(data.match).toBe('address')
    expect(data.note).toContain('by the resolved address')
    expect(data.coverage.rawFetched).toBe(2)
    expect(data.coverage.returned).toBe(0)
    expect(data.coverage.cutByLimit).toBe(false)
  })

  it('returns only rows whose address matches when Graph returns a mixed page', async () => {
    const matching = shared('matching.pdf', 'Alex Reed')
    matching.lastShared.sharedBy.address = 'alex@example.org'
    graphFetch.mockResolvedValue({ value: [matching, shared('other.pdf', 'Sam Lee')] })
    const data = (
      await runAppTool('graph_files_shared', {
        shared_by_address: 'alex@example.org',
      })
    ).data as GraphSharedFilesResult
    expect(data.items.map((r) => r.name)).toEqual(['matching.pdf'])
    expect(data.coverage.rawFetched).toBe(2)
    expect(data.coverage.returned).toBe(1)
  })

  it.each([null, undefined])('treats %s as an absent address', async (address) => {
    for (const [args, match, names] of [
      [{}, 'unfiltered', ['plan.docx', 'invoice.pdf', 'dpa.docx']],
      [{ shared_by: 'adele' }, 'display-name-fallback', ['invoice.pdf', 'dpa.docx']],
      [{ via: 'email' }, 'unfiltered', ['invoice.pdf']],
    ] as const) {
      const res = await runAppTool('graph_files_shared', { ...args, shared_by_address: address })
      expect(res.success).toBe(true)
      const data = res.data as GraphSharedFilesResult
      expect(data.match).toBe(match)
      expect(data.items.map((r) => r.name)).toEqual(names)
      expect(graphFetch.mock.calls.at(-1)![1]).not.toContain('$filter')
    }
  })

  it.each([400, 429, 500, 503, 401, 'transport', 'non-error'])(
    'omits the address from the returned and logged Graph error (%s)',
    async (failure) => {
      const address = "alex.o'reed+docs@example.org"
      graphFetch.mockImplementation(async (_user, path) => {
        const message = `[graph] GET ${path} failed: ${failure}`
        if (failure === 401) throw new GraphAuthRequiredError(message, 'oid-1', 401)
        if (failure === 'non-error') throw message
        throw new Error(message)
      })
      const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const res = await runAppTool('graph_files_shared', { shared_by_address: address })
        expect(res.success).toBe(false)
        expect(res.error).toContain('query omitted')
        expect(logged).toHaveBeenCalledTimes(1)
        for (const output of [res.error!, JSON.stringify(logged.mock.calls)]) {
          expect(output).not.toContain(address)
          expect(output).not.toContain(encodeURIComponent(address))
          expect(output).not.toContain('%40')
          expect(output).not.toContain('$filter')
        }
      } finally {
        logged.mockRestore()
      }
    },
  )

  it('labels the display-name fallback only when no address was supplied', async () => {
    const data = (await runAppTool('graph_files_shared', { shared_by: 'adele' }))
      .data as GraphSharedFilesResult
    expect(data.match).toBe('display-name-fallback')
    expect(data.items.map((r) => r.name)).toEqual(['invoice.pdf', 'dpa.docx'])
    expect(graphFetch.mock.calls[0][1]).not.toContain('$filter')
  })

  it('never retries an unmatched address with a broader name query', async () => {
    graphFetch.mockResolvedValue({ value: [] })
    const data = (
      await runAppTool('graph_files_shared', {
        shared_by_address: 'former.external@example.org',
        shared_by: 'Alex',
      })
    ).data as GraphSharedFilesResult
    expect(data.match).toBe('address')
    expect(data.items).toEqual([])
    expect(data.note).toContain('by the resolved address')
    expect(data.note).not.toContain('former.external@example.org')
    expect(graphFetch).toHaveBeenCalledTimes(1)
  })

  it.each(['', '   ', 'unresolved', 42, { address: 'alex@example.org' }])(
    'refuses an explicitly unresolved/malformed address (%j) without widening',
    async (address) => {
      const res = await runAppTool('graph_files_shared', {
        shared_by_address: address,
        shared_by: 'Alex',
      })
      expect(res.success).toBe(false)
      expect(res.error).toMatch(/shared_by_address/)
      expect(graphFetch).not.toHaveBeenCalled()
    },
  )
})

describe('shapeSharedInsight', () => {
  it('a driveItem row is kind=file with the handoff pair', () => {
    expect(shapeSharedInsight(shared('plan.docx', 'Lidia Holloway'))).toEqual({
      name: 'plan.docx',
      kind: 'file',
      shared_by: 'Lidia Holloway',
      shared_when: '2026-07-30T08:00:00Z',
      how: 'Link',
      via: 'link',
      drive_id: 'b!DRV',
      item_id: '01-plan.docx',
      webUrl: 'https://contoso.sharepoint.com/x/plan.docx',
    })
  })

  it('an email attachment is kind=attachment with null ids — it lives in a mailbox', () => {
    const row = shapeSharedInsight(
      shared('invoice.pdf', 'Adele Vance', 'microsoft.graph.fileAttachment', 'Attachment'),
    )!
    expect(row.kind).toBe('attachment')
    expect(row.drive_id).toBeNull()
    expect(row.item_id).toBeNull()
    expect(row.how).toBe('Attachment')
    expect(row.via).toBe('email')
  })

  it('bare entity rows are dropped — no title, no address, pure noise', () => {
    expect(shapeSharedInsight(shared('x', 'y', 'microsoft.graph.entity'))).toBeNull()
  })

  it('an attachment row is rewritten to the email and regains its extension', () => {
    const row = shapeSharedInsight(
      owaAttachment('AAMkADkx-MSG-1=', '20260101-00000001.pdf', 'Evergrid Business'),
    )!
    // The insights title was "20260101-00000001" — extensionless and unopenable.
    expect(row.name).toBe('20260101-00000001.pdf')
    expect(row.webUrl).toBe(
      'https://outlook.office.com/owa/?ItemID=AAMkADkx-MSG-1%3D' +
        '&exvsurl=1&viewmodel=ReadMessageItem',
    )
  })

  it('an unparseable attachment URL changes nothing — degrades to the old behaviour', () => {
    // The existing fixture's webUrl is a plain SharePoint path, not an OWA link.
    const row = shapeSharedInsight(
      shared('invoice.pdf', 'Adele Vance', 'microsoft.graph.fileAttachment', 'Attachment'),
    )!
    expect(row.name).toBe('invoice.pdf')
    expect(row.webUrl).toBe('https://contoso.sharepoint.com/x/invoice.pdf')
  })

  it('a Teams chat paste is via=teams even though Graph calls it an Attachment', () => {
    const row = shapeSharedInsight(teamsPaste("Capture d'écran.png", 'Patti Fernandez'))!
    expect(row.how).toBe('Attachment')
    expect(row.via).toBe('teams')
  })
})

describe('deriveVia', () => {
  it('a mailbox attachment is email, decided by kind before any URL is read', () => {
    // kind comes from resourceReference.type, which Graph contracts — so an OWA
    // URL can never fall through into the Teams heuristic.
    expect(deriveVia('attachment', 'https://outlook.office.com/owa/?ItemId=x')).toBe('email')
    expect(deriveVia('attachment', null)).toBe('email')
    expect(
      deriveVia('attachment', 'https://x-my.sharepoint.com/personal/a/Documents/Teams/f'),
    ).toBe('email')
  })

  it('recognizes the Teams chat folder in any UI language', () => {
    const path = (folder: string) =>
      `https://x-my.sharepoint.com/personal/a_b_be/Documents/${encodeURIComponent(folder)}/s.png`
    for (const folder of [
      'Microsoft Teams Chat Files',
      'Fichiers de conversation Microsoft Teams',
      'Microsoft Teams-chatbestanden',
      'Dateien aus Microsoft Teams-Chats',
    ]) {
      expect(deriveVia('file', path(folder)), folder).toBe('teams')
    }
  })

  it('does not mistake a file NAMED after Teams for a chat paste', () => {
    // Only folder segments are scanned; the filename is excluded on purpose.
    expect(
      deriveVia(
        'file',
        'https://x-my.sharepoint.com/personal/a_b_be/Documents/Reports/Teams%20rollout%20plan.docx',
      ),
    ).toBe('link')
  })

  it('everything else is link, including a Doc.aspx handler URL', () => {
    expect(
      deriveVia(
        'file',
        'https://x-my.sharepoint.com/personal/a_b_be/_layouts/15/Doc.aspx?sourcedoc=%7BGUID%7D&file=p.pptx',
      ),
    ).toBe('link')
    expect(
      deriveVia('file', 'https://x-my.sharepoint.com/personal/a_b_be/Documents/Contracts/dpa.docx'),
    ).toBe('link')
  })

  it('never returns null, even for a missing or malformed URL', () => {
    expect(deriveVia('file', null)).toBe('link')
    expect(deriveVia('file', 'not a url at all %')).toBe('link')
  })
})

describe('parseOwaAttachmentUrl', () => {
  const OWA = 'https://outlook.office.com/owa/'

  it("reads ItemId as insights spells it AND ItemID as Graph's own webLink does", () => {
    // URLSearchParams.get() is case-sensitive; reading one spelling would ship a
    // rewrite that is silently dead against the other.
    for (const key of ['ItemId', 'ItemID', 'itemid']) {
      const parsed = parseOwaAttachmentUrl(`${OWA}?${key}=MSG1&AttachmentName=a.pdf`)
      expect(parsed?.itemId, key).toBe('MSG1')
      expect(parsed?.attachmentName, key).toBe('a.pdf')
    }
  })

  it('rebuilds the read-message link, preserving origin and pathname', () => {
    // Graph itself emits outlook.office365.com; a sovereign cloud emits another
    // host again. Carrying the input's origin over keeps both working.
    const parsed = parseOwaAttachmentUrl(`https://outlook.office365.com/owa/?ItemId=MSG1`)
    expect(parsed?.messageUrl).toBe(
      'https://outlook.office365.com/owa/?ItemID=MSG1&exvsurl=1&viewmodel=ReadMessageItem',
    )
  })

  it('drops AttachmentId — the popout discriminator has no place in a message link', () => {
    const parsed = parseOwaAttachmentUrl(`${OWA}?ItemId=MSG1&AttachmentId=MSG1EXTRA`)
    expect(parsed?.messageUrl).not.toContain('AttachmentId')
    expect(parsed?.messageUrl).not.toContain('MSG1EXTRA')
  })

  it('returns null without a message id, or on anything unparseable', () => {
    expect(parseOwaAttachmentUrl(`${OWA}?AttachmentName=a.pdf`)).toBeNull()
    expect(parseOwaAttachmentUrl(`${OWA}?ItemId=`)).toBeNull()
    expect(parseOwaAttachmentUrl('not a url')).toBeNull()
    expect(parseOwaAttachmentUrl(null)).toBeNull()
  })

  it('survives a malformed percent escape, which decodeURIComponent would throw on', () => {
    expect(parseOwaAttachmentUrl(`${OWA}?ItemId=MSG1&AttachmentName=100%.pdf`)?.itemId).toBe('MSG1')
  })
})

describe('graph_files_shared', () => {
  it('returns files and attachments, entity rows filtered', async () => {
    const res = await runAppTool('graph_files_shared', {})
    expect(res.success).toBe(true)
    const data = res.data as GraphSharedFilesResult
    expect(data.items.map((i) => i.name)).toEqual(['plan.docx', 'invoice.pdf', 'dpa.docx'])
  })

  it('keeps rows the signed-in person shared themselves — the feed is not inbound-only', async () => {
    // Measured 2026-08-03: 3 of 25 rows named the signed-in user as sharer, two
    // of them files in their own OneDrive. Nothing filters those out, and
    // nothing should — but the description must not promise they are absent.
    graphFetch.mockResolvedValue({
      value: [
        shared('someone-elses.docx', 'Lidia Holloway'),
        shared('my-screen-recording.mov', 'Michael Verstraete'),
      ],
    })
    const items = ((await runAppTool('graph_files_shared', {})).data as GraphSharedFilesResult)
      .items
    expect(items.map((i) => i.shared_by)).toEqual(['Lidia Holloway', 'Michael Verstraete'])
  })

  it('shared_by is the actor, so it can be pointed at the signed-in person', async () => {
    // The only route to those rows today: resolve the display name via graph_me,
    // then filter on it. Partial coverage — not a substitute for an outbound feed.
    graphFetch.mockResolvedValue({
      value: [
        shared('someone-elses.docx', 'Lidia Holloway'),
        shared('my-screen-recording.mov', 'Michael Verstraete'),
      ],
    })
    const items = (
      (await runAppTool('graph_files_shared', { shared_by: 'Michael Verstraete' }))
        .data as GraphSharedFilesResult
    ).items
    expect(items.map((i) => i.name)).toEqual(['my-screen-recording.mov'])
  })

  it('shared_by filters case-insensitively on a partial name, and inflates $top to 50', async () => {
    const res = await runAppTool('graph_files_shared', { shared_by: 'adele' })
    const data = res.data as GraphSharedFilesResult
    expect(data.items.map((i) => i.name)).toEqual(['invoice.pdf', 'dpa.docx'])
    expect((graphFetch.mock.calls.at(-1) as [string, string])[1]).toBe(
      '/me/insights/shared?$top=50',
    )
  })

  it('a sharer that matches nothing returns a steering note, not a bare empty list', async () => {
    const res = await runAppTool('graph_files_shared', { shared_by: 'Nobody Here' })
    const data = res.data as GraphSharedFilesResult
    expect(data.items).toEqual([])
    // The sharer's name is the controller's text: it is not echoed.
    expect(data.note).not.toMatch(/Nobody Here/)
    expect(data.note).toMatch(/by the person named/)
    expect(data.note).toMatch(/graph_files_search/)
  })

  it('a present-but-wrong-typed shared_by REFUSES instead of listing every sharer (#314)', async () => {
    graphFetch.mockClear()
    const res = await runAppTool('graph_files_shared', { shared_by: { name: 'Lidia' } })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/shared_by must be a string/)
    expect(graphFetch).not.toHaveBeenCalled()
  })

  it('degrades a 403 (insights disabled by policy) to a successful steer', async () => {
    graphFetch.mockRejectedValue(new GraphAuthRequiredError('denied', 'oid-1', 403))
    const res = await runAppTool('graph_files_shared', {})
    expect(res.success).toBe(true)
    expect((res.data as GraphSharedFilesResult).note).toMatch(/graph_files_search/)
  })

  it('a 401 still fails toward sign-in', async () => {
    graphFetch.mockRejectedValue(new GraphAuthRequiredError('expired', 'oid-1', 401))
    const res = await runAppTool('graph_files_shared', {})
    expect(res.success).toBe(false)
  })
})

describe('via filter', () => {
  beforeEach(() => {
    graphFetch.mockResolvedValue({
      value: [
        shared('plan.docx', 'Lidia Holloway'),
        teamsPaste('screenshot.png', 'Patti Fernandez'),
        owaAttachment('MSG-1', 'invoice.pdf', 'Evergrid Business'),
      ],
    })
  })

  it('narrows to one channel and inflates $top to 50 so the rows are not outside the slice', async () => {
    const res = await runAppTool('graph_files_shared', { via: 'teams' })
    const data = res.data as GraphSharedFilesResult
    expect(data.items.map((i) => i.name)).toEqual(['screenshot.png'])
    expect((graphFetch.mock.calls.at(-1) as [string, string])[1]).toBe(
      '/me/insights/shared?$top=50',
    )
  })

  it('via:"email" is exactly the mailbox attachments', async () => {
    const res = await runAppTool('graph_files_shared', { via: 'email' })
    expect((res.data as GraphSharedFilesResult).items.map((i) => i.name)).toEqual(['invoice.pdf'])
  })

  it('normalizes case, so the likeliest mistake costs nothing', async () => {
    const res = await runAppTool('graph_files_shared', { via: '  TEAMS ' })
    expect((res.data as GraphSharedFilesResult).items.map((i) => i.name)).toEqual([
      'screenshot.png',
    ])
  })

  it('REFUSES an unknown channel instead of silently returning every source', async () => {
    // A dropped filter would return all three rows and the model would then
    // narrate mail attachments as Teams pastes — silently wrong beats loudly
    // wrong here, so this throws and the controller can retry.
    const res = await runAppTool('graph_files_shared', { via: 'chat' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/email, teams, link/)
  })

  it('names every active filter in the empty-result steer', async () => {
    const res = await runAppTool('graph_files_shared', { shared_by: 'Lidia', via: 'email' })
    const data = res.data as GraphSharedFilesResult
    expect(data.items).toEqual([])
    expect(data.note).toMatch(/by the person named/)
    expect(data.note).not.toMatch(/Lidia/)
    expect(data.note).toMatch(/via email/)
    expect(data.note).toMatch(/graph_files_search/)
  })
})

describe('newest first, guaranteed rather than inherited', () => {
  it('sorts locally, so a reordered insights response still comes back newest-first', async () => {
    // No $orderby is sent and the insights order is not contracted. Shuffled on
    // purpose: before the local sort this test would return Graph's order.
    graphFetch.mockResolvedValue({
      value: [
        owaAttachment('MSG-OLD', 'old.pdf', 'Pradeep Gupta', '2026-07-29T15:20:25Z'),
        teamsPaste('newest.png', 'Patti Fernandez', '2026-08-03T12:01:58Z'),
        shared('middle.docx', 'Lidia Holloway'), // 2026-07-30T08:00:00Z
      ],
    })
    const res = await runAppTool('graph_files_shared', {})
    expect((res.data as GraphSharedFilesResult).items.map((i) => i.name)).toEqual([
      'newest.png',
      'middle.docx',
      'old.pdf',
    ])
  })

  it('truncation follows recency ONLY — a channel never decides what is dropped', async () => {
    // The anti-hazard guard. Teams pastes rank last in the source-priority order
    // that was considered and rejected; had priority been applied before the
    // slice, "shared in the last 3 days" would have cut today's two rows and
    // answered "nothing was shared today".
    graphFetch.mockResolvedValue({
      value: [
        shared('old-share.docx', 'Lidia Holloway'), // 2026-07-30
        teamsPaste('today-a.png', 'Patti Fernandez', '2026-08-03T12:01:58Z'),
        teamsPaste('today-b.png', 'Patti Fernandez', '2026-08-03T11:16:58Z'),
      ],
    })
    const res = await runAppTool('graph_files_shared', { limit: 2 })
    expect((res.data as GraphSharedFilesResult).items.map((i) => i.name)).toEqual([
      'today-a.png',
      'today-b.png',
    ])
  })

  it('a row with an unparseable date sorts last instead of jumping to the front', async () => {
    const undated = shared('undated.docx', 'Lidia Holloway')
    undated.lastShared.sharedDateTime = 'not a date'
    graphFetch.mockResolvedValue({
      value: [undated, teamsPaste('dated.png', 'Patti Fernandez', '2026-08-03T12:01:58Z')],
    })
    const res = await runAppTool('graph_files_shared', {})
    expect((res.data as GraphSharedFilesResult).items.map((i) => i.name)).toEqual([
      'dated.png',
      'undated.docx',
    ])
  })
})

describe('attachments from one email', () => {
  it('keeps every filename but cross-references the message with one ordinal', async () => {
    // Measured 2026-08-03: 15 attachment rows came from 9 messages, one of them
    // contributing 4 rows. They are 4 DIFFERENT files, so collapsing them would
    // throw away the useful part — the names.
    graphFetch.mockResolvedValue({
      value: [
        owaAttachment('MSG-QUOTE', 'cost model.pdf', 'Pradeep Gupta'),
        owaAttachment('MSG-QUOTE', 'cost summary.pdf', 'Pradeep Gupta'),
        owaAttachment('MSG-QUOTE', 'Offre 0001.pdf', 'Pradeep Gupta'),
        owaAttachment('MSG-QUOTE', "Conditions d'offre.pdf", 'Pradeep Gupta'),
      ],
    })
    const items = ((await runAppTool('graph_files_shared', {})).data as GraphSharedFilesResult)
      .items
    expect(items).toHaveLength(4)
    expect(new Set(items.map((i) => i.name)).size).toBe(4)
    expect(items.map((i) => i.email_group)).toEqual([1, 1, 1, 1])
    // One link for the four of them.
    expect(new Set(items.map((i) => i.webUrl)).size).toBe(1)
  })

  it('gives separate messages separate ordinals', async () => {
    graphFetch.mockResolvedValue({
      value: [
        owaAttachment('MSG-A', 'a1.pdf', 'Evergrid Business'),
        owaAttachment('MSG-A', 'a2.pdf', 'Evergrid Business'),
        owaAttachment('MSG-B', 'b1.png', 'Lidia Holloway'),
        owaAttachment('MSG-B', 'b2.png', 'Lidia Holloway'),
      ],
    })
    const items = ((await runAppTool('graph_files_shared', {})).data as GraphSharedFilesResult)
      .items
    expect(items.map((i) => i.email_group)).toEqual([1, 1, 2, 2])
  })

  it('omits the field entirely for an email that shared one file', async () => {
    graphFetch.mockResolvedValue({
      value: [owaAttachment('MSG-SOLO', 'solo.pdf', 'Evergrid Business')],
    })
    const items = ((await runAppTool('graph_files_shared', {})).data as GraphSharedFilesResult)
      .items
    // Absent, not undefined-valued — nothing to explain to the model.
    expect(items[0]).not.toHaveProperty('email_group')
  })

  it('collapses the same file arriving twice from the same message', async () => {
    graphFetch.mockResolvedValue({
      value: [
        owaAttachment('MSG-A', 'dupe.pdf', 'Evergrid Business'),
        owaAttachment('MSG-A', 'dupe.pdf', 'Evergrid Business'),
        owaAttachment('MSG-A', 'other.pdf', 'Evergrid Business'),
      ],
    })
    const items = ((await runAppTool('graph_files_shared', {})).data as GraphSharedFilesResult)
      .items
    expect(items.map((i) => i.name)).toEqual(['dupe.pdf', 'other.pdf'])
  })
})
