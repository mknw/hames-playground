/**
 * Roster ingest, with Graph and Neo4j both doubled — no tenant, no network,
 * no database.
 *
 * What is worth pinning here is not "it writes rows". It is the behaviour a
 * reader of the report has to be able to trust:
 *  - the two required-property tiers produce different outcomes;
 *  - `fetched === written + rejectedRows` holds, including when one row breaks
 *    two hard properties at once;
 *  - pagination is followed rather than silently truncated at page one;
 *  - a departed member is counted, never deleted;
 *  - the report carries no identity;
 *  - the group probe spends one request and refuses to write nameless Teams.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

const { GraphAppPermissionError } = vi.hoisted(() => ({
  GraphAppPermissionError: class extends Error {
    constructor(
      message: string,
      readonly status: number,
    ) {
      super(message)
      this.name = 'GraphAppPermissionError'
    }
  },
}))

const graphAppFetch = vi.fn<(path: string) => Promise<unknown>>()
vi.mock('../../../lib/auth/graph-token.server', () => ({
  graphAppFetch: (path: string) => graphAppFetch(path),
  GraphAppPermissionError,
}))

type Row = Record<string, unknown>
const queue: Row[][] = []
const sessionRun = vi.fn(async (..._args: unknown[]) => ({
  records: (queue.shift() ?? []).map((row) => ({ get: (k: string) => row[k] })),
}))
const sessionClose = vi.fn(async () => undefined)
const driverSession = vi.fn((_opts?: unknown) => ({ run: sessionRun, close: sessionClose }))
vi.mock('../../../lib/neo4j/client', () => ({
  getNeo4jDriver: () => ({ session: driverSession }),
}))

const ensureOrgGraphSchema = vi.fn(async () => undefined)
vi.mock('../../../lib/org-graph/schema.server', () => ({
  ensureOrgGraphSchema: () => ensureOrgGraphSchema(),
}))

const mod = () => import('../../../lib/org-graph/roster-ingest.server')

const user = (n: number, over: Row = {}): Row => ({
  id: `oid-${n}`,
  displayName: `Person ${n}`,
  mail: `person${n}@example.test`,
  department: 'Delivery',
  jobTitle: 'Engineer',
  ...over,
})

const page = (rows: Row[], nextLink?: string): Row =>
  nextLink ? { value: rows, '@odata.nextLink': nextLink } : { value: rows }

/** Answer the group probe with "denied", the live-tenant case. */
const denyGroups = (): void => {
  graphAppFetch.mockImplementation(async (path) => {
    if (path.startsWith('/groups')) throw new GraphAppPermissionError('denied', 403)
    throw new Error(`unexpected path ${path}`)
  })
}

const cypher = (): string[] => sessionRun.mock.calls.map((c) => String(c[0]))
const paramsOf = (index: number) => sessionRun.mock.calls[index][1] as Record<string, unknown>

beforeEach(() => {
  vi.clearAllMocks()
  queue.length = 0
  graphAppFetch.mockReset()
})

describe('fetchDirectoryMembers', () => {
  it('filters server-side on enabled members and selects only ontology fields', async () => {
    const { fetchDirectoryMembers, DIRECTORY_FILTER, DIRECTORY_SELECT } = await mod()
    graphAppFetch.mockResolvedValueOnce(page([user(1)]))

    await fetchDirectoryMembers()

    const path = graphAppFetch.mock.calls[0][0]
    expect(path).toContain(encodeURIComponent(DIRECTORY_FILTER))
    expect(path).toContain(DIRECTORY_SELECT)
    // Not `$select=*`: the full user resource is far more personal data than
    // this graph holds.
    expect(DIRECTORY_SELECT).not.toContain('*')
    expect(DIRECTORY_FILTER).toContain('accountEnabled eq true')
    expect(DIRECTORY_FILTER).toContain("userType eq 'Member'")
  })

  it('follows @odata.nextLink instead of stopping at the first page', async () => {
    const { fetchDirectoryMembers } = await mod()
    graphAppFetch
      .mockResolvedValueOnce(page([user(1)], 'https://graph.microsoft.com/v1.0/users?$skiptoken=x'))
      .mockResolvedValueOnce(page([user(2)]))

    const result = await fetchDirectoryMembers()

    expect(result.pages).toBe(2)
    expect(result.fetched).toBe(2)
    expect(result.members).toHaveLength(2)
    expect(graphAppFetch.mock.calls[1][0]).toContain('$skiptoken=x')
  })

  it('rejects a row with no mail and counts the property', async () => {
    const { fetchDirectoryMembers } = await mod()
    graphAppFetch.mockResolvedValueOnce(page([user(1), user(2, { mail: null })]))

    const result = await fetchDirectoryMembers()

    expect(result.members).toHaveLength(1)
    expect(result.rejectedRows).toBe(1)
    expect(result.rejected).toEqual({ mail: 1 })
  })

  it('keeps rejectedRows a ROW count when one row breaks two hard properties', async () => {
    // The tallies are per-property and deliberately overlap; row arithmetic has
    // to come from its own counter or the report stops adding up.
    const { fetchDirectoryMembers } = await mod()
    graphAppFetch.mockResolvedValueOnce(page([user(1, { mail: null, displayName: '  ' })]))

    const result = await fetchDirectoryMembers()

    expect(result.fetched).toBe(1)
    expect(result.rejectedRows).toBe(1)
    expect(result.rejected).toEqual({ displayName: 1, mail: 1 })
    expect(result.members).toHaveLength(0)
  })

  it('writes a soft-incomplete row through and counts it', async () => {
    const { fetchDirectoryMembers } = await mod()
    graphAppFetch.mockResolvedValueOnce(
      page([user(1, { department: null }), user(2, { department: null, jobTitle: null })]),
    )

    const result = await fetchDirectoryMembers()

    expect(result.members).toHaveLength(2)
    expect(result.rejectedRows).toBe(0)
    expect(result.incomplete).toEqual({ department: 2, jobTitle: 1 })
  })

  it('does not count a rejected row in the incomplete tally', async () => {
    const { fetchDirectoryMembers } = await mod()
    graphAppFetch.mockResolvedValueOnce(page([user(1, { mail: null, department: null })]))

    const result = await fetchDirectoryMembers()

    expect(result.rejected).toEqual({ mail: 1 })
    expect(result.incomplete).toEqual({})
  })

  it('normalises whitespace out of the values it keeps', async () => {
    const { fetchDirectoryMembers } = await mod()
    graphAppFetch.mockResolvedValueOnce(page([user(1, { displayName: '  Person 1  ' })]))

    const result = await fetchDirectoryMembers()
    expect(result.members[0].displayName).toBe('Person 1')
  })
})

describe('upsertMembers', () => {
  it('MERGEs on the unique key so a second run creates nothing', async () => {
    const { upsertMembers } = await mod()
    queue.push([{ written: 2 }])

    const written = await upsertMembers([
      { entraId: 'a', displayName: 'A', mail: 'a@x.test', department: null, jobTitle: null },
      { entraId: 'b', displayName: 'B', mail: 'b@x.test', department: 'D', jobTitle: 'J' },
    ])

    expect(written).toBe(2)
    const statement = cypher()[0]
    expect(statement).toContain('MERGE (m:Member {entraId: row.entraId})')
    expect(statement).not.toMatch(/\bCREATE\b/)
    // Values ride as parameters, never interpolated.
    expect(paramsOf(0).rows).toHaveLength(2)
  })

  it('stamps syncedAt from the database clock, not the process clock', async () => {
    // The staleness comparison is against a server timestamp; mixing in a
    // container's clock would make "not seen in this run" skew-dependent.
    const { upsertMembers } = await mod()
    queue.push([{ written: 1 }])
    await upsertMembers([
      { entraId: 'a', displayName: 'A', mail: 'a@x.test', department: null, jobTitle: null },
    ])
    expect(cypher()[0]).toContain('m.syncedAt    = datetime()')
  })

  it('runs no query for an empty roster', async () => {
    const { upsertMembers } = await mod()
    await expect(upsertMembers([])).resolves.toBe(0)
    expect(sessionRun).not.toHaveBeenCalled()
  })

  it('closes the session when the write throws', async () => {
    const { upsertMembers } = await mod()
    sessionRun.mockRejectedValueOnce(new Error('constraint violation'))
    await expect(
      upsertMembers([
        { entraId: 'a', displayName: 'A', mail: 'a@x.test', department: null, jobTitle: null },
      ]),
    ).rejects.toThrow('constraint violation')
    expect(sessionClose).toHaveBeenCalledTimes(1)
  })
})

describe('countStaleMembers', () => {
  it('counts and never deletes', async () => {
    const { countStaleMembers } = await mod()
    queue.push([{ stale: 3 }])

    await expect(countStaleMembers(new Date('2026-08-25T00:00:00Z'))).resolves.toBe(3)
    expect(cypher()[0]).not.toMatch(/\b(DELETE|DETACH|SET|REMOVE)\b/i)
    expect(paramsOf(0).since).toBe('2026-08-25T00:00:00.000Z')
  })

  it('treats a member with no syncedAt as stale', async () => {
    const { countStaleMembers } = await mod()
    queue.push([{ stale: 1 }])
    await countStaleMembers(new Date(0))
    expect(cypher()[0]).toContain('m.syncedAt IS NULL')
  })
})

describe('probeGroupReadAccess', () => {
  it('reports the permission gap on a 403 and spends exactly one request', async () => {
    const { probeGroupReadAccess } = await mod()
    denyGroups()

    const result = await probeGroupReadAccess()

    expect(result.ok).toBe(false)
    expect(result.reason).toContain('Group.Read.All')
    expect(graphAppFetch).toHaveBeenCalledTimes(1)
  })

  it('reports the id-only case, where groups are visible but not nameable', async () => {
    // The subtler live failure: `memberOf` succeeds and returns group ids while
    // every group property is withheld, so a Team node could be created with no
    // name at all.
    const { probeGroupReadAccess } = await mod()
    graphAppFetch.mockResolvedValueOnce(page([{ id: 'g1' }]))

    const result = await probeGroupReadAccess()
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('displayName')
  })

  it('passes when groups come back named', async () => {
    const { probeGroupReadAccess } = await mod()
    graphAppFetch.mockResolvedValueOnce(page([{ id: 'g1', displayName: 'Delivery' }]))
    await expect(probeGroupReadAccess()).resolves.toEqual({ ok: true, reason: null })
  })

  it('propagates a non-permission error rather than reporting it as blocked', async () => {
    const { probeGroupReadAccess } = await mod()
    graphAppFetch.mockRejectedValueOnce(new Error('socket hang up'))
    await expect(probeGroupReadAccess()).rejects.toThrow('socket hang up')
  })
})

describe('ingestMemberships', () => {
  const members = [
    { entraId: 'oid-1', displayName: 'A', mail: 'a@x.test', department: null, jobTitle: null },
  ]

  it('writes nothing and spends no per-member request when the probe is blocked', async () => {
    const { ingestMemberships } = await mod()
    denyGroups()

    const report = await ingestMemberships(members)

    expect(report).toEqual({
      attempted: false,
      blockedReason: expect.stringContaining('Group.Read.All'),
      teams: 0,
      edges: 0,
    })
    expect(graphAppFetch).toHaveBeenCalledTimes(1)
    expect(sessionRun).not.toHaveBeenCalled()
  })

  it('writes Team nodes and MEMBER_OF edges when groups are nameable', async () => {
    const { ingestMemberships } = await mod()
    graphAppFetch
      .mockResolvedValueOnce(page([{ id: 'g0', displayName: 'Probe' }]))
      .mockResolvedValueOnce(
        page([
          { id: 'g1', displayName: 'Delivery' },
          { id: 'g2', displayName: 'Board' },
        ]),
      )
    queue.push([]) // team MERGE
    queue.push([{ edges: 2 }]) // MEMBER_OF MERGE

    const report = await ingestMemberships(members)

    expect(report).toEqual({ attempted: true, blockedReason: null, teams: 2, edges: 2 })
    expect(cypher()[0]).toContain('MERGE (t:Team {entraId: row.entraId})')
    expect(cypher()[1]).toContain('MERGE (m)-[:MEMBER_OF]->(t)')
  })

  it('skips a group whose displayName is withheld rather than writing a nameless Team', async () => {
    const { ingestMemberships } = await mod()
    graphAppFetch
      .mockResolvedValueOnce(page([{ id: 'g0', displayName: 'Probe' }]))
      .mockResolvedValueOnce(page([{ id: 'g1' }, { id: 'g2', displayName: 'Board' }]))
    queue.push([])
    queue.push([{ edges: 1 }])

    const report = await ingestMemberships(members)
    expect(report.teams).toBe(1)
    expect((paramsOf(0).rows as Row[]).map((r) => r.entraId)).toEqual(['g2'])
  })

  it('reports the empty outcome rather than writing an empty UNWIND', async () => {
    const { ingestMemberships } = await mod()
    graphAppFetch
      .mockResolvedValueOnce(page([{ id: 'g0', displayName: 'Probe' }]))
      .mockResolvedValueOnce(page([]))

    const report = await ingestMemberships(members)
    expect(report).toEqual({
      attempted: true,
      blockedReason: 'no named groups returned for any member',
      teams: 0,
      edges: 0,
    })
    expect(sessionRun).not.toHaveBeenCalled()
  })

  it('casts memberOf to groups so directory roles are not read as teams', async () => {
    const { ingestMemberships } = await mod()
    graphAppFetch
      .mockResolvedValueOnce(page([{ id: 'g0', displayName: 'Probe' }]))
      .mockResolvedValueOnce(page([]))
    await ingestMemberships(members)
    expect(graphAppFetch.mock.calls[1][0]).toContain('/memberOf/microsoft.graph.group')
  })
})

describe('ingestRoster', () => {
  it('applies the schema before writing anything', async () => {
    const { ingestRoster } = await mod()
    graphAppFetch.mockResolvedValueOnce(page([user(1)]))
    denyGroupsAfterFirst()
    queue.push([{ written: 1 }])
    queue.push([{ stale: 0 }])

    await ingestRoster()

    // Writing members into a graph with no uniqueness constraint is how one
    // person becomes two nodes on a re-run.
    expect(ensureOrgGraphSchema).toHaveBeenCalled()
  })

  it('returns counts only — no name and no address anywhere in the report', async () => {
    const { ingestRoster } = await mod()
    graphAppFetch.mockResolvedValueOnce(page([user(1), user(2, { jobTitle: null })]))
    denyGroupsAfterFirst()
    queue.push([{ written: 2 }])
    queue.push([{ stale: 1 }])

    const report = await ingestRoster()
    const serialised = JSON.stringify(report)

    expect(serialised).not.toContain('Person 1')
    expect(serialised).not.toContain('example.test')
    expect(report).toEqual({
      fetched: 2,
      written: 2,
      rejectedRows: 0,
      rejected: {},
      incomplete: { jobTitle: 1 },
      pages: 1,
      stale: 1,
      memberships: {
        attempted: false,
        blockedReason: expect.stringContaining('Group.Read.All'),
        teams: 0,
        edges: 0,
      },
    })
  })

  it('spends no group request at all when memberships are disabled', async () => {
    const { ingestRoster } = await mod()
    graphAppFetch.mockResolvedValueOnce(page([user(1)]))
    queue.push([{ written: 1 }])
    queue.push([{ stale: 0 }])

    const report = await ingestRoster({ includeMemberships: false })

    expect(report.memberships.blockedReason).toBe('disabled by caller')
    expect(graphAppFetch).toHaveBeenCalledTimes(1)
  })

  /** Directory page first, then deny every /groups probe. */
  function denyGroupsAfterFirst(): void {
    graphAppFetch.mockImplementation(async (path) => {
      if (path.startsWith('/groups')) throw new GraphAppPermissionError('denied', 403)
      throw new Error(`unexpected path ${path}`)
    })
  }
})
