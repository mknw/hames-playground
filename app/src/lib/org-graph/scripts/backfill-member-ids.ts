/**
 * Give every `Member` without an `id` one, then apply `Member.id`'s uniqueness
 * constraint — the ONE-OFF backfill for a graph the directory ingest filled
 * before members had ids.
 *
 *   pnpm dlx tsx --env-file=.env src/lib/org-graph/scripts/backfill-member-ids.ts --target localhost:7687
 *
 * Since the ingest sets `ON CREATE SET m.id = randomUUID()`, a new member
 * arrives with an id; this gives one to every member that predates that. The
 * order is the plan's: the backfill first, in ONE transaction that counts
 * before and after and rolls back unless no member is left without an id; the
 * constraint second, because a schema change cannot share a transaction with a
 * data write. `ensureOrgGraphSchema` applies the same constraint on its own
 * once no member lacks an id, so this script is needed once per such graph.
 *
 * Idempotent: an id is set only where none is (`WHERE m.id IS NULL`), never
 * overwritten, so a second run assigns 0. Nothing is deleted. `--target
 * <host:port>` is required and must equal the env's resolved Neo4j host, as for
 * the member seed. Prints counts only — never a name or an id. Run from `app/`.
 */
import { pathToFileURL } from 'node:url'
import neo4j, { type Driver } from 'neo4j-driver'
import {
  MEMBERS_WITHOUT_ID_CYPHER,
  MEMBER_ID_CONSTRAINT_STATEMENT,
  constraintName,
} from '../ontology'
import { SeedRefused, checkTarget } from './seed-eval-members'

/** Members, and how many of them carry an id. Read-only. */
export const MEMBER_ID_COUNTS_CYPHER = `
  MATCH (m:Member) RETURN count(m) AS members, count(m.id) AS withId
`

/** The backfill itself: only where no id is, never overwriting one. */
export const BACKFILL_MEMBER_IDS_CYPHER = `
  MATCH (m:Member) WHERE m.id IS NULL
  SET m.id = randomUUID()
  RETURN count(m) AS assigned
`

export const MEMBER_ID_CONSTRAINT = constraintName('Member', 'id')

export interface MemberIdCounts {
  members: number
  withId: number
}

export interface BackfillReport {
  before: MemberIdCounts
  assigned: number
  after: MemberIdCounts
  /** Whether `org_member_id` exists once the run is over. */
  constraint: boolean
}

/** The backfill refused to commit; nothing it did is kept. */
export class BackfillRefused extends Error {
  override name = 'BackfillRefused'
}

const toNumber = (v: unknown): number =>
  neo4j.isInt(v) ? (v as { toNumber(): number }).toNumber() : Number(v)

type Run = (
  cypher: string,
  params?: Record<string, unknown>,
) => Promise<{ records: { get(key: string): unknown }[] }>

async function counts(run: Run): Promise<MemberIdCounts> {
  const row = (await run(MEMBER_ID_COUNTS_CYPHER)).records[0]
  if (!row) throw new BackfillRefused('the member count returned no row')
  return { members: toNumber(row.get('members')), withId: toNumber(row.get('withId')) }
}

/**
 * Backfill, then apply the constraint. Throws {@link BackfillRefused}, keeping
 * nothing, when the transaction would end with a member still lacking an id;
 * the constraint is then not applied either.
 */
export async function backfillMemberIds(driver: Driver): Promise<BackfillReport> {
  const write = driver.session({ defaultAccessMode: neo4j.session.WRITE })
  let before: MemberIdCounts
  let assigned: number
  let after: MemberIdCounts
  try {
    ;({ before, assigned, after } = await write.executeWrite(async (tx) => {
      const run: Run = (cypher, params) => tx.run(cypher, params)
      const before = await counts(run)
      const row = (await run(BACKFILL_MEMBER_IDS_CYPHER)).records[0]
      const assigned = row ? toNumber(row.get('assigned')) : 0
      const after = await counts(run)
      // Throwing inside the unit of work rolls the transaction back.
      if (after.withId !== after.members) {
        throw new BackfillRefused(
          `refusing to commit: ${after.members - after.withId} of ${after.members} member(s) ` +
            `would still lack an id (${before.members} before)`,
        )
      }
      return { before, assigned, after }
    }))
    // The same condition `ensureOrgGraphSchema` checks, read again after the
    // commit: a member written without an id since then defers the constraint.
    const missing = (await write.run(MEMBERS_WITHOUT_ID_CYPHER)).records[0]
    if (missing && toNumber(missing.get('missing')) === 0) {
      await write.run(MEMBER_ID_CONSTRAINT_STATEMENT)
    }
  } finally {
    await write.close()
  }
  const read = driver.session({ defaultAccessMode: neo4j.session.READ })
  try {
    const shown = await read.run('SHOW CONSTRAINTS YIELD name WHERE name = $name RETURN name', {
      name: MEMBER_ID_CONSTRAINT,
    })
    return { before, assigned, after, constraint: shown.records.length === 1 }
  } finally {
    await read.close()
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
    console.log(JSON.stringify(await backfillMemberIds(driver)))
  } finally {
    await driver.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    if (err instanceof SeedRefused || err instanceof BackfillRefused) {
      console.error(err.message)
    } else {
      // The name and the driver's error code only: a message can quote a value.
      const code = (err as { code?: unknown })?.code
      console.error('backfill failed:', err instanceof Error ? err.name : 'error', code ?? '')
    }
    process.exitCode = 1
  })
}
