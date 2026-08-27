/**
 * Org-graph edge enrichment — Server Only.
 *
 * The org graph shipped in #264 with 48-odd `Member` nodes and zero
 * relationships: the roster ingest writes people, but nothing has ever
 * written the structure between them. This module is the deterministic half
 * of that enrichment — the judgement calls (what counts as a shared mailbox,
 * how a title becomes a team key, what confidence each basis carries) are
 * pure and live in `edge-inference.ts`; this module only fetches the current
 * roster, applies them, and writes the result.
 *
 * ## What it does, in order
 * 1. **Reclassify shared-mailbox accounts** (`Member` → `Resource`) —
 *    {@link looksLikeResourceAccount}.
 * 2. **Clear every previously-inferred relationship** — anything with
 *    `inferred: true`, regardless of type or basis.
 * 3. **Re-derive `MEMBER_OF` groupings** from the current `jobTitle` and
 *    `department` values and write them fresh.
 *
 * Step 2 is what makes step 3 idempotent in the sense the deliverable asks
 * for: **delete-by-provenance, re-create**, on every run, rather than trying
 * to diff the old inferred structure against the new. A run against an
 * unchanged roster reproduces exactly the edges it just deleted; a run after
 * someone's title changes drops the stale grouping and adds the new one. Real
 * ingested structure (`MEMBER_OF` to an actual Entra `Team`, once
 * `Group.Read.All` lands) is untouched, because `roster-ingest.server.ts`
 * never sets `inferred` on what it writes.
 *
 * ## The reclassification is a MERGE, not a relabel
 * `SET m:Resource REMOVE m:Member` looks like the obvious move and is the
 * wrong one: the ontology's uniqueness constraints
 * (`org_member_entra_id`, `org_member_mail`) are scoped to the `:Member`
 * label, so a node that has stopped being `:Member` no longer participates in
 * them. `roster-ingest.server.ts`'s `upsertMembers` runs
 * `MERGE (m:Member {entraId: …})` on every re-ingest — it cannot see a node
 * that is no longer labelled `:Member`, so it would create a **second** node
 * with the same `entraId`/`mail` the first time the roster is re-synced after
 * an enrichment run. `reclassifyResourceAccounts` instead `MERGE`s onto the
 * `Resource` identity (`key = mail`) and `DETACH DELETE`s the source
 * `Member` node in the same write: idempotent regardless of how many times
 * either script runs, in either order, because the identity a re-appeared
 * duplicate collides with is the `Resource` node's own unique key rather than
 * a label that no longer applies.
 *
 * Not a `'use server'` module, and never should be — see `schema.server.ts`'s
 * header (SD-13): a function that reads the whole roster and rewrites its
 * structure must not be browser-reachable. Entry point is
 * `scripts/enrich-org-edges.ts`.
 */
import neo4j from 'neo4j-driver'
import { assertServerOnImport } from '../harness-patterns/assert.server'
import { getNeo4jDriver } from '../neo4j/client'
import { ensureOrgGraphSchema } from './schema.server'
import {
  RESOURCE_BASIS,
  RESOURCE_CONFIDENCE,
  buildDepartmentGroupEdges,
  buildRoleGroupEdges,
  looksLikeResourceAccount,
  tallyConfidence,
  type GroupEdge,
  type MemberFields,
} from './edge-inference'

assertServerOnImport()

export interface EnrichmentReport {
  /** `Member` nodes converted to `Resource` this run. */
  resourcesReclassified: number
  /** Previously-inferred relationships deleted before re-deriving them. */
  inferredEdgesCleared: number
  /** Inferred `Team` nodes MERGEd from `jobTitle` values. */
  roleTeams: number
  /** Inferred `MEMBER_OF` edges written from `jobTitle` values. */
  roleEdges: number
  /** Inferred `Team` nodes MERGEd from `department` values. */
  departmentTeams: number
  /** Inferred `MEMBER_OF` edges written from `department` values. */
  departmentEdges: number
  /** Edge count by confidence value, across both grouping bases. */
  confidenceDistribution: Record<string, number>
}

/** Every `Member`'s fields this module's inference reads. Never returned to a
 *  caller outside this module — see the report shape above. */
async function fetchAllMembers(): Promise<MemberFields[]> {
  const session = getNeo4jDriver().session({ defaultAccessMode: neo4j.session.READ })
  try {
    const result = await session.run(
      `MATCH (m:Member)
       RETURN m.entraId AS entraId, m.displayName AS displayName, m.mail AS mail,
              m.jobTitle AS jobTitle, m.department AS department`,
    )
    return result.records.map((r) => ({
      entraId: String(r.get('entraId')),
      displayName: String(r.get('displayName')),
      mail: String(r.get('mail')),
      jobTitle: (r.get('jobTitle') as string | null) ?? null,
      department: (r.get('department') as string | null) ?? null,
    }))
  } finally {
    await session.close()
  }
}

/**
 * Convert every shared-mailbox-shaped `Member` to a `Resource`. See the
 * module header for why this is a MERGE-and-delete rather than a relabel.
 */
async function reclassifyResourceAccounts(members: readonly MemberFields[]): Promise<number> {
  const candidates = members.filter(looksLikeResourceAccount)
  if (candidates.length === 0) return 0

  const session = getNeo4jDriver().session({ defaultAccessMode: neo4j.session.WRITE })
  try {
    const result = await session.run(
      `UNWIND $rows AS row
       MATCH (m:Member {entraId: row.entraId})
       MERGE (r:Resource {key: row.mail})
       SET r.name = row.displayName,
           r.entraId = row.entraId,
           r.inferred = true,
           r.basis = $basis,
           r.confidence = $confidence,
           r.inferredAt = datetime()
       DETACH DELETE m
       RETURN count(r) AS converted`,
      {
        rows: candidates.map((c) => ({
          entraId: c.entraId,
          mail: c.mail,
          displayName: c.displayName,
        })),
        basis: RESOURCE_BASIS,
        confidence: RESOURCE_CONFIDENCE,
      },
    )
    return toCount(result.records[0]?.get('converted'))
  } finally {
    await session.close()
  }
}

/**
 * Delete every relationship this module (or a future inference basis) has
 * ever marked `inferred: true`, whatever its type. Blanket by type on
 * purpose: the set of bases is expected to grow, and a per-basis delete list
 * here would need to be kept in sync with `edge-inference.ts` by hand. Real
 * ingested relationships are untouched because nothing else in this app sets
 * `inferred`.
 */
async function clearInferredEdges(): Promise<number> {
  const session = getNeo4jDriver().session({ defaultAccessMode: neo4j.session.WRITE })
  try {
    const result = await session.run(
      `MATCH ()-[r]->() WHERE r.inferred = true DELETE r RETURN count(r) AS cleared`,
    )
    return toCount(result.records[0]?.get('cleared'))
  } finally {
    await session.close()
  }
}

/**
 * Write a batch of {@link GroupEdge} rows: MERGE the inferred `Team` each row
 * points at, then MERGE the `MEMBER_OF` edge and stamp both with provenance.
 * Teams sharing a `teamKey` collapse onto one node — that is the grouping.
 */
async function writeGroupEdges(
  rows: readonly GroupEdge[],
): Promise<{ teams: number; edges: number }> {
  if (rows.length === 0) return { teams: 0, edges: 0 }

  const session = getNeo4jDriver().session({ defaultAccessMode: neo4j.session.WRITE })
  try {
    const result = await session.run(
      `UNWIND $rows AS row
       MERGE (t:Team {entraId: row.teamKey})
       SET t.name = row.teamName,
           t.inferred = true,
           t.basis = row.basis,
           t.confidence = row.confidence,
           t.inferredAt = datetime()
       WITH t, row
       MATCH (m:Member {entraId: row.memberId})
       MERGE (m)-[r:MEMBER_OF]->(t)
       SET r.inferred = true,
           r.basis = row.basis,
           r.confidence = row.confidence,
           r.inferredAt = datetime()
       RETURN count(DISTINCT t) AS teams, count(r) AS edges`,
      { rows },
    )
    return {
      teams: toCount(result.records[0]?.get('teams')),
      edges: toCount(result.records[0]?.get('edges')),
    }
  } finally {
    await session.close()
  }
}

/**
 * Apply the schema, reclassify resource accounts, clear and re-derive every
 * inferred `MEMBER_OF` grouping. Safe to run repeatedly and after a graph
 * wipe + re-ingest: every step re-derives from the roster's current state
 * rather than from what a previous run left behind.
 */
export async function runOrgEdgeEnrichment(): Promise<EnrichmentReport> {
  await ensureOrgGraphSchema()
  const members = await fetchAllMembers()

  const resourcesReclassified = await reclassifyResourceAccounts(members)
  const inferredEdgesCleared = await clearInferredEdges()

  const roleRows = buildRoleGroupEdges(members)
  const departmentRows = buildDepartmentGroupEdges(members)
  const roleResult = await writeGroupEdges(roleRows)
  const departmentResult = await writeGroupEdges(departmentRows)

  return {
    resourcesReclassified,
    inferredEdgesCleared,
    roleTeams: roleResult.teams,
    roleEdges: roleResult.edges,
    departmentTeams: departmentResult.teams,
    departmentEdges: departmentResult.edges,
    confidenceDistribution: tallyConfidence([...roleRows, ...departmentRows]),
  }
}

function toCount(value: unknown): number {
  if (typeof value === 'number') return value
  if (neo4j.isInt(value)) return value.toNumber()
  return Number(value ?? 0)
}
