/**
 * Calendar + mail connector tools (#110). Moved co-located with the module
 * (#225 PR-C2); composed through the harness instead of the host barrel.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { buildGraphHarness } from './harness'
import { shapeEvents, shapeMessages, localDayBounds } from '../../graph/graph-tools.server'

const h = buildGraphHarness()
const { runAppTool, appToolDescriptions } = h
const graphFetch = h.graphFetch

/** Last graphFetch call as [userId, path, init]. */
function lastCall() {
  return graphFetch.mock.calls.at(-1) as [
    string,
    string,
    { scopes?: string[]; headers?: Record<string, string> },
  ]
}

beforeEach(() => {
  h.restoreDefaults()
})

describe('tool advertisement', () => {
  // Mutations: request Mail.Send; request Calendars.ReadWrite outside the calendar;
  // omit scopes; or change a reader to POST. Every one must turn this pin red.
  it('keeps every registered Graph tool on explicit reader scopes and methods', async () => {
    const inputs: Record<string, Record<string, unknown>> = {
      graph_calendar_today: {},
      graph_calendar_range: { start: '2026-09-01', end: '2026-09-30' },
      graph_mail_recent: {},
      graph_me: {},
      graph_file_ingest: { item_id: 'file-1' },
      graph_files_search: { query: 'budget' },
      graph_files_list: {},
      graph_files_recent: {},
      graph_files_shared: {},
      graph_mail_attachments: {},
    }
    expect(
      appToolDescriptions()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(Object.keys(inputs).sort())

    for (const { name } of appToolDescriptions()) {
      graphFetch.mockClear()
      if (name === 'graph_file_ingest') {
        graphFetch
          .mockResolvedValueOnce({
            id: 'file-1',
            name: 'note.txt',
            size: 4,
            file: { mimeType: 'text/plain' },
          })
          .mockResolvedValueOnce(Buffer.from('note').toString('base64'))
      }
      expect((await runAppTool(name, inputs[name])).success, name).toBe(true)
      expect(graphFetch.mock.calls.length, name).toBe(name === 'graph_file_ingest' ? 2 : 1)
      for (const [, path, init] of graphFetch.mock.calls) {
        expect(init?.scopes?.length, `${name} must declare scopes`).toBeGreaterThan(0)
        const scopes = (init.scopes as string[]).map((scope) => scope.toLowerCase())
        expect(scopes, name).not.toContain('mail.send')
        if (name === 'graph_calendar_today' || name === 'graph_calendar_range') {
          expect(scopes, name).toEqual(['calendars.readwrite'])
        } else {
          expect(scopes, name).not.toContain('calendars.readwrite')
        }
        expect(init.method ?? 'GET', name).toBe(name === 'graph_files_search' ? 'POST' : 'GET')
        if (name === 'graph_files_search') expect(path).toBe('/search/query')
      }
    }
  })

  it('registers both connectors with no credential field', () => {
    const names = appToolDescriptions().map((t) => t.name)
    expect(names).toContain('graph_calendar_today')
    expect(names).toContain('graph_calendar_range')
    expect(names).toContain('graph_mail_recent')

    for (const t of appToolDescriptions()) {
      const schema = JSON.stringify(t.inputSchema).toLowerCase()
      for (const bad of ['token', 'credential', 'secret', 'userid', 'user_id']) {
        expect(schema, `${t.name} leaks ${bad}`).not.toContain(bad)
      }
    }
  })
})

describe('graph_calendar_range', () => {
  afterEach(() => vi.unstubAllEnvs())

  const dates = { start: '2026-10-24', end: '2026-10-26' }
  const next = (page: number) =>
    `https://graph.microsoft.com/v1.0/me/calendarView?$skiptoken=page${page}`
  const event = (subject: string, start: string, end: string) => ({
    subject,
    start: { dateTime: start },
    end: { dateTime: end },
    organizer: { emailAddress: { address: 'person@example.org' } },
  })

  it('advertises strict dates, the effective timezone and boundary contract', async () => {
    vi.stubEnv('GRAPH_TIMEZONE', 'Europe/Brussels')
    const configured = buildGraphHarness()
    configured.restoreDefaults()
    const tool = configured.appToolDescriptions().find((t) => t.name === 'graph_calendar_range')!
    expect(tool.inputSchema).toMatchObject({
      required: ['start', 'end'],
      additionalProperties: false,
      properties: {
        start: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
        end: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      },
    })
    expect(JSON.stringify(tool.inputSchema)).toContain('overlapping either boundary')
    expect(tool.description).toContain('YYYY-MM-DD')
    expect(tool.description).toContain('Europe/Brussels')
    const res = await configured.runAppTool('graph_calendar_range', dates)
    expect(res.success).toBe(true)
    const [principal, path, init] = configured.graphFetch.mock.calls[0] as ReturnType<
      typeof lastCall
    >
    expect(principal).toBe('oid-1')
    const query = new URL(path, 'https://graph.microsoft.com').searchParams
    expect(path.startsWith('/me/calendarView?')).toBe(true)
    expect(query.get('startDateTime')).toBe('2026-10-24T00:00:00+02:00')
    expect(query.get('endDateTime')).toBe('2026-10-27T00:00:00+01:00')
    expect(query.get('$top')).toBe('50')
    expect(query.get('$orderby')).toBe('start/dateTime')
    expect(init).toMatchObject({
      method: 'GET',
      scopes: ['Calendars.ReadWrite'],
      headers: { Prefer: 'outlook.timezone="Europe/Brussels"' },
    })
    expect(res.data).toMatchObject({
      start: dates.start,
      end: dates.end,
      timezone: 'Europe/Brussels',
      requestedDates: {
        format: 'YYYY-MM-DD',
        startInclusive: dates.start,
        endInclusive: dates.end,
      },
      window: {
        startInclusive: '2026-10-24T00:00:00+02:00',
        endExclusive: '2026-10-27T00:00:00+01:00',
      },
      count: 0,
      truncated: false,
    })
  })

  it('defaults to the server timezone when GRAPH_TIMEZONE is empty', async () => {
    vi.stubEnv('GRAPH_TIMEZONE', '')
    const res = await runAppTool('graph_calendar_range', dates)
    expect(res.data).toMatchObject({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
    expect(lastCall()[2].headers?.Prefer).toBe(
      `outlook.timezone="${Intl.DateTimeFormat().resolvedOptions().timeZone}"`,
    )
  })

  it.each([
    [{ start: '2026-09-05', end: '2026-09-05' }, 'endDateTime'],
    [{ start: '2026-09-06', end: '2026-09-06' }, 'startDateTime'],
  ] as const)(
    'uses the first valid instant after a skipped local midnight',
    async (dates, bound) => {
      vi.stubEnv('GRAPH_TIMEZONE', 'America/Santiago')
      const res = await runAppTool('graph_calendar_range', dates)
      expect(res.success).toBe(true)
      const query = new URL(lastCall()[1], 'https://graph.microsoft.com').searchParams
      const value = query.get(bound)
      expect(value).toBe('2026-09-06T01:00:00-03:00')
      expect(new Date(value!).toISOString()).toBe('2026-09-06T04:00:00.000Z')
    },
  )

  it('uses the first later local date when the exclusive date was skipped', async () => {
    vi.stubEnv('GRAPH_TIMEZONE', 'Pacific/Apia')
    const res = await runAppTool('graph_calendar_range', {
      start: '2011-12-29',
      end: '2011-12-29',
    })
    expect(res.success).toBe(true)
    expect(graphFetch).toHaveBeenCalledTimes(1)
    const query = new URL(lastCall()[1], 'https://graph.microsoft.com').searchParams
    expect(query.get('startDateTime')).toBe('2011-12-29T00:00:00-10:00')
    expect(query.get('endDateTime')).toBe('2011-12-31T00:00:00+14:00')
    expect(new Date(query.get('endDateTime')!).toISOString()).toBe('2011-12-30T10:00:00.000Z')
    expect(res.data).toMatchObject({
      requestedDates: { startInclusive: '2011-12-29', endInclusive: '2011-12-29' },
      window: { endExclusive: '2011-12-31T00:00:00+14:00' },
    })
  })

  it('returns an empty window without calling Graph for a skipped requested date', async () => {
    vi.stubEnv('GRAPH_TIMEZONE', 'Pacific/Apia')
    const res = await runAppTool('graph_calendar_range', {
      start: '2011-12-30',
      end: '2011-12-30',
    })
    expect(res.success).toBe(true)
    expect(graphFetch).not.toHaveBeenCalled()
    expect(res.data).toMatchObject({
      requestedDates: { startInclusive: '2011-12-30', endInclusive: '2011-12-30' },
      window: {
        startInclusive: '2011-12-31T00:00:00+14:00',
        endExclusive: '2011-12-31T00:00:00+14:00',
      },
      events: [],
      count: 0,
      truncated: false,
    })
  })

  it('keeps an exact historical seconds offset as a Graph-compatible UTC bound', async () => {
    vi.stubEnv('GRAPH_TIMEZONE', 'Africa/Monrovia')
    const res = await runAppTool('graph_calendar_range', {
      start: '1972-01-07',
      end: '1972-01-07',
    })
    expect(res.success).toBe(true)
    const query = new URL(lastCall()[1], 'https://graph.microsoft.com').searchParams
    expect(query.get('startDateTime')).toBe('1972-01-07T00:44:30+00:00')
    expect(new Date(query.get('startDateTime')!).toISOString()).toBe('1972-01-07T00:44:30.000Z')
    graphFetch.mockClear()
    const prior = await runAppTool('graph_calendar_range', {
      start: '1972-01-06',
      end: '1972-01-06',
    })
    expect(prior.success).toBe(true)
    const priorQuery = new URL(lastCall()[1], 'https://graph.microsoft.com').searchParams
    expect(priorQuery.get('startDateTime')).toBe('1972-01-06T00:44:30.000Z')
  })

  it('accepts exactly 92 inclusive calendar days', async () => {
    expect(
      (await runAppTool('graph_calendar_range', { start: '2026-09-01', end: '2026-12-01' }))
        .success,
    ).toBe(true)
    expect(
      new URL(lastCall()[1], 'https://graph.microsoft.com').searchParams.get('endDateTime'),
    ).toContain('2026-12-02T00:00:00')
  })

  it('uses calendarView occurrences and includes events overlapping both boundaries across DST', async () => {
    vi.stubEnv('GRAPH_TIMEZONE', 'Europe/Brussels')
    graphFetch.mockResolvedValueOnce({
      value: [
        event('Starts before', '2026-10-23T23:30:00', '2026-10-24T00:30:00'),
        event('Recurring occurrence', '2026-10-25T09:00:00', '2026-10-25T09:30:00'),
        event('Ends after', '2026-10-26T23:30:00', '2026-10-27T00:30:00'),
      ],
    })
    const res = await runAppTool('graph_calendar_range', dates)
    expect(res.success).toBe(true)
    expect((res.data as { events: { subject: string }[] }).events.map((e) => e.subject)).toEqual([
      'Starts before',
      'Recurring occurrence',
      'Ends after',
    ])
    expect(
      new URL(lastCall()[1], 'https://graph.microsoft.com').searchParams.get('endDateTime'),
    ).toBe('2026-10-27T00:00:00+01:00')
  })

  it('follows at most four 50-event pages and reports truncation without a continuation token', async () => {
    for (let page = 1; page <= 4; page++) {
      graphFetch.mockResolvedValueOnce({
        value: Array.from({ length: 50 }, (_, i) =>
          event(`p${page}-${i}`, '2026-09-01T09:00:00', '2026-09-01T10:00:00'),
        ),
        '@odata.nextLink': next(page + 1),
      })
    }
    const res = await runAppTool('graph_calendar_range', { start: '2026-09-01', end: '2026-09-30' })
    expect(graphFetch).toHaveBeenCalledTimes(4)
    expect(graphFetch.mock.calls[1][1]).toBe('/me/calendarView?$skiptoken=page2')
    expect(res.data).toMatchObject({
      count: 200,
      truncated: true,
      hint: expect.stringContaining('Narrow'),
    })
    expect(res.data as object).not.toHaveProperty('nextLink')
    expect((res.data as { events: unknown[] }).events).toHaveLength(200)
  })

  it('marks an exact last page complete and a short fourth page with a next link incomplete', async () => {
    graphFetch.mockResolvedValueOnce({
      value: [event('one', '2026-09-01T09:00:00', '2026-09-01T10:00:00')],
      '@odata.nextLink': next(2),
    })
    graphFetch.mockResolvedValueOnce({
      value: [event('two', '2026-09-02T09:00:00', '2026-09-02T10:00:00')],
    })
    expect((await runAppTool('graph_calendar_range', dates)).data).toMatchObject({
      count: 2,
      truncated: false,
    })
    graphFetch.mockClear()
    for (let page = 1; page <= 4; page++)
      graphFetch.mockResolvedValueOnce({
        value: [event(String(page), '2026-09-01T09:00:00', '2026-09-01T10:00:00')],
        '@odata.nextLink': next(page + 1),
      })
    expect((await runAppTool('graph_calendar_range', dates)).data).toMatchObject({
      count: 4,
      truncated: true,
    })
    expect(graphFetch).toHaveBeenCalledTimes(4)
  })

  it('reports 200 events as complete when the fourth page has no continuation', async () => {
    for (let page = 1; page <= 4; page++) {
      graphFetch.mockResolvedValueOnce({
        value: Array.from({ length: 50 }, (_, i) =>
          event(`p${page}-${i}`, '2026-09-01T09:00:00', '2026-09-01T10:00:00'),
        ),
        ...(page < 4 ? { '@odata.nextLink': next(page + 1) } : {}),
      })
    }
    expect((await runAppTool('graph_calendar_range', dates)).data).toMatchObject({
      count: 200,
      truncated: false,
    })
    expect(graphFetch).toHaveBeenCalledTimes(4)
  })

  it.each([
    [{ end: '2026-09-30' }, 'required valid'],
    [{ start: '2026-09-01' }, 'required valid'],
    [{ start: '2026-02-30', end: '2026-03-01' }, 'required valid'],
    [{ start: '2026-9-01', end: '2026-09-30' }, 'required valid'],
    [{ start: '2026-09-30', end: '2026-09-01' }, 'on or after'],
    [{ start: '2026-09-01', end: '2026-12-02' }, 'at most 92'],
  ])('rejects invalid range %j before Graph access', async (args, message) => {
    const res = await runAppTool('graph_calendar_range', args)
    expect(res).toMatchObject({ success: false, error: expect.stringContaining(message) })
    expect(graphFetch).not.toHaveBeenCalled()
  })

  it('refuses an unauthenticated call before Graph access', async () => {
    h.setScope({ userId: null })
    expect(await runAppTool('graph_calendar_range', dates)).toMatchObject({
      success: false,
      error: expect.stringContaining('authenticated user'),
    })
    expect(graphFetch).not.toHaveBeenCalled()
  })

  it('refuses a continuation outside the calendarView endpoint before sending credentials', async () => {
    graphFetch.mockResolvedValueOnce({ value: [], '@odata.nextLink': 'https://example.org/steal' })
    expect(await runAppTool('graph_calendar_range', dates)).toMatchObject({
      success: false,
      error: expect.stringContaining('invalid calendar continuation'),
    })
    expect(graphFetch).toHaveBeenCalledTimes(1)
  })
})

describe('localDayBounds', () => {
  it('returns naive local ISO bounds for the day (no Z — Graph applies Prefer tz)', () => {
    const { start, end } = localDayBounds(new Date(2026, 6, 27, 15, 30))
    expect(start).toBe('2026-07-27T00:00:00')
    expect(end).toBe('2026-07-27T23:59:59')
    expect(start.endsWith('Z')).toBe(false)
  })

  it('applies a day offset, crossing month boundaries', () => {
    expect(localDayBounds(new Date(2026, 6, 31, 12, 0), 1).start).toBe('2026-08-01T00:00:00')
    expect(localDayBounds(new Date(2026, 7, 1, 12, 0), -1).start).toBe('2026-07-31T00:00:00')
  })
})

describe('graph_calendar_today', () => {
  it('queries calendarView for today with an ordered window + timezone header', async () => {
    const res = await runAppTool('graph_calendar_today', {})
    expect(res.success).toBe(true)

    const [userId, path, init] = lastCall()
    expect(userId).toBe('oid-1')
    expect(path).toContain('/me/calendarView') // expands recurring series
    expect(path).toContain('startDateTime=')
    expect(path).toContain('$orderby=start/dateTime')
    expect(init.scopes).toEqual(['Calendars.ReadWrite'])
    expect(init.headers?.Prefer).toMatch(/^outlook\.timezone="/)
  })

  it('honours day_offset and reports the day it queried', async () => {
    const today = (await runAppTool('graph_calendar_today', {})).data as { day: string }
    const tomorrow = (await runAppTool('graph_calendar_today', { day_offset: 1 })).data as {
      day: string
    }
    expect(tomorrow.day).not.toBe(today.day)
  })

  it('ignores a non-numeric day_offset instead of building a broken query', async () => {
    const res = await runAppTool('graph_calendar_today', { day_offset: 'junk' })
    expect(res.success).toBe(true)
    expect(lastCall()[1]).not.toContain('NaN')
  })

  it("flattens Graph's nested event shape", () => {
    const events = shapeEvents({
      value: [
        {
          subject: 'Standup',
          start: { dateTime: '2026-07-27T09:00:00.0000000', timeZone: 'Europe/Brussels' },
          end: { dateTime: '2026-07-27T09:15:00.0000000' },
          isAllDay: false,
          location: { displayName: 'Teams' },
          organizer: { emailAddress: { name: 'Ada', address: 'ada@corp.com' } },
          onlineMeetingUrl: 'https://teams/x',
        },
      ],
    })
    expect(events).toEqual([
      {
        subject: 'Standup',
        start: '2026-07-27T09:00:00.0000000',
        end: '2026-07-27T09:15:00.0000000',
        isAllDay: false,
        location: 'Teams',
        organizer: 'Ada',
        onlineMeetingUrl: 'https://teams/x',
      },
    ])
  })

  it('shapeEvents tolerates missing/garbage payloads', () => {
    expect(shapeEvents(null)).toEqual([])
    expect(shapeEvents({})).toEqual([])
    expect(shapeEvents({ value: [{}] })[0]).toMatchObject({
      subject: null,
      start: null,
      isAllDay: false,
      organizer: null,
    })
  })
})

describe('graph_mail_recent', () => {
  it('reads the inbox newest-first with Mail.Read', async () => {
    await runAppTool('graph_mail_recent', {})
    const [, path, init] = lastCall()
    expect(path).toContain('/me/mailFolders/inbox/messages')
    expect(path).toContain('$orderby=receivedDateTime desc')
    expect(path).toContain('$top=10')
    expect(path).not.toContain('$filter')
    expect(init.scopes).toEqual(['Mail.Read'])
  })

  it('filters to unread when asked', async () => {
    await runAppTool('graph_mail_recent', { unread_only: true })
    expect(lastCall()[1]).toContain('$filter=isRead eq false')
  })

  it('clamps limit into 1..25', async () => {
    await runAppTool('graph_mail_recent', { limit: 999 })
    expect(lastCall()[1]).toContain('$top=25')
    await runAppTool('graph_mail_recent', { limit: 0 })
    expect(lastCall()[1]).toContain('$top=10') // 0 is falsy → default
    await runAppTool('graph_mail_recent', { limit: -5 })
    expect(lastCall()[1]).toContain('$top=1')
  })

  it('compacts messages and truncates the preview', () => {
    const [msg] = shapeMessages({
      value: [
        {
          subject: 'Invoice',
          from: { emailAddress: { name: 'Bob', address: 'bob@x.com' } },
          receivedDateTime: '2026-07-27T08:00:00Z',
          isRead: false,
          hasAttachments: true,
          bodyPreview: 'x'.repeat(1000),
          webLink: 'https://outlook/1',
        },
      ],
    })
    expect(msg).toMatchObject({
      subject: 'Invoice',
      from: 'Bob',
      isRead: false,
      hasAttachments: true,
      webLink: 'https://outlook/1',
    })
    expect(msg.preview).toHaveLength(300)
  })

  it('falls back to the sender address when no display name exists', () => {
    const [msg] = shapeMessages({
      value: [{ from: { emailAddress: { address: 'no-name@x.com' } } }],
    })
    expect(msg.from).toBe('no-name@x.com')
  })

  it('shapeMessages tolerates garbage', () => {
    expect(shapeMessages(null)).toEqual([])
    expect(shapeMessages({ value: 'nope' })).toEqual([])
  })
})
