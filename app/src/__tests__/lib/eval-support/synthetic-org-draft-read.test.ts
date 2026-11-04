/**
 * LD-22: the org rows' draft loop reads the scenario's OWN synthetic org graph —
 * the one its candidate is validated against. On the first live private-tier
 * run its reads reached the route's miniature project graph instead, and the
 * draft, shown Alder and Dune when it asked for Theme 1, declined.
 *
 * Mutations that redden it: serve the read from anything but `store.dump()`;
 * drop the literal filter (the Heron row then sees the members); stop hiding
 * `mail`/`entraId`; let the transport disown `get_neo4j_schema`.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

const load = () => import('../../../lib/eval-support/synthetic-org-graph')

describe('syntheticOrgGraphRead', () => {
  it('answers a named query with those nodes and the edges touching them', async () => {
    const { createSyntheticOrgGraph, syntheticOrgGraphRead } = await load()
    const store = createSyntheticOrgGraph(['members', 'theme-1'])
    const rows = syntheticOrgGraphRead(
      store,
      "MATCH (m:Member {displayName: 'Tamsin Orrin'}), (t:Theme {name: 'Theme 1'}) RETURN m, t",
    ) as Record<string, string>[]
    expect(rows.map((r) => r.displayName ?? r.name ?? `${r.from}-${r.type}->${r.to}`)).toEqual([
      'Tamsin Orrin',
      'Theme 1',
      'Dorrit Wexley-COORDINATES->Theme 1',
    ])
    expect(rows[0]).toMatchObject({ label: 'Member', displayName: 'Tamsin Orrin' })
    for (const r of rows) {
      for (const hidden of ['id', 'nameKey', 'createdBy', 'entraId', 'mail']) {
        expect(r).not.toHaveProperty(hidden)
      }
    }
  })

  it('answers a node the graph lacks with nothing, case-insensitively', async () => {
    const { createSyntheticOrgGraph, syntheticOrgGraphRead } = await load()
    const store = createSyntheticOrgGraph(['members'])
    expect(
      syntheticOrgGraphRead(
        store,
        "MATCH (p:Project) WHERE toLower(p.name) CONTAINS 'heron' RETURN p",
      ),
    ).toEqual([])
    const osprey = createSyntheticOrgGraph(['osprey'])
    expect(syntheticOrgGraphRead(osprey, 'MATCH (p {name: "OSPREY"}) RETURN p')).toEqual([
      { label: 'Project', name: 'Osprey' },
    ])
  })

  it('answers a query that names nothing with the whole graph', async () => {
    const { createSyntheticOrgGraph, syntheticOrgGraphRead } = await load()
    const store = createSyntheticOrgGraph(['osprey', 'pillars', 'osprey-in-pillar-a'])
    const rows = syntheticOrgGraphRead(store, 'MATCH (n) RETURN n') as Record<string, string>[]
    expect(rows).toHaveLength(5)
    expect(rows.at(-1)).toEqual({ from: 'Osprey', type: 'IN_PILLAR', to: 'Pillar A' })
  })
})

describe('syntheticOrgDraftTransport', () => {
  it('owns exactly the draft tools and serves both from the store', async () => {
    const { createSyntheticOrgGraph, syntheticOrgDraftTransport } = await load()
    const { ORG_DRAFT_TOOLS } = await import('@hames-ai/harness-patterns/org-knowledge-hook.server')
    const t = syntheticOrgDraftTransport(createSyntheticOrgGraph(['heron']))
    for (const name of ORG_DRAFT_TOOLS) expect(t.ownsTool(name)).toBe(true)
    expect(t.ownsTool('write_neo4j_cypher')).toBe(false)
    expect(
      await t.callTool('read_neo4j_cypher', { query: "MATCH (p {name: 'Heron'}) RETURN p" }),
    ).toEqual({ success: true, data: [{ label: 'Project', name: 'Heron' }] })
    const schema = (await t.callTool('get_neo4j_schema', {})).data as { labels: string[] }
    expect(schema.labels).toContain('Theme')
  }, 30_000)
})
