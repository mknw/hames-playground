/**
 * `enrich-org-edges.server.ts` against a driver double — same pattern as
 * `schema.test.ts`. Pins the three guarantees the module header promises:
 * resource reclassification survives a re-ingested duplicate, every
 * previously-inferred edge is cleared before new ones are derived, and the
 * whole run is safe to repeat. Fixtures are synthetic throughout.
 *
 * `reclassifyResourceAccounts` issues no query at all when nothing matches
 * (`edge-inference.test.ts` covers the matching logic itself) — several
 * fixtures below use a titled member specifically so that path is what runs,
 * and the mocked-call queue below only ever has an entry for a query the
 * code actually issues.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
  ServerOnlyError: class ServerOnlyError extends Error {},
}))

vi.mock('../../../lib/org-graph/schema.server', () => ({
  ensureOrgGraphSchema: vi.fn(async () => undefined),
  countNonConforming: vi.fn(async () => []),
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

const mod = () => import('../../../lib/org-graph/enrich-org-edges.server')

const calls = () => sessionRun.mock.calls.map((c) => ({ query: String(c[0]), params: c[1] as Row }))

beforeEach(() => {
  vi.clearAllMocks()
  queue.length = 0
})

/** Titled by default, so this member never matches the resource shape and
 *  `reclassifyResourceAccounts` issues no query for it. */
const MEMBER_ROW = (over: Partial<Row> = {}): Row => ({
  entraId: 'oid-1',
  displayName: 'Widget Person',
  mail: 'widget.person@example.test',
  jobTitle: 'Widget Engineer',
  department: null,
  ...over,
})

describe('runOrgEdgeEnrichment', () => {
  it('ensures schema, fetches once, then clears and re-derives — no reclassify query when nothing matches', async () => {
    const { runOrgEdgeEnrichment } = await mod()
    const { ensureOrgGraphSchema } = await import('../../../lib/org-graph/schema.server')

    queue.push([MEMBER_ROW()]) // fetchAllMembers
    queue.push([{ cleared: 3 }]) // clearInferredEdges
    queue.push([{ teams: 1, edges: 1 }]) // role group write

    const report = await runOrgEdgeEnrichment()

    expect(ensureOrgGraphSchema).toHaveBeenCalledTimes(1)
    expect(report).toEqual({
      resourcesReclassified: 0,
      inferredEdgesCleared: 3,
      roleTeams: 1,
      roleEdges: 1,
      departmentTeams: 0,
      departmentEdges: 0,
      confidenceDistribution: { '0.8': 1 },
    })

    const issued = calls()
    expect(issued).toHaveLength(3)
    expect(issued[0].query).toMatch(/MATCH \(m:Member\)/)
    expect(issued.some((c) => c.query.includes('DETACH DELETE'))).toBe(false)
  })

  it('reclassifies a resource-shaped member via MERGE onto Resource.key, not a label flip', async () => {
    const { runOrgEdgeEnrichment } = await mod()

    // No job title, no department, undotted local-part — matches the shape.
    queue.push([MEMBER_ROW({ jobTitle: null, mail: 'shared-access@example.test' })])
    queue.push([{ converted: 1 }]) // reclassifyResourceAccounts
    queue.push([{ cleared: 0 }]) // clearInferredEdges
    // no role/department write: the only member became a Resource, so
    // buildRoleGroupEdges/buildDepartmentGroupEdges see nothing to group

    const report = await runOrgEdgeEnrichment()

    expect(report.resourcesReclassified).toBe(1)
    expect(report.roleEdges).toBe(0)
    expect(report.departmentEdges).toBe(0)

    const reclassify = calls()[1]
    expect(reclassify.query).toMatch(/MERGE \(r:Resource \{key: row\.mail\}\)/)
    expect(reclassify.query).toMatch(/DETACH DELETE m/)
    expect(reclassify.query).not.toMatch(/REMOVE m:Member/)
    expect(reclassify.params.rows).toEqual([
      { entraId: 'oid-1', mail: 'shared-access@example.test', displayName: 'Widget Person' },
    ])
  })

  it('clears every inferred edge before re-deriving, regardless of type', async () => {
    const { runOrgEdgeEnrichment } = await mod()

    queue.push([MEMBER_ROW()])
    queue.push([{ cleared: 7 }])
    queue.push([{ teams: 1, edges: 1 }])

    await runOrgEdgeEnrichment()

    const clearCall = calls().find((c) => c.query.includes('DELETE r'))
    expect(clearCall).toBeTruthy()
    expect(clearCall!.query).toMatch(/WHERE r\.inferred = true/)
    expect(clearCall!.query).not.toMatch(/:MEMBER_OF/) // no type filter — blanket by design
  })

  it('writes department groupings alongside role groupings when a department is set', async () => {
    const { runOrgEdgeEnrichment } = await mod()

    queue.push([MEMBER_ROW({ department: 'Widgets' })])
    queue.push([{ cleared: 0 }])
    queue.push([{ teams: 1, edges: 1 }]) // role
    queue.push([{ teams: 1, edges: 1 }]) // department

    const report = await runOrgEdgeEnrichment()

    expect(report.roleEdges).toBe(1)
    expect(report.departmentEdges).toBe(1)
    expect(report.confidenceDistribution).toEqual({ '0.8': 1, '0.9': 1 })
  })

  it('is safe to run twice back to back', async () => {
    const { runOrgEdgeEnrichment } = await mod()

    for (let i = 0; i < 2; i++) {
      queue.push([MEMBER_ROW()])
      queue.push([{ cleared: i === 0 ? 0 : 1 }])
      queue.push([{ teams: 1, edges: 1 }])
    }

    await expect(runOrgEdgeEnrichment()).resolves.toBeTruthy()
    await expect(runOrgEdgeEnrichment()).resolves.toBeTruthy()
  })

  it('never issues a write pattern joining two Member nodes', async () => {
    const { runOrgEdgeEnrichment } = await mod()

    queue.push([MEMBER_ROW({ department: 'Widgets' })])
    queue.push([{ cleared: 0 }])
    queue.push([{ teams: 1, edges: 1 }])
    queue.push([{ teams: 1, edges: 1 }])

    await runOrgEdgeEnrichment()

    for (const { query } of calls()) {
      expect(query).not.toMatch(/\(m\w*:Member\)[^)]*-\[[^\]]*\]->\([^)]*:Member/)
    }
  })
})
