/**
 * Seed the ten invented members into a Neo4j — for LOCAL MANUAL USE.
 *
 *   pnpm dlx tsx --env-file=.env src/lib/org-graph/scripts/seed-eval-members.ts --target localhost:7687
 *
 * The members are `SYNTHETIC_MEMBERS` (`lib/eval-support/synthetic-org-graph.ts`),
 * the same invented records the Eval's synthetic graph holds, so a local dev graph
 * with no directory ingest still has people for the dev UI and the Org.graph tab
 * to show. **No eval reads what this writes**: every eval path runs on the
 * per-scenario synthetic graph, and `no-real-neo4j.test.ts` pins that.
 *
 * Two refusals keep it off a graph that holds directory data, where ten invented
 * colleagues would join the egress roster and the pseudonymiser's directory and
 * count as stale forever:
 *  - `--target <host:port>` is REQUIRED and must equal the env's resolved Neo4j
 *    host, so the graph being written is named by the person running it;
 *  - the write REFUSES, inside its own transaction, when the target holds any
 *    `Member` it did not write (`createdBy` other than `'eval-seed'`), i.e. any
 *    ingested directory member. Nothing is written then.
 *
 * Idempotent and additive: one transaction of `MERGE` on the invented `entraId`.
 * A node it creates is marked `createdBy: 'eval-seed'`, and only such a node is
 * ever updated. Nothing is deleted. The live uniqueness constraints
 * (`Member.entraId`, `Member.mail`) still bind: a clash fails the whole
 * transaction and writes nothing. Run from `app/`. Prints counts only.
 */
import { pathToFileURL } from 'node:url'
import neo4j, { type Driver } from 'neo4j-driver'
import { SYNTHETIC_MEMBERS } from '../../eval-support/synthetic-org-graph'
import { NON_CONFORMING_CYPHER, conformanceParams } from '../ontology'

export const EVAL_SEED_CREATED_BY = 'eval-seed'

/** Members the seed did not write: any one of them means directory data. */
export const FOREIGN_MEMBERS_CYPHER = `
  MATCH (m:Member) WHERE m.createdBy IS NULL OR m.createdBy <> $createdBy
  RETURN count(m) AS foreign
`

/** The seed's refusal; its message carries counts and hosts only. */
export class SeedRefused extends Error {
  override name = 'SeedRefused'
}

export const SEED_MEMBERS_CYPHER = `
  UNWIND $rows AS row
  MERGE (m:Member {entraId: row.entraId})
  ON CREATE SET m.id = randomUUID(), m.createdBy = $createdBy, m.createdAt = datetime()
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

/** Upsert the ten members; returns how many rows were written and skipped.
 *  Throws {@link SeedRefused}, writing nothing, when the target holds any
 *  `Member` the seed did not write. */
export async function seedEvalMembers(
  driver: Driver,
): Promise<{ written: number; skipped: number }> {
  const rows = seedRows()
  const session = driver.session({ defaultAccessMode: neo4j.session.WRITE })
  try {
    const written = await session.executeWrite(async (tx) => {
      const params = { createdBy: EVAL_SEED_CREATED_BY }
      const foreign = toNumber(
        (await tx.run(FOREIGN_MEMBERS_CYPHER, params)).records[0].get('foreign'),
      )
      if (foreign > 0) {
        throw new SeedRefused(
          `refusing: the target holds ${foreign} Member node(s) the seed did not write ` +
            `(directory data); this seed is for a graph with no directory ingest`,
        )
      }
      return toNumber(
        (await tx.run(SEED_MEMBERS_CYPHER, { rows, ...params })).records[0].get('written'),
      )
    })
    return { written, skipped: rows.length - written }
  } finally {
    await session.close()
  }
}

/** The `--target <host:port>` argument, required to equal the resolved host. */
export function checkTarget(argv: readonly string[], resolvedHost: string): void {
  const at = argv.indexOf('--target')
  const named = at >= 0 ? argv[at + 1] : undefined
  if (!named) {
    throw new SeedRefused(`refusing: pass --target ${resolvedHost} to name the graph to write`)
  }
  if (named !== resolvedHost) {
    throw new SeedRefused(`refusing: --target ${named} is not the resolved Neo4j ${resolvedHost}`)
  }
}

async function main(): Promise<void> {
  const { getEndpoints } = await import('../../config/endpoints')
  const { composeSecret } = await import('../../config/compose-credentials.server')
  const url = getEndpoints().neo4j.bolt
  checkTarget(process.argv.slice(2), new URL(url).host)
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
    if (err instanceof SeedRefused) {
      console.error(err.message)
    } else {
      // The name and the driver's error code only: a message can quote a value.
      const code = (err as { code?: unknown })?.code
      console.error('seed failed:', err instanceof Error ? err.name : 'error', code ?? '')
    }
    process.exitCode = 1
  })
}
