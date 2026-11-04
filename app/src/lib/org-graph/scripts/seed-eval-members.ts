/**
 * Seed the ten pseudonymised members into a Neo4j — for LOCAL MANUAL USE.
 *
 *   pnpm dlx tsx --env-file=.env src/lib/org-graph/scripts/seed-eval-members.ts
 *
 * The members are `SYNTHETIC_MEMBERS` (`lib/eval-support/synthetic-org-graph.ts`),
 * the same invented records the Eval's synthetic graph holds, so a local dev graph
 * with no directory ingest still has people for the dev UI and the Org.graph tab
 * to show. **No eval reads what this writes**: every eval path runs on the
 * per-scenario synthetic graph, and `no-real-neo4j.test.ts` pins that.
 *
 * Idempotent and additive: one transaction of `MERGE` on the pseudonymous
 * `entraId`. A node it creates is marked `createdBy: 'eval-seed'`, and only such
 * a node is ever updated — a `Member` with the same `entraId` written by anyone
 * else is left as it is and reported as skipped. Nothing is deleted. The live
 * uniqueness constraints (`Member.entraId`, `Member.mail`) still bind: a clash
 * fails the whole transaction and writes nothing.
 *
 * Never point it at a graph holding real directory data you do not want ten
 * invented colleagues in. Run from `app/`; the target is the env's Neo4j, as for
 * `setup-org-graph.ts`. Prints counts only.
 */
import { pathToFileURL } from 'node:url'
import neo4j, { type Driver } from 'neo4j-driver'
import { SYNTHETIC_MEMBERS } from '../../eval-support/synthetic-org-graph'
import { NON_CONFORMING_CYPHER, conformanceParams } from '../ontology'

export const EVAL_SEED_CREATED_BY = 'eval-seed'

export const SEED_MEMBERS_CYPHER = `
  UNWIND $rows AS row
  MERGE (m:Member {entraId: row.entraId})
  ON CREATE SET m.createdBy = $createdBy, m.createdAt = datetime()
  WITH m, row WHERE m.createdBy = $createdBy
  SET m.displayName = row.displayName, m.mail = row.mail, m.jobTitle = row.jobTitle
  RETURN count(m) AS written
`

const COUNTS_CYPHER = `
  CALL { MATCH (n) RETURN count(n) AS nodes }
  CALL { MATCH ()-[r]->() RETURN count(r) AS relationships }
  CALL { MATCH (m:Member) RETURN count(m) AS members }
  CALL { MATCH (m:Member {createdBy: $createdBy}) RETURN count(m) AS seeded }
  RETURN nodes, relationships, members, seeded
`

export interface GraphCounts {
  nodes: number
  relationships: number
  members: number
  seeded: number
  nonConforming: number
}

const toNumber = (v: unknown): number =>
  neo4j.isInt(v) ? (v as { toNumber(): number }).toNumber() : Number(v)

/** The fixture's rows, with only the properties a `Member` carries here. */
export const seedRows = () =>
  SYNTHETIC_MEMBERS.map(({ entraId, displayName, mail, jobTitle }) => ({
    entraId,
    displayName,
    mail,
    jobTitle: jobTitle ?? null,
  }))

export async function readCounts(driver: Driver): Promise<GraphCounts> {
  const session = driver.session({ defaultAccessMode: neo4j.session.READ })
  try {
    const counts = (await session.run(COUNTS_CYPHER, { createdBy: EVAL_SEED_CREATED_BY }))
      .records[0]
    const drift = await session.run(NON_CONFORMING_CYPHER, conformanceParams())
    return {
      nodes: toNumber(counts.get('nodes')),
      relationships: toNumber(counts.get('relationships')),
      members: toNumber(counts.get('members')),
      seeded: toNumber(counts.get('seeded')),
      nonConforming: drift.records.reduce((sum, r) => sum + toNumber(r.get('count')), 0),
    }
  } finally {
    await session.close()
  }
}

/** Upsert the ten members; returns how many rows were written and skipped. */
export async function seedEvalMembers(
  driver: Driver,
): Promise<{ written: number; skipped: number }> {
  const rows = seedRows()
  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE })
  try {
    const written = await session.executeWrite(async (tx) =>
      toNumber(
        (
          await tx.run(SEED_MEMBERS_CYPHER, { rows, createdBy: EVAL_SEED_CREATED_BY })
        ).records[0].get('written'),
      ),
    )
    return { written, skipped: rows.length - written }
  } finally {
    await session.close()
  }
}

async function main(): Promise<void> {
  const { getEndpoints } = await import('../../config/endpoints')
  const { composeSecret } = await import('../../config/compose-credentials.server')
  const url = getEndpoints().neo4j.bolt
  const driver = neo4j.driver(
    url,
    neo4j.auth.basic(process.env.NEO4J_USER || 'neo4j', composeSecret('NEO4J_PASSWORD') ?? ''),
  )
  try {
    console.log(`target: ${new URL(url).host}`)
    console.log('before:', JSON.stringify(await readCounts(driver)))
    console.log('seed:  ', JSON.stringify(await seedEvalMembers(driver)))
    console.log('after: ', JSON.stringify(await readCounts(driver)))
  } finally {
    await driver.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    // The name and the driver's error code only: a message can quote a value.
    const code = (err as { code?: unknown })?.code
    console.error('seed failed:', err instanceof Error ? err.name : 'error', code ?? '')
    process.exitCode = 1
  })
}
