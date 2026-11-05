/**
 * LD-23: the org rows' draft loop reads the scenario's OWN synthetic org graph —
 * the one its candidate is validated against — and reads it as strictly as
 * Neo4j would on the subset it serves (review of #991, SHOULD 3). A lenient read
 * hid the near-duplicate the review's MUST 2 describes: an exact-name lookup of
 * "Project Osprey" "found" the stored Osprey, so the eval could never show the
 * draft proposing a second one.
 *
 * Mutations that redden it: match an inline `{prop: 'x'}` or `=` by substring
 * or case-insensitively; ignore the label; drop `params`; return a lenient
 * guess instead of an error for an unsupported predicate; stop hiding
 * `mail`/`entraId`; let one empty pattern node leave the others' rows.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

const load = () => import('../../../lib/eval-support/synthetic-org-graph')
const rowsOf = async (seeds: string[], query: string, params?: Record<string, unknown>) => {
  const { createSyntheticOrgGraph, syntheticOrgGraphRead } = await load()
  const store = createSyntheticOrgGraph(seeds as never)
  const read = syntheticOrgGraphRead(store, query, params)
  if (!read.ok) throw new Error(read.error)
  return read.rows as Record<string, string>[]
}

describe('syntheticOrgGraphRead: the near-duplicate is reproducible', () => {
  it('finds no stored "Osprey" by the exact name "Project Osprey"', async () => {
    expect(await rowsOf(['osprey'], "MATCH (p:Project {name: 'Project Osprey'}) RETURN p")).toEqual(
      [],
    )
    expect(await rowsOf(['osprey'], "MATCH (p:Project) WHERE p.name = 'osprey' RETURN p")).toEqual(
      [],
    )
  })

  it('finds it by the near-match search the schema prescribes', async () => {
    expect(
      await rowsOf(
        ['osprey'],
        "MATCH (n:Project) WHERE toLower(n.name) CONTAINS 'osprey' RETURN n",
      ),
    ).toEqual([{ label: 'Project', name: 'Osprey' }])
    // CONTAINS without toLower is case-sensitive, as in Neo4j.
    expect(
      await rowsOf(['osprey'], "MATCH (n:Project) WHERE n.name CONTAINS 'osprey' RETURN n"),
    ).toEqual([])
  })
})

describe('syntheticOrgGraphRead: Neo4j-strict on what it serves', () => {
  it('honours the label', async () => {
    expect(
      await rowsOf(['members', 'theme-1'], "MATCH (p:Project {name: 'Theme 1'}) RETURN p"),
    ).toEqual([])
  })

  it('reads $parameters from params, and refuses a missing one', async () => {
    expect(
      await rowsOf(['heron'], 'MATCH (p:Project {name: $name}) RETURN p', { name: 'Heron' }),
    ).toEqual([{ label: 'Project', name: 'Heron' }])
    await expect(rowsOf(['heron'], 'MATCH (p:Project {name: $name}) RETURN p')).rejects.toThrow(
      /expected parameter \$name/,
    )
  })

  it('answers a two-node pattern only when both nodes exist, with their edges', async () => {
    const rows = await rowsOf(
      ['members', 'theme-1'],
      "MATCH (m:Member {displayName: 'Tamsin Orrin'}), (t:Theme {name: 'Theme 1'}) RETURN m, t",
    )
    expect(rows.map((r) => r.displayName ?? r.name ?? `${r.from}-${r.type}->${r.to}`)).toEqual([
      'Tamsin Orrin',
      'Theme 1',
      'Dorrit Wexley-COORDINATES->Theme 1',
    ])
    for (const r of rows) {
      for (const hidden of ['id', 'nameKey', 'createdBy', 'entraId', 'mail']) {
        expect(r).not.toHaveProperty(hidden)
      }
    }
    expect(
      await rowsOf(
        ['members', 'theme-1'],
        "MATCH (m:Member {displayName: 'Tamsin Orrin'}), (t:Theme {name: 'Theme 9'}) RETURN m, t",
      ),
    ).toEqual([])
  })

  it('splits WHERE on AND / OR outside string literals only', async () => {
    const rows = await rowsOf(
      ['osprey', 'heron'],
      "MATCH (p:Project) WHERE p.name = 'Heron' OR p.name STARTS WITH 'Osp' RETURN p",
    )
    expect(rows.map((r) => r.name)).toEqual(['Osprey', 'Heron'])
    expect(
      await rowsOf(['osprey'], "MATCH (p:Project) WHERE p.name = 'Osprey OR Heron' RETURN p"),
    ).toEqual([])
  })

  it('answers a query that constrains nothing with the whole graph', async () => {
    const rows = await rowsOf(['osprey', 'pillars', 'osprey-in-pillar-a'], 'MATCH (n) RETURN n')
    expect(rows).toHaveLength(5)
    expect(rows.at(-1)).toEqual({ from: 'Osprey', type: 'IN_PILLAR', to: 'Pillar A' })
  })

  it('errors, naming the subset, on what it does not serve or is not Cypher', async () => {
    const { createSyntheticOrgGraph, syntheticOrgGraphRead } = await load()
    const store = createSyntheticOrgGraph(['osprey'])
    for (const query of [
      "MATCH (p:Project) WHERE p.name =~ '(?i)osp.*' RETURN p",
      "MATCH (p:Project {name: 'Osprey' RETURN p",
      "MATCH (p:Project {name: 'Osprey}) RETURN p",
      "CREATE (p:Project {name: 'Kittiwake'}) RETURN p",
      'MATCH (p:Project) SET p.status = "x" RETURN p',
      'show me the projects',
    ]) {
      const read = syntheticOrgGraphRead(store, query)
      expect(read.ok, query).toBe(false)
      if (!read.ok) expect(read.error).toMatch(/^Invalid query: .*synthetic org graph supports/)
    }
  })
})

describe('syntheticOrgDraftTransport', () => {
  it('owns exactly the draft tools, serves both, and fails a refused read', async () => {
    const { createSyntheticOrgGraph, syntheticOrgDraftTransport } = await load()
    const { ORG_DRAFT_TOOLS } = await import('@hames-ai/harness-patterns/org-knowledge-hook.server')
    const t = syntheticOrgDraftTransport(createSyntheticOrgGraph(['heron']))
    for (const name of ORG_DRAFT_TOOLS) expect(t.ownsTool(name)).toBe(true)
    expect(t.ownsTool('write_neo4j_cypher')).toBe(false)
    expect(
      await t.callTool('read_neo4j_cypher', {
        query: 'MATCH (p:Project {name: $n}) RETURN p',
        params: { n: 'Heron' },
      }),
    ).toEqual({ success: true, data: [{ label: 'Project', name: 'Heron' }] })
    const refused = await t.callTool('read_neo4j_cypher', { query: 'not cypher' })
    expect(refused.success).toBe(false)
    const schema = (await t.callTool('get_neo4j_schema', {})).data as { labels: string[] }
    expect(schema.labels).toContain('Theme')
  }, 30_000)
})
