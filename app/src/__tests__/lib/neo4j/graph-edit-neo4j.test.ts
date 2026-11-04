// @vitest-environment node
/**
 * The canvas edit ops (org-knowledge slice 6) against a DISPOSABLE Neo4j only —
 * the same opt-in as `org-graph-store-neo4j.test.ts`, skipped unless
 *
 *   ORG_GRAPH_TEST_NEO4J_URL=bolt://localhost:<port>  (+ _USER, _PASSWORD)
 *   ORG_GRAPH_TEST_NEO4J_DISPOSABLE=yes-wipe
 *
 * and refusing any database that is not EMPTY when it first connects. It
 * applies the ontology's constraint statements first, so the name-key
 * constraint stands behind the MERGE as it will in production.
 */
import neo4j, { type Driver } from 'neo4j-driver'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { configureNeo4j, resetDriver } from '@hames-ai/connectors/neo4j/client'
import {
  createGraphNode,
  linkGraphNodes,
  setGraphNodeProperty,
} from '@hames-ai/connectors/neo4j/graph-edit.server'
import { CONSTRAINT_STATEMENTS, ORG_ONTOLOGY } from '../../../lib/org-graph/ontology'

const URL = process.env.ORG_GRAPH_TEST_NEO4J_URL
const ENABLED = !!URL && process.env.ORG_GRAPH_TEST_NEO4J_DISPOSABLE === 'yes-wipe'
const A = { userId: 'user-a', now: '2026-11-04T10:00:00.000Z' }
const B = { userId: 'user-b', now: '2026-11-05T10:00:00.000Z' }

describe.skipIf(!ENABLED)('canvas edit ops on a disposable database', () => {
  let driver: Driver
  const run = async (cypher: string, params: Record<string, unknown> = {}) => {
    const session = driver.session()
    try {
      return await session.run(cypher, params)
    } finally {
      await session.close()
    }
  }
  const one = async (cypher: string, params: Record<string, unknown> = {}) =>
    (await run(cypher, params)).records[0]

  beforeAll(async () => {
    const auth = {
      user: process.env.ORG_GRAPH_TEST_NEO4J_USER ?? 'neo4j',
      password: process.env.ORG_GRAPH_TEST_NEO4J_PASSWORD ?? '',
    }
    driver = neo4j.driver(URL!, neo4j.auth.basic(auth.user, auth.password))
    const count = (await one('MATCH (n) RETURN count(n) AS c')).get('c').toNumber()
    if (count > 0) throw new Error(`refusing: ${URL} holds ${count} nodes; EMPTY disposable databases only`)
    for (const statement of CONSTRAINT_STATEMENTS) await run(statement)
    configureNeo4j({ url: URL!, ...auth })
  })
  afterAll(async () => {
    await run('MATCH (n) DETACH DELETE n')
    await resetDriver()
    await driver?.close()
  })
  beforeEach(async () => {
    await run('MATCH (n) DETACH DELETE n')
  })

  it('merges a repeated name onto one node, createdBy kept, lastEditedBy on a change', async () => {
    const first = await createGraphNode(ORG_ONTOLOGY, A, 'Project', 'Heron')
    const second = await createGraphNode(ORG_ONTOLOGY, B, 'Project', 'HERON', 'A logistics workstream')
    expect(second).toBe(first)
    const n = (await one('MATCH (n:Project) RETURN count(n) AS c, collect(properties(n))[0] AS p'))
    expect(n.get('c').toNumber()).toBe(1)
    expect(n.get('p')).toMatchObject({
      name: 'Heron',
      nameKey: 'heron',
      createdBy: 'user-a',
      createdAt: A.now,
      description: 'A logistics workstream',
      lastEditedBy: 'user-b',
    })
  })

  it('links with provenance, and refuses a second coordinator', async () => {
    await run(
      "CREATE (:Member {entraId: 'm1', displayName: 'Tamsin Orrin', mail: 't@example.test'}), " +
        "(:Member {entraId: 'm2', displayName: 'Dorrit Wexley', mail: 'd@example.test'})",
    )
    const theme = await createGraphNode(ORG_ONTOLOGY, A, 'Theme', 'Theme 1')
    const m1 = (await one("MATCH (m:Member {entraId: 'm1'}) RETURN elementId(m) AS id")).get('id')
    const m2 = (await one("MATCH (m:Member {entraId: 'm2'}) RETURN elementId(m) AS id")).get('id')
    await linkGraphNodes(ORG_ONTOLOGY, A, m1, theme, 'COORDINATES')
    await linkGraphNodes(ORG_ONTOLOGY, A, m1, theme, 'COORDINATES') // idempotent
    await expect(linkGraphNodes(ORG_ONTOLOGY, B, m2, theme, 'COORDINATES')).rejects.toThrow(
      /COORDINATES allows 1 per node/,
    )
    const r = await one('MATCH ()-[r:COORDINATES]->() RETURN count(r) AS c, collect(properties(r))[0] AS p')
    expect(r.get('c').toNumber()).toBe(1)
    expect(r.get('p')).toMatchObject({ createdBy: 'user-a', createdAt: A.now })
    await expect(linkGraphNodes(ORG_ONTOLOGY, A, theme, m1, 'COORDINATES')).rejects.toThrow(
      /COORDINATES joins Member to Pillar or Theme/,
    )
  })

  it('sets a declared property, renames with its name key, and refuses a duplicate name', async () => {
    const heron = await createGraphNode(ORG_ONTOLOGY, A, 'Project', 'Heron')
    await createGraphNode(ORG_ONTOLOGY, A, 'Project', 'Osprey')
    await setGraphNodeProperty(ORG_ONTOLOGY, B, heron, 'status', 'active')
    await setGraphNodeProperty(ORG_ONTOLOGY, B, heron, 'name', 'Heron Two')
    const p = (await one('MATCH (n) WHERE elementId(n) = $id RETURN properties(n) AS p', { id: heron })).get('p')
    expect(p).toMatchObject({ status: 'active', name: 'Heron Two', nameKey: 'heron two', lastEditedBy: 'user-b' })
    // The name-key constraint stands behind the MERGE: two projects cannot
    // share a name, whichever path writes it.
    await expect(setGraphNodeProperty(ORG_ONTOLOGY, B, heron, 'name', 'osprey')).rejects.toThrow()
    await expect(setGraphNodeProperty(ORG_ONTOLOGY, B, heron, 'owner', 'x')).rejects.toThrow(
      /Project has no property owner/,
    )
  })
})
