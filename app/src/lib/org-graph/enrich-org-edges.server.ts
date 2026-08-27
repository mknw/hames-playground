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
 * `Group.Read.All` lands) is untouched **by step 2** — `clearInferredEdges`
 * deletes only relationships carrying `inferred: true`, and
 * `roster-ingest.server.ts` never sets that. **Step 1 is a narrower claim
 * than the module used to state**: `reclassifyResourceAccounts`'s
 * `DETACH DELETE m` removes *every* relationship on a reclassified node,
 * regardless of provenance. Latent today — every edge in the graph is
 * `inferred: true`, so there is nothing ingested to lose — and live the day a
 * real `MEMBER_OF` edge exists on a node this module's account-shape
 * heuristic also reclassifies.
 *
 * ## Reclassification is gated behind `apply`
 * `reclassifyResourceAccounts` is an irreversible `DETACH DELETE`, reached at
 * confidence {@link RESOURCE_CONFIDENCE} with no dry-run of its own — the same
 * class of operation `schema.server.ts`'s `WIPE_CONFIRMATION` exists to keep
 * out of an ordinary run. `runOrgEdgeEnrichment`'s `apply` option is that
 * gate's cheaper form for a per-row rather than whole-graph operation: with
 * `apply: false` (the CLI script's default, no `--apply`), every other step
 * still runs, but a candidate is only ever *reported*, never converted or
 * deleted. `scripts/enrich-org-edges.ts` prints each candidate through
 * `_redact.ts`'s `mask()` so the shape of what would be deleted is visible
 * without a name or address ever leaving the process.
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

/** Namespaces every write this module marks `inferred: true`, so the
 *  otherwise-global deletes below (`clearInferredEdges`,
 *  `clearOrphanInferredTeams`) only ever remove what this module itself
 *  wrote — not an `inferred` marker some other agent, or a tool result
 *  steering one, sets on a real ingested edge through the `neo4j` MCP
 *  namespace. A legacy edge from before this constant existed carries no
 *  `inferredBy` at all; both deletes also match that case, which is what
 *  lets one `--apply` run migrate the graph onto the namespaced form without
 *  leaving stale pre-migration structure behind (disclosed, not a gap this
 *  namespacing is meant to close: an edge with no `inferredBy` was already
 *  swept by the un-namespaced predicate this replaces, so nothing already
 *  reachable becomes newly reachable). */
const INFERRED_BY = 'org-edge-enrichment' as const

/** A resource-shaped `Member` this run found — reported whether or not it was
 *  written, so a dry run can be reviewed before `apply: true`. Identity-
 *  bearing: a caller printing these must mask them (`scripts/enrich-org-edges.ts`
 *  goes through `_redact.ts`'s `mask()`). */
export interface ResourceCandidate {
  mail: string
  displayName: string
}

export interface EnrichOptions {
  /** Write the resource reclassification (the `DETACH DELETE` of the source
   *  `Member`). Without it, candidates are still computed and reported, but
   *  nothing is converted or deleted — matching `schema.server.ts`'s
   *  `WIPE_CONFIRMATION` precedent that an irreversible step needs an
   *  explicit, undefaultable argument rather than running by default. Every
   *  other step (clearing + re-deriving `MEMBER_OF` groupings) runs
   *  regardless of this flag. */
  apply: boolean
}

export interface EnrichmentReport {
  /** `Member` nodes converted to `Resource` this run. 0 when `apply` is false. */
  resourcesReclassified: number
  /** Resource-shaped candidates found this run, whether or not `apply` wrote
   *  them. */
  reclassificationCandidates: readonly ResourceCandidate[]
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
  /** Inferred `Team` nodes with no remaining member, deleted after this run's
   *  re-derive (a title/department losing its last holder, or the last
   *  holder being reclassified to `Resource`). */
  orphanTeamsCleared: number
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
 * module header for why this is a MERGE-and-delete rather than a relabel,
 * and for why the write is gated behind `apply`.
 */
async function reclassifyResourceAccounts(
  members: readonly MemberFields[],
  apply: boolean,
): Promise<{ converted: number; candidates: readonly ResourceCandidate[] }> {
  const matches = members.filter(looksLikeResourceAccount)
  if (matches.length === 0) return { converted: 0, candidates: [] }

  const candidates = matches.map((c) => ({ mail: c.mail, displayName: c.displayName }))
  if (!apply) return { converted: 0, candidates }

  const session = getNeo4jDriver().session({ defaultAccessMode: neo4j.session.WRITE })
  try {
    const result = await session.run(
      `UNWIND $rows AS row
       MATCH (m:Member {entraId: row.entraId})
       MERGE (r:Resource {key: row.mail})
       SET r.name = row.displayName,
           r.entraId = row.entraId,
           r.inferred = true,
           r.inferredBy = $inferredBy,
           r.basis = $basis,
           r.confidence = $confidence,
           r.inferredAt = datetime()
       DETACH DELETE m
       RETURN count(r) AS converted`,
      {
        rows: matches.map((c) => ({
          entraId: c.entraId,
          mail: c.mail,
          displayName: c.displayName,
        })),
        inferredBy: INFERRED_BY,
        basis: RESOURCE_BASIS,
        confidence: RESOURCE_CONFIDENCE,
      },
    )
    return { converted: toCount(result.records[0]?.get('converted')), candidates }
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
 * `inferred`. Scoped by {@link INFERRED_BY} (or its absence, for a
 * pre-migration edge) — see that constant's doc for what this does and does
 * not protect against.
 */
async function clearInferredEdges(): Promise<number> {
  const session = getNeo4jDriver().session({ defaultAccessMode: neo4j.session.WRITE })
  try {
    const result = await session.run(
      `MATCH ()-[r]->()
       WHERE r.inferred = true AND (r.inferredBy = $inferredBy OR r.inferredBy IS NULL)
       DELETE r RETURN count(r) AS cleared`,
      { inferredBy: INFERRED_BY },
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
           t.inferredBy = $inferredBy,
           t.basis = row.basis,
           t.confidence = row.confidence,
           t.inferredAt = datetime()
       WITH t, row
       MATCH (m:Member {entraId: row.memberId})
       MERGE (m)-[r:MEMBER_OF]->(t)
       SET r.inferred = true,
           r.inferredBy = $inferredBy,
           r.basis = row.basis,
           r.confidence = row.confidence,
           r.inferredAt = datetime()
       RETURN count(DISTINCT t) AS teams, count(r) AS edges`,
      { rows, inferredBy: INFERRED_BY },
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
 * Delete every inferred `Team` this module owns that no longer has a member —
 * the last holder of a role or department was reclassified or re-derived
 * elsewhere. `clearInferredEdges` only ever removes relationships, so a
 * `Team` node itself survives an edge clear indefinitely unless something
 * else checks for this; `countNonConforming` cannot see it either, because a
 * zero-member `Team` still conforms to the ontology.
 */
async function clearOrphanInferredTeams(): Promise<number> {
  const session = getNeo4jDriver().session({ defaultAccessMode: neo4j.session.WRITE })
  try {
    const result = await session.run(
      `MATCH (t:Team {inferred: true})
       WHERE (t.inferredBy = $inferredBy OR t.inferredBy IS NULL) AND NOT (t)<-[:MEMBER_OF]-()
       DELETE t RETURN count(t) AS cleared`,
      { inferredBy: INFERRED_BY },
    )
    return toCount(result.records[0]?.get('cleared'))
  } finally {
    await session.close()
  }
}

/**
 * Apply the schema, reclassify resource accounts, clear and re-derive every
 * inferred `MEMBER_OF` grouping, then drop any inferred `Team` left with no
 * member. Safe to run repeatedly and after a graph wipe + re-ingest: every
 * step re-derives from the roster's current state rather than from what a
 * previous run left behind.
 */
export async function runOrgEdgeEnrichment(options: EnrichOptions): Promise<EnrichmentReport> {
  await ensureOrgGraphSchema()
  const members = await fetchAllMembers()

  const { converted: resourcesReclassified, candidates: reclassificationCandidates } =
    await reclassifyResourceAccounts(members, options.apply)
  const inferredEdgesCleared = await clearInferredEdges()

  const roleRows = buildRoleGroupEdges(members)
  const departmentRows = buildDepartmentGroupEdges(members)
  const roleResult = await writeGroupEdges(roleRows)
  const departmentResult = await writeGroupEdges(departmentRows)
  const orphanTeamsCleared = await clearOrphanInferredTeams()

  return {
    resourcesReclassified,
    reclassificationCandidates,
    inferredEdgesCleared,
    roleTeams: roleResult.teams,
    roleEdges: roleResult.edges,
    departmentTeams: departmentResult.teams,
    departmentEdges: departmentResult.edges,
    orphanTeamsCleared,
    confidenceDistribution: tallyConfidence([...roleRows, ...departmentRows]),
  }
}

function toCount(value: unknown): number {
  if (typeof value === 'number') return value
  if (neo4j.isInt(value)) return value.toNumber()
  return Number(value ?? 0)
}
