// @vitest-environment node
/**
 * The local member seed against a DISPOSABLE Neo4j — the same opt-in as
 * `org-graph-store-neo4j.test.ts`: set `ORG_GRAPH_TEST_NEO4J_URL` (and
 * `ORG_GRAPH_TEST_NEO4J_USER` / `_PASSWORD`) and `ORG_GRAPH_TEST_NEO4J_DISPOSABLE=yes-wipe`.
 * It refuses a database that is not empty and wipes it afterwards. Skipped in CI.
 */
import neo4j, { type Driver } from 'neo4j-driver'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CONSTRAINT_STATEMENTS } from '../../../lib/org-graph/ontology'
import { readCounts, seedEvalMembers } from '../../../lib/org-graph/scripts/seed-eval-members'
import { SYNTHETIC_MEMBERS } from '../../../lib/eval-support/synthetic-org-graph'

const URL = process.env.ORG_GRAPH_TEST_NEO4J_URL
const ENABLED = !!URL && process.env.ORG_GRAPH_TEST_NEO4J_DISPOSABLE === 'yes-wipe'

describe.skipIf(!ENABLED)('seed-eval-members on a disposable database', () => {
  let driver: Driver
  const run = async (cypher: string, params: Record<string, unknown> = {}) => {
    const session = driver.session()
    try {
      return await session.run(cypher, params)
    } finally {
      await session.close()
    }
  }
  const foreign = SYNTHETIC_MEMBERS[0].entraId

  beforeAll(async () => {
    driver = neo4j.driver(
      URL!,
      neo4j.auth.basic(
        process.env.ORG_GRAPH_TEST_NEO4J_USER ?? 'neo4j',
        process.env.ORG_GRAPH_TEST_NEO4J_PASSWORD ?? '',
      ),
    )
    const count = (await run('MATCH (n) RETURN count(n) AS c')).records[0].get('c').toNumber()
    if (count > 0) throw new Error(`refusing: ${URL} holds ${count} nodes; EMPTY disposable only`)
    for (const statement of CONSTRAINT_STATEMENTS) await run(statement)
    // What a real graph already holds: a seeded pillar, and a member someone
    // else wrote under one of the fixture's ids.
    await run(
      `CREATE (:Pillar {id: 'pl-x', name: 'Pillar X', nameKey: 'pillar x', objective: 'o',
                        createdBy: 'seed', createdAt: datetime()})
       CREATE (:Member {entraId: $foreign, displayName: 'Someone Else',
                        mail: 'someone.else@example.org', createdBy: 'ingest'})`,
      { foreign },
    )
  })

  afterAll(async () => {
    if (!driver) return
    await run('MATCH (n) DETACH DELETE n')
    for (const r of (await run('SHOW CONSTRAINTS YIELD name')).records) {
      await run(`DROP CONSTRAINT \`${r.get('name')}\` IF EXISTS`)
    }
    await driver.close()
  })

  it('adds the members it owns, skips a foreign one, deletes nothing, and is idempotent', async () => {
    const before = await readCounts(driver)
    expect(before).toMatchObject({ nodes: 2, members: 1, seeded: 0 })

    expect(await seedEvalMembers(driver)).toEqual({ written: 9, skipped: 1 })
    const after = await readCounts(driver)
    expect(after).toEqual({ nodes: 11, relationships: 0, members: 10, seeded: 9, nonConforming: 0 })

    // The foreign member is untouched; the pillar is still there.
    const kept = (
      await run('MATCH (m:Member {entraId: $foreign}) RETURN m', { foreign })
    ).records[0].get('m').properties
    expect(kept).toMatchObject({ displayName: 'Someone Else', createdBy: 'ingest' })
    expect(
      (await run('MATCH (p:Pillar) RETURN count(p) AS c')).records[0].get('c').toNumber(),
    ).toBe(1)

    // Each seeded node holds the fixture's values and no department.
    const rows = (
      await run(`MATCH (m:Member {createdBy: 'eval-seed'}) RETURN m ORDER BY m.entraId`)
    ).records.map((r) => r.get('m').properties)
    for (const m of SYNTHETIC_MEMBERS.slice(1)) {
      expect(rows.find((r) => r.entraId === m.entraId)).toMatchObject({
        displayName: m.displayName,
        mail: m.mail,
        jobTitle: m.jobTitle,
      })
    }
    expect(rows.every((r) => !('department' in r))).toBe(true)

    // A second run changes nothing.
    expect(await seedEvalMembers(driver)).toEqual({ written: 9, skipped: 1 })
    expect(await readCounts(driver)).toEqual(after)
  })
})
