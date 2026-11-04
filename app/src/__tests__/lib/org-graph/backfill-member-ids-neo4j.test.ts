// @vitest-environment node
/**
 * The amended ontology and the Member id backfill against a DISPOSABLE Neo4j —
 * the same opt-in as `seed-eval-members-neo4j.test.ts`: set
 * `ORG_GRAPH_TEST_NEO4J_URL` (and `ORG_GRAPH_TEST_NEO4J_USER` / `_PASSWORD`) and
 * `ORG_GRAPH_TEST_NEO4J_DISPOSABLE=yes-wipe`. It refuses a database that is not
 * empty and wipes it afterwards. Skipped in CI.
 *
 * It builds the shape the live graphs were found in — the five pre-v2
 * constraints with their own definitions, members written before ids — then
 * applies the amended schema, backfills, and reads the result back.
 *
 * Mutations that redden it: drop `key` from Knowledge's or Resource's unique
 * list (the old constraint is a leftover again); drop `WHERE m.id IS NULL`
 * from the backfill (the existing id is overwritten); drop Knowledge from
 * ABOUT's `from` (the conformance count reports the edge).
 */
import neo4j, { type Driver } from 'neo4j-driver'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  CONSTRAINT_NAMES,
  CONSTRAINT_STATEMENTS,
  NON_CONFORMING_CYPHER,
  conformanceParams,
} from '../../../lib/org-graph/ontology'
import {
  MEMBER_ID_CONSTRAINT,
  backfillMemberIds,
} from '../../../lib/org-graph/scripts/backfill-member-ids'

// A real database applying two dozen schema changes: the 5s default is a
// laptop-idle figure, not a bound on correctness.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 })

const URL = process.env.ORG_GRAPH_TEST_NEO4J_URL
const ENABLED = !!URL && process.env.ORG_GRAPH_TEST_NEO4J_DISPOSABLE === 'yes-wipe'

/** The five constraints the live graphs carried, as `SHOW CONSTRAINTS` renders them. */
const LIVE_PRE_V2 = [
  'CREATE CONSTRAINT `org_knowledge_key` IF NOT EXISTS FOR (n:`Knowledge`) REQUIRE (n.`key`) IS UNIQUE',
  'CREATE CONSTRAINT `org_member_entra_id` IF NOT EXISTS FOR (n:`Member`) REQUIRE (n.`entraId`) IS UNIQUE',
  'CREATE CONSTRAINT `org_member_mail` IF NOT EXISTS FOR (n:`Member`) REQUIRE (n.`mail`) IS UNIQUE',
  'CREATE CONSTRAINT `org_resource_key` IF NOT EXISTS FOR (n:`Resource`) REQUIRE (n.`key`) IS UNIQUE',
  'CREATE CONSTRAINT `org_team_entra_id` IF NOT EXISTS FOR (n:`Team`) REQUIRE (n.`entraId`) IS UNIQUE',
]

describe.skipIf(!ENABLED)(
  'Member id backfill and the amended ontology on a disposable database',
  () => {
    let driver: Driver
    const run = async (cypher: string, params: Record<string, unknown> = {}) => {
      const session = driver.session()
      try {
        return await session.run(cypher, params)
      } finally {
        await session.close()
      }
    }
    const constraintNames = async () =>
      (await run('SHOW CONSTRAINTS YIELD name RETURN name ORDER BY name')).records.map((r) =>
        String(r.get('name')),
      )
    const ids = async () =>
      (await run('MATCH (m:Member) RETURN m.entraId AS e, m.id AS id ORDER BY e')).records.map(
        (r) => [r.get('e'), r.get('id')] as [string, string | null],
      )

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
      if ((await constraintNames()).length > 0)
        throw new Error(`refusing: ${URL} holds constraints`)
      for (const statement of LIVE_PRE_V2) await run(statement)
      // Three members as the ingest wrote them before ids, one as it writes them now.
      await run(
        `UNWIND range(1, 3) AS i
       CREATE (:Member {entraId: 'old-' + i, displayName: 'Old ' + i,
                        mail: 'old' + i + '@example.test', syncedAt: datetime()})
       WITH count(*) AS _
       CREATE (:Member {entraId: 'new-1', displayName: 'New 1', mail: 'new1@example.test',
                        id: 'kept-id', syncedAt: datetime()})`,
      )
    })

    afterAll(async () => {
      if (!driver) return
      await run('MATCH (n) DETACH DELETE n')
      for (const name of await constraintNames()) {
        await run(`DROP CONSTRAINT \`${name}\` IF EXISTS`)
      }
      await driver.close()
    })

    it('applies the amended schema over the live constraints, leaving none orphaned', async () => {
      for (const statement of CONSTRAINT_STATEMENTS) await run(statement)
      const names = await constraintNames()
      expect(names.filter((n) => !CONSTRAINT_NAMES.includes(n))).toEqual([])
      expect(names).toEqual(expect.arrayContaining(['org_knowledge_key', 'org_resource_key']))
      expect(names).not.toContain(MEMBER_ID_CONSTRAINT)
      expect(names).toHaveLength(CONSTRAINT_STATEMENTS.length)
    })

    it('backfills only the members without an id, then applies Member.id', async () => {
      const report = await backfillMemberIds(driver)
      expect(report).toEqual({
        before: { members: 4, withId: 1 },
        assigned: 3,
        after: { members: 4, withId: 4 },
        constraint: true,
      })
      const after = await ids()
      expect(after.find(([e]) => e === 'new-1')![1]).toBe('kept-id')
      expect(new Set(after.map(([, id]) => id)).size).toBe(4)
      for (const [, id] of after) expect(id).toMatch(/^[0-9a-f-]{36}$|^kept-id$/)
      const names = await constraintNames()
      expect(names.filter((n) => !CONSTRAINT_NAMES.includes(n))).toEqual([])
      expect([...CONSTRAINT_NAMES].sort()).toEqual(names)
    })

    it('is idempotent, and the database now refuses a duplicate member id', async () => {
      const before = await ids()
      expect(await backfillMemberIds(driver)).toMatchObject({ assigned: 0, constraint: true })
      expect(await ids()).toEqual(before)
      await expect(
        run(
          `CREATE (:Member {entraId: 'dup', displayName: 'D', mail: 'd@example.test', id: 'kept-id'})`,
        ),
      ).rejects.toThrow()
    })

    it('counts a knowledge item about a project as conforming, and one about a person as not', async () => {
      await run(
        `CREATE (p:Project {id: 'p1', name: 'Osprey', nameKey: 'osprey', createdBy: 'u', createdAt: 't'})
       CREATE (r:Resource {id: 'r1', name: 'Runbook', nameKey: 'runbook', kind: 'document',
                           createdBy: 'u', createdAt: 't'})
       CREATE (k:Knowledge {id: 'k1', name: 'Onboarding guide', nameKey: 'onboarding guide',
                            createdBy: 'u', createdAt: 't'})
       CREATE (k)-[:ABOUT]->(p), (p)-[:USES]->(r)`,
      )
      const drift = async () =>
        (await run(NON_CONFORMING_CYPHER, conformanceParams())).records.map((r) => ({
          kind: r.get('kind'),
          count: r.get('count').toNumber(),
        }))
      expect(await drift()).toEqual([])

      await run(
        `MATCH (k:Knowledge {id: 'k1'}), (m:Member {entraId: 'old-1'}) CREATE (k)-[:ABOUT]->(m)`,
      )
      expect(await drift()).toEqual([{ kind: 'relation_endpoints', count: 1 }])
    })
  },
)
