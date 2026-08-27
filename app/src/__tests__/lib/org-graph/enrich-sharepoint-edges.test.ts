/**
 * `enrich-sharepoint-edges.server.ts` — Graph and Neo4j both doubled, no
 * tenant, no network, no database, no real identity anywhere in a fixture.
 *
 * What is worth pinning: the owner-resolution guardrails (unknown email, no
 * cached credential), that a `GraphAuthRequiredError` propagates rather than
 * being swallowed into a false "zero evidence" report, that identity
 * resolution matches by AAD id first and email second and drops anything
 * that matches neither, that the write is scoped to `COLLABORATES_WITH` only
 * (never phase 1's blanket inferred-edge delete), and that pagination is
 * followed rather than truncated at page one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

vi.mock('../../../lib/org-graph/schema.server', () => ({
  ensureOrgGraphSchema: vi.fn(async () => undefined),
}))

const { GraphAuthRequiredError } = vi.hoisted(() => ({
  GraphAuthRequiredError: class extends Error {
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

const graphFetch = vi.fn<(userId: string, path: string, init?: unknown) => Promise<unknown>>()
vi.mock('../../../lib/auth/graph-token.server', () => ({
  graphFetch: (...a: [string, string, unknown?]) => graphFetch(...a),
  GraphAuthRequiredError,
}))

const listUsers = vi.fn()
vi.mock('../../../lib/auth/users.server', () => ({
  listUsers: () => listUsers(),
}))

const hasUserTokenCache = vi.fn()
vi.mock('../../../lib/auth/user-tokens.server', () => ({
  hasUserTokenCache: (id: string) => hasUserTokenCache(id),
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

const mod = () => import('../../../lib/org-graph/enrich-sharepoint-edges.server')

const calls = () => sessionRun.mock.calls.map((c) => ({ query: String(c[0]), params: c[1] as Row }))
const graphCalls = () => graphFetch.mock.calls.map(([, path, init]) => ({ path, init }))

const OWNER_EMAIL = 'owner@example.test'
const OWNER = { id: 'owner-oid', email: OWNER_EMAIL, displayName: 'Owner', tenantId: 't1' }

const page = (rows: unknown[], nextLink?: string): Row =>
  nextLink ? { value: rows, '@odata.nextLink': nextLink } : { value: rows }

/** One driveItem row as `/root/delta` would shape it. */
const driveItem = (over: Row = {}): Row => ({
  file: {},
  lastModifiedDateTime: '2026-08-20T00:00:00Z',
  parentReference: { id: 'folder-1', path: '/drives/drive-1/root:/Reports/Q3' },
  createdBy: { user: { id: 'oid-a' } },
  lastModifiedBy: { user: { id: 'oid-b' } },
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  queue.length = 0
  listUsers.mockResolvedValue([OWNER])
  hasUserTokenCache.mockResolvedValue(true)
})

describe('resolveOwnerUserId', () => {
  it('throws a sign-in instruction when no user record matches the email', async () => {
    const { resolveOwnerUserId } = await mod()
    listUsers.mockResolvedValue([])
    await expect(resolveOwnerUserId(OWNER_EMAIL)).rejects.toThrow(/sign in/i)
  })

  it('matches case-insensitively', async () => {
    const { resolveOwnerUserId } = await mod()
    await expect(resolveOwnerUserId('OWNER@Example.Test')).resolves.toBe('owner-oid')
  })

  it('throws a sign-in instruction when the user has never connected Microsoft 365', async () => {
    const { resolveOwnerUserId } = await mod()
    hasUserTokenCache.mockResolvedValue(false)
    await expect(resolveOwnerUserId(OWNER_EMAIL)).rejects.toThrow(/sign in/i)
  })
})

describe('runSharePointCoactivityEnrichment — happy path', () => {
  it('walks sites → drives → items, resolves identities, writes one edge', async () => {
    const { runSharePointCoactivityEnrichment } = await mod()

    queue.push([
      { entraId: 'oid-a', mail: 'a@example.test' },
      { entraId: 'oid-b', mail: 'b@example.test' },
    ]) // fetchRosterIdentities
    queue.push([{ cleared: 0 }]) // clearCollaborationEdges
    queue.push([{ written: 1 }]) // writeCollaborationEdges

    graphFetch.mockImplementation(async (_owner, path) => {
      if (path.startsWith('/sites?')) return page([{ id: 'site-1' }])
      if (path === '/sites/site-1/drives?$select=id') return page([{ id: 'drive-1' }])
      if (path.startsWith('/drives/drive-1/root/delta')) return page([driveItem()])
      throw new Error(`unexpected path ${path}`)
    })

    const report = await runSharePointCoactivityEnrichment(
      OWNER_EMAIL,
      new Date('2026-08-27T00:00:00Z'),
    )

    expect(report.sitesCovered).toBe(1)
    expect(report.drivesCovered).toBe(1)
    expect(report.itemsScanned).toBe(1)
    expect(report.itemsWithResolvedIdentity).toBe(1)
    expect(report.edgesCleared).toBe(0)
    expect(report.pairsWritten).toBe(1)

    // Every Graph call acted as the owner, never a bystander user.
    for (const { path } of graphCalls())
      expect(graphFetch).toHaveBeenCalledWith('owner-oid', path, expect.anything())

    const write = calls().find((c) => c.query.includes('MERGE (a)-[r:COLLABORATES_WITH]->(b)'))
    expect(write).toBeTruthy()
    expect(write!.params.rows).toEqual([
      expect.objectContaining({ aEntraId: 'oid-a', bEntraId: 'oid-b' }),
    ])
    expect(write!.params.basis).toBe('sharepoint-coactivity')
  })

  it('resolves an identity by mail when the AAD id does not match the roster', async () => {
    const { runSharePointCoactivityEnrichment } = await mod()

    queue.push([
      { entraId: 'oid-a', mail: 'a@example.test' },
      { entraId: 'oid-b', mail: 'b@example.test' },
    ])
    queue.push([{ cleared: 0 }])
    queue.push([{ written: 1 }])

    graphFetch.mockImplementation(async (_owner, path) => {
      if (path.startsWith('/sites?')) return page([{ id: 'site-1' }])
      if (path === '/sites/site-1/drives?$select=id') return page([{ id: 'drive-1' }])
      if (path.startsWith('/drives/drive-1/root/delta'))
        return page([
          driveItem({
            createdBy: { user: { id: 'external-oid', email: 'A@Example.Test' } },
            lastModifiedBy: { user: { id: 'oid-b' } },
          }),
        ])
      throw new Error(`unexpected path ${path}`)
    })

    await runSharePointCoactivityEnrichment(OWNER_EMAIL, new Date('2026-08-27T00:00:00Z'))

    const write = calls().find((c) => c.query.includes('MERGE (a)-[r:COLLABORATES_WITH]->(b)'))
    expect(write!.params.rows).toEqual([
      expect.objectContaining({ aEntraId: 'oid-a', bEntraId: 'oid-b' }),
    ])
  })

  it('drops an identity that matches neither entraId nor mail, silently', async () => {
    const { runSharePointCoactivityEnrichment } = await mod()

    queue.push([{ entraId: 'oid-a', mail: 'a@example.test' }])
    queue.push([{ cleared: 0 }])
    // No write call is expected — a single unresolved actor produces no pair.

    graphFetch.mockImplementation(async (_owner, path) => {
      if (path.startsWith('/sites?')) return page([{ id: 'site-1' }])
      if (path === '/sites/site-1/drives?$select=id') return page([{ id: 'drive-1' }])
      if (path.startsWith('/drives/drive-1/root/delta'))
        return page([
          driveItem({
            createdBy: { user: { id: 'external-oid', email: 'outsider@example.test' } },
            lastModifiedBy: { user: { id: 'oid-a' } },
          }),
        ])
      throw new Error(`unexpected path ${path}`)
    })

    const report = await runSharePointCoactivityEnrichment(
      OWNER_EMAIL,
      new Date('2026-08-27T00:00:00Z'),
    )
    expect(report.itemsWithResolvedIdentity).toBe(1) // oid-a alone resolved
    expect(report.pairsWritten).toBe(0)
    expect(calls().some((c) => c.query.includes('MERGE (a)-[r:COLLABORATES_WITH]->(b)'))).toBe(
      false,
    )
  })

  it('skips folder entries — only rows carrying a `file` facet are scanned', async () => {
    const { runSharePointCoactivityEnrichment } = await mod()

    queue.push([{ entraId: 'oid-a', mail: 'a@example.test' }])
    queue.push([{ cleared: 0 }])

    graphFetch.mockImplementation(async (_owner, path) => {
      if (path.startsWith('/sites?')) return page([{ id: 'site-1' }])
      if (path === '/sites/site-1/drives?$select=id') return page([{ id: 'drive-1' }])
      if (path.startsWith('/drives/drive-1/root/delta'))
        return page([{ folder: { childCount: 2 }, parentReference: {} }])
      throw new Error(`unexpected path ${path}`)
    })

    const report = await runSharePointCoactivityEnrichment(
      OWNER_EMAIL,
      new Date('2026-08-27T00:00:00Z'),
    )
    expect(report.itemsScanned).toBe(0)
  })

  it('follows @odata.nextLink for the site listing rather than stopping at page one', async () => {
    const { runSharePointCoactivityEnrichment } = await mod()

    queue.push([{ entraId: 'oid-a', mail: 'a@example.test' }])
    queue.push([{ cleared: 0 }])

    graphFetch.mockImplementation(async (_owner, path) => {
      if (path === '/sites?search=*&$select=id') return page([{ id: 'site-1' }], '/sites?page=2')
      if (path === '/sites?page=2') return page([{ id: 'site-2' }])
      if (path.startsWith('/sites/') && path.endsWith('/drives?$select=id')) return page([])
      throw new Error(`unexpected path ${path}`)
    })

    const report = await runSharePointCoactivityEnrichment(
      OWNER_EMAIL,
      new Date('2026-08-27T00:00:00Z'),
    )
    expect(report.sitesCovered).toBe(2)
  })

  it('propagates GraphAuthRequiredError rather than reporting zero evidence', async () => {
    const { runSharePointCoactivityEnrichment } = await mod()

    queue.push([{ entraId: 'oid-a', mail: 'a@example.test' }])

    graphFetch.mockImplementation(async () => {
      throw new GraphAuthRequiredError('sign in again', 'owner-oid', 401)
    })

    await expect(
      runSharePointCoactivityEnrichment(OWNER_EMAIL, new Date('2026-08-27T00:00:00Z')),
    ).rejects.toThrow(GraphAuthRequiredError)
  })

  it('clears only COLLABORATES_WITH edges, never the blanket inferred-edge delete', async () => {
    const { runSharePointCoactivityEnrichment } = await mod()

    queue.push([{ entraId: 'oid-a', mail: 'a@example.test' }])
    queue.push([{ cleared: 2 }])

    graphFetch.mockImplementation(async (_owner, path) => {
      if (path.startsWith('/sites?')) return page([])
      throw new Error(`unexpected path ${path}`)
    })

    await runSharePointCoactivityEnrichment(OWNER_EMAIL, new Date('2026-08-27T00:00:00Z'))

    const clear = calls().find((c) => c.query.includes('DELETE r'))
    expect(clear!.query).toMatch(/:COLLABORATES_WITH/)
    expect(clear!.query).toMatch(/WHERE r\.inferred = true/)
  })
})
