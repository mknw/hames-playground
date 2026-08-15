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

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

const getRequestUserId = vi.fn<() => string | null>(() => 'oid-1')
const getRequestSessionId = vi.fn<() => string | null>(() => 'sess-1')
vi.mock('../../../lib/harness-client/request-user.server', () => ({
  getRequestUserId: () => getRequestUserId(),
  getRequestSessionId: () => getRequestSessionId(),
  runWithUserId: (_u: string, fn: () => Promise<unknown>) => fn(),
  runWithRequestContext: (_c: unknown, fn: () => Promise<unknown>) => fn(),
}))

const graphFetch = vi.fn()
const { GraphAuthRequiredError } = vi.hoisted(() => ({
  GraphAuthRequiredError: class GraphAuthRequiredError extends Error {
    constructor(
      message: string,
      readonly userId: string,
      readonly status?: number,
    ) {
      super(message)
      this.name = 'GraphAuthRequiredError'
    }
  },
}))
vi.mock('../../../lib/auth/graph-token.server', () => ({
  graphFetch: (...a: unknown[]) => graphFetch(...a),
  GRAPH_BASE: 'https://graph.microsoft.com/v1.0',
  DEFAULT_GRAPH_SCOPES: ['User.Read'],
  GraphAuthRequiredError,
}))

import { runAppTool, appToolDescriptions } from '../../../lib/app-tools/index.server'
import {
  shapeSharedInsight,
  deriveVia,
  parseOwaAttachmentUrl,
  type GraphSharedFilesResult,
} from '../../../lib/app-tools/graph.server'

/** One /me/insights/shared row as Graph shapes it. */
function shared(title: string, by: string, refType = 'microsoft.graph.driveItem', how = 'Link') {
  return {
    resourceVisualization: { title },
    lastShared: {
      sharedBy: { displayName: by, address: `${by.split(' ')[0].toLowerCase()}@dtsc.be` },
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
      sharedBy: { displayName: by, address: `${by.split(' ')[0].toLowerCase()}@dtsc.be` },
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
  const base = 'https://dtsc-my.sharepoint.com/personal/dbudin_dtsc_be/Documents'
  return {
    resourceVisualization: { title: name },
    lastShared: {
      sharedBy: { displayName: by, address: `${by.split(' ')[0].toLowerCase()}@dtsc.be` },
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
  vi.clearAllMocks()
  getRequestUserId.mockReturnValue('oid-1')
  getRequestSessionId.mockReturnValue('sess-1')
  graphFetch.mockResolvedValue({
    value: [
      shared('plan.docx', 'Quentin Delière'),
      shared('invoice.pdf', 'Thibault Draye', 'microsoft.graph.fileAttachment', 'Attachment'),
      shared('mystery', 'Denis Budin', 'microsoft.graph.entity', 'Direct'),
      shared('dpa.docx', 'Thibault Draye'),
    ],
  })
})

describe('advertisement', () => {
  it('takes shared_by + via + limit and nothing else — no credential/user/session field', () => {
    const tool = appToolDescriptions().find((t) => t.name === 'graph_files_shared')!
    expect(Object.keys((tool.inputSchema as { properties: object }).properties)).toEqual([
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

describe('shapeSharedInsight', () => {
  it('a driveItem row is kind=file with the handoff pair', () => {
    expect(shapeSharedInsight(shared('plan.docx', 'Quentin Delière'))).toEqual({
      name: 'plan.docx',
      kind: 'file',
      shared_by: 'Quentin Delière',
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
      shared('invoice.pdf', 'Thibault Draye', 'microsoft.graph.fileAttachment', 'Attachment'),
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
      owaAttachment('AAMkADkx-MSG-1=', '20260802-07346747.pdf', 'Chargemap Business'),
    )!
    // The insights title was "20260802-07346747" — extensionless and unopenable.
    expect(row.name).toBe('20260802-07346747.pdf')
    expect(row.webUrl).toBe(
      'https://outlook.office.com/owa/?ItemID=AAMkADkx-MSG-1%3D' +
        '&exvsurl=1&viewmodel=ReadMessageItem',
    )
  })

  it('an unparseable attachment URL changes nothing — degrades to the old behaviour', () => {
    // The existing fixture's webUrl is a plain SharePoint path, not an OWA link.
    const row = shapeSharedInsight(
      shared('invoice.pdf', 'Thibault Draye', 'microsoft.graph.fileAttachment', 'Attachment'),
    )!
    expect(row.name).toBe('invoice.pdf')
    expect(row.webUrl).toBe('https://contoso.sharepoint.com/x/invoice.pdf')
  })

  it('a Teams chat paste is via=teams even though Graph calls it an Attachment', () => {
    const row = shapeSharedInsight(teamsPaste("Capture d'écran.png", 'David Budin'))!
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
        shared('someone-elses.docx', 'Quentin Delière'),
        shared('my-screen-recording.mov', 'Michael Accetto'),
      ],
    })
    const items = ((await runAppTool('graph_files_shared', {})).data as GraphSharedFilesResult)
      .items
    expect(items.map((i) => i.shared_by)).toEqual(['Quentin Delière', 'Michael Accetto'])
  })

  it('shared_by is the actor, so it can be pointed at the signed-in person', async () => {
    // The only route to those rows today: resolve the display name via graph_me,
    // then filter on it. Partial coverage — not a substitute for an outbound feed.
    graphFetch.mockResolvedValue({
      value: [
        shared('someone-elses.docx', 'Quentin Delière'),
        shared('my-screen-recording.mov', 'Michael Accetto'),
      ],
    })
    const items = (
      (await runAppTool('graph_files_shared', { shared_by: 'Michael Accetto' }))
        .data as GraphSharedFilesResult
    ).items
    expect(items.map((i) => i.name)).toEqual(['my-screen-recording.mov'])
  })

  it('shared_by filters case-insensitively on a partial name, and inflates $top to 50', async () => {
    const res = await runAppTool('graph_files_shared', { shared_by: 'thibault' })
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
    expect(data.note).toMatch(/Nobody Here/)
    expect(data.note).toMatch(/graph_files_search/)
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
        shared('plan.docx', 'Quentin Delière'),
        teamsPaste('screenshot.png', 'David Budin'),
        owaAttachment('MSG-1', 'invoice.pdf', 'Chargemap Business'),
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
    const res = await runAppTool('graph_files_shared', { shared_by: 'Quentin', via: 'email' })
    const data = res.data as GraphSharedFilesResult
    expect(data.items).toEqual([])
    expect(data.note).toMatch(/by "Quentin"/)
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
        owaAttachment('MSG-OLD', 'old.pdf', 'Denis Budin', '2026-07-29T15:20:25Z'),
        teamsPaste('newest.png', 'David Budin', '2026-08-03T12:01:58Z'),
        shared('middle.docx', 'Quentin Delière'), // 2026-07-30T08:00:00Z
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
        shared('old-share.docx', 'Quentin Delière'), // 2026-07-30
        teamsPaste('today-a.png', 'David Budin', '2026-08-03T12:01:58Z'),
        teamsPaste('today-b.png', 'David Budin', '2026-08-03T11:16:58Z'),
      ],
    })
    const res = await runAppTool('graph_files_shared', { limit: 2 })
    expect((res.data as GraphSharedFilesResult).items.map((i) => i.name)).toEqual([
      'today-a.png',
      'today-b.png',
    ])
  })

  it('a row with an unparseable date sorts last instead of jumping to the front', async () => {
    const undated = shared('undated.docx', 'Quentin Delière')
    undated.lastShared.sharedDateTime = 'not a date'
    graphFetch.mockResolvedValue({
      value: [undated, teamsPaste('dated.png', 'David Budin', '2026-08-03T12:01:58Z')],
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
        owaAttachment('MSG-TESLA', 'TCO simulation.pdf', 'Denis Budin'),
        owaAttachment('MSG-TESLA', 'TCO recap.pdf', 'Denis Budin'),
        owaAttachment('MSG-TESLA', 'Offre QUO26GQ0D.pdf', 'Denis Budin'),
        owaAttachment('MSG-TESLA', "Option d'achat.pdf", 'Denis Budin'),
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
        owaAttachment('MSG-A', 'a1.pdf', 'Chargemap Business'),
        owaAttachment('MSG-A', 'a2.pdf', 'Chargemap Business'),
        owaAttachment('MSG-B', 'b1.png', 'Quentin Delière'),
        owaAttachment('MSG-B', 'b2.png', 'Quentin Delière'),
      ],
    })
    const items = ((await runAppTool('graph_files_shared', {})).data as GraphSharedFilesResult)
      .items
    expect(items.map((i) => i.email_group)).toEqual([1, 1, 2, 2])
  })

  it('omits the field entirely for an email that shared one file', async () => {
    graphFetch.mockResolvedValue({
      value: [owaAttachment('MSG-SOLO', 'solo.pdf', 'Chargemap Business')],
    })
    const items = ((await runAppTool('graph_files_shared', {})).data as GraphSharedFilesResult)
      .items
    // Absent, not undefined-valued — nothing to explain to the model.
    expect(items[0]).not.toHaveProperty('email_group')
  })

  it('collapses the same file arriving twice from the same message', async () => {
    graphFetch.mockResolvedValue({
      value: [
        owaAttachment('MSG-A', 'dupe.pdf', 'Chargemap Business'),
        owaAttachment('MSG-A', 'dupe.pdf', 'Chargemap Business'),
        owaAttachment('MSG-A', 'other.pdf', 'Chargemap Business'),
      ],
    })
    const items = ((await runAppTool('graph_files_shared', {})).data as GraphSharedFilesResult)
      .items
    expect(items.map((i) => i.name)).toEqual(['dupe.pdf', 'other.pdf'])
  })
})
