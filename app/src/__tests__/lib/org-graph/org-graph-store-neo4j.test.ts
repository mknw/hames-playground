// @vitest-environment node
/**
 * The graph store contract against the real Neo4j adapter — on a DISPOSABLE
 * database only. Skipped unless both are set:
 *
 *   ORG_GRAPH_TEST_NEO4J_URL=bolt://localhost:<port>  (+ _USER, _PASSWORD)
 *   ORG_GRAPH_TEST_NEO4J_DISPOSABLE=yes-wipe
 *
 * The suite wipes the database between cases, so it also refuses one that is
 * not EMPTY when it first connects: the organisation's graph is never empty,
 * and a mistyped URL must fail here rather than delete it. Never point it at
 * the compose stack's Neo4j. One way to get a throwaway instance:
 *
 *   docker run -d --rm --name orghook-neo4j-test -p 17687:7687 \
 *     -e NEO4J_AUTH=neo4j/<password> neo4j:5.26
 *
 * The run also applies the ontology's constraint statements, which proves they
 * parse on the Community edition the stack runs.
 */
import neo4j, { type Driver } from 'neo4j-driver'
import { describe, beforeAll, afterAll } from 'vitest'
import { createNeo4jOrgGraphStore } from '../../../lib/org-graph/org-graph-store.server'
import { CONSTRAINT_STATEMENTS, ORG_ONTOLOGY } from '../../../lib/org-graph/ontology'
import { orgGraphStoreContract, type StoredGraph } from './org-graph-store-contract'

const URL = process.env.ORG_GRAPH_TEST_NEO4J_URL
const ENABLED = !!URL && process.env.ORG_GRAPH_TEST_NEO4J_DISPOSABLE === 'yes-wipe'

const KEY = (a: string) =>
  `CASE WHEN ${a}.id IS NOT NULL THEN 'id:' + ${a}.id ` +
  `WHEN ${a}:Member AND ${a}.entraId IS NOT NULL THEN 'entraId:' + ${a}.entraId ` +
  `ELSE 'element:' + elementId(${a}) END`

const idOf = (key: string): string => key.replace(/^id:/, '')
const q = (identifier: string): string => '`' + identifier.replace(/`/g, '``') + '`'
const strings = (props: Record<string, unknown>): Record<string, string> =>
  Object.fromEntries(Object.entries(props).map(([k, v]) => [k, String(v)]))

describe.skipIf(!ENABLED)('Neo4j adapter on a disposable database', () => {
  let driver: Driver
  const run = async (cypher: string, params: Record<string, unknown> = {}) => {
    const session = driver.session()
    try {
      return await session.run(cypher, params)
    } finally {
      await session.close()
    }
  }

  beforeAll(async () => {
    driver = neo4j.driver(
      URL!,
      neo4j.auth.basic(
        process.env.ORG_GRAPH_TEST_NEO4J_USER ?? 'neo4j',
        process.env.ORG_GRAPH_TEST_NEO4J_PASSWORD ?? '',
      ),
    )
    const count = (await run('MATCH (n) RETURN count(n) AS c')).records[0].get('c').toNumber()
    if (count > 0) {
      throw new Error(
        `refusing: ${URL} holds ${count} nodes; this suite runs on an EMPTY disposable database only`,
      )
    }
    for (const statement of CONSTRAINT_STATEMENTS) await run(statement)
  })

  afterAll(async () => {
    await run('MATCH (n) DETACH DELETE n')
    await driver?.close()
  })

  orgGraphStoreContract('Neo4j', async (seed) => {
    await run('MATCH (n) DETACH DELETE n')
    for (const n of seed.nodes) {
      await run(`CREATE (n:${q(n.label)}) SET n = $props`, { props: n.properties })
    }
    for (const e of seed.edges) {
      await run(`MATCH (a {id: $from}), (b {id: $to}) CREATE (a)-[:${q(e.type)}]->(b)`, {
        from: idOf(e.from),
        to: idOf(e.to),
      })
    }
    const store = createNeo4jOrgGraphStore({ ontology: ORG_ONTOLOGY, driver: () => driver })
    return {
      store,
      async read(): Promise<StoredGraph> {
        const nodes = await run(
          `MATCH (n) RETURN labels(n)[0] AS label, properties(n) AS p, ${KEY('n')} AS key`,
        )
        const edges = await run(
          `MATCH (a)-[r]->(b) RETURN type(r) AS type, ${KEY('a')} AS from, ${KEY('b')} AS to, properties(r) AS p`,
        )
        return {
          nodes: nodes.records.map((r) => ({
            key: r.get('key'),
            label: r.get('label'),
            properties: strings(r.get('p')),
          })),
          edges: edges.records.map((r) => ({
            type: r.get('type'),
            from: r.get('from'),
            to: r.get('to'),
            properties: strings(r.get('p')),
          })),
        }
      },
      async setProperty(key, prop, value) {
        await run('MATCH (n {id: $id}) SET n += $m', { id: idOf(key), m: { [prop]: value } })
      },
      async addEdge(type, from, to) {
        await run(`MATCH (a {id: $from}), (b {id: $to}) CREATE (a)-[:${q(type)}]->(b)`, {
          from: idOf(from),
          to: idOf(to),
        })
      },
    }
  })
})
