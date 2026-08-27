/**
 * The organizational-graph ontology — one source of truth, pure and I/O-free.
 *
 * The graph holds organizational structure only: **members, resources,
 * knowledge**, and the relations between them. This module is the machine-
 * readable half of `docs/org-graph.md`; the doc is the prose half and cites
 * these exports rather than restating them. Change one, change the other.
 *
 * ## What enforces what, and why it is split
 * The compose stack runs **Neo4j 5.26 Community** (`docker-compose.yaml`), and
 * Community supports exactly one of the four constraint kinds this ontology
 * would want. Verified against the running container rather than read off a
 * feature matrix — the refusals are quoted in `docs/org-graph.md`:
 *
 * | Constraint kind          | Community 5.26 |
 * | ------------------------ | -------------- |
 * | `IS UNIQUE`              | supported      |
 * | `IS NOT NULL` (existence)| **Enterprise** |
 * | `IS NODE KEY`            | **Enterprise** |
 * | `IS :: <TYPE>`           | **Enterprise** |
 *
 * So identity (uniqueness) is enforced by the database and presence is
 * enforced by {@link validateMember} at the write boundary. That is a real
 * difference in strength, not a formality: a uniqueness constraint holds
 * against *every* writer including the browser edit affordances in
 * `neo4j/graph-edit.server.ts`, while app-side validation holds only for
 * callers that route through this module. `docs/org-graph.md` says so plainly
 * and {@link NON_CONFORMING_CYPHER} is how the gap is measured instead of
 * assumed.
 *
 * ## Required, in two tiers, because the directory is the source of truth
 * `Member` declares four required properties. `entraId` / `displayName` /
 * `mail` are **hard**: a row without them is not a member and is rejected.
 * `department` / `jobTitle` are **soft**: required by the ontology, but the
 * tenant — not this app — decides whether they are filled in, and on the live
 * directory `department` is set on 1 of 49 eligible accounts. Rejecting on a
 * soft property would have discarded 48 people to satisfy a schema; inventing
 * a placeholder value would have put a lie in the graph. So a soft miss is
 * written through and **counted**, which makes the gap visible in the ingest
 * report instead of silent. Promoting a soft property to hard is one line here
 * once the directory is complete.
 */

/** Node labels this graph admits. Anything else is non-conforming data. */
export const NODE_LABELS = ['Member', 'Team', 'Resource', 'Knowledge'] as const
export type NodeLabel = (typeof NODE_LABELS)[number]

/**
 * Relation types this graph admits, each with the endpoint labels it may join
 * and the one-line reason it exists. There is deliberately **no** reporting
 * relation: see the note on {@link RELATIONS}.
 */
export interface RelationSpec {
  readonly type: string
  readonly from: readonly NodeLabel[]
  readonly to: readonly NodeLabel[]
  readonly why: string
  /**
   * True when EVERY instance of this relation must carry `inferred: true`.
   * Declared per-relation rather than assumed, because it is what lets a
   * `Member`→`Member` edge exist at all without reopening the no-reports-to
   * decision below: an ingested fact can misrepresent authority, but a
   * relation that can only ever be machine-derived cannot, and
   * {@link NON_CONFORMING_CYPHER} enforces the stamp is actually present.
   */
  readonly requiresInferred?: boolean
}

/**
 * The relation set. `MEMBER_OF` and `COORDINATES` are given; the other four are
 * the minimum that lets resources and knowledge attach to anything at all.
 * `COLLABORATES_WITH` is the one addition since (see its own entry below).
 *
 * **No reports-to, by decision.** No `REPORTS_TO` / `MANAGES` / `LEADS` edge
 * exists here, and `COORDINATES` is not a stand-in for one: it points at a
 * *team*, never at a person, so nothing in this ontology can express authority
 * of one individual over another. Graph's `/users` payload carries a `manager`
 * relationship; the ingest does not read it.
 */
export const RELATIONS: readonly RelationSpec[] = [
  {
    type: 'MEMBER_OF',
    from: ['Member'],
    to: ['Team'],
    why: 'Who belongs to which team — the one relation the roster ingest is for.',
  },
  {
    type: 'COORDINATES',
    from: ['Member'],
    to: ['Team'],
    why: 'Who convenes a team, as a separate edge so coordination is stated rather than inferred from membership, and points at the team rather than at its people.',
  },
  {
    type: 'PART_OF',
    from: ['Team'],
    to: ['Team'],
    why: 'Team nesting, because Entra groups nest and MEMBER_OF cannot express a sub-team; structural only, and explicitly not a reporting line.',
  },
  {
    type: 'STEWARDS',
    from: ['Team'],
    to: ['Resource'],
    why: 'Which team is accountable for a resource, so "who do I ask about X" is one hop from the resource.',
  },
  {
    type: 'ABOUT',
    from: ['Knowledge'],
    to: ['Member', 'Team', 'Resource'],
    why: 'What a knowledge item documents — one polymorphic attach edge instead of three near-identical typed ones.',
  },
  {
    type: 'AUTHORED',
    from: ['Member'],
    to: ['Knowledge'],
    why: 'Provenance of a knowledge item; the only Member→Knowledge edge needed, and the reason Knowledge needs no author property.',
  },
  {
    type: 'COLLABORATES_WITH',
    from: ['Member'],
    to: ['Member'],
    why: 'Evidence-based co-work observed in shared SharePoint activity. The one exception to "no relation joins two Members": it is authority-free by construction (undirected in meaning — written once per pair, in an arbitrary canonical direction, never read as "A reports into B") and, per requiresInferred below, can only ever exist as a machine-derived observation, never an ingested fact.',
    requiresInferred: true,
  },
] as const

export const RELATION_TYPES: readonly string[] = RELATIONS.map((r) => r.type)

/** Relation types where every instance MUST carry `inferred: true` — see
 *  {@link RelationSpec.requiresInferred}. Today just `COLLABORATES_WITH`. */
export const INFERRED_ONLY_RELATION_TYPES: readonly string[] = RELATIONS.filter(
  (r) => r.requiresInferred,
).map((r) => r.type)

/**
 * Required properties per label, split into the two tiers the module header
 * explains. `key`/`entraId` values are the identity a uniqueness constraint is
 * declared on; see {@link CONSTRAINT_STATEMENTS}.
 */
export interface LabelSpec {
  readonly label: NodeLabel
  /** Rejected if absent. */
  readonly hard: readonly string[]
  /** Written through if absent, and counted. */
  readonly soft: readonly string[]
  /** Properties a Neo4j uniqueness constraint is declared on. */
  readonly unique: readonly string[]
}

export const LABEL_SPECS: readonly LabelSpec[] = [
  {
    label: 'Member',
    hard: ['entraId', 'displayName', 'mail'],
    soft: ['department', 'jobTitle'],
    unique: ['entraId', 'mail'],
  },
  { label: 'Team', hard: ['entraId', 'name'], soft: [], unique: ['entraId'] },
  { label: 'Resource', hard: ['key', 'name'], soft: [], unique: ['key'] },
  { label: 'Knowledge', hard: ['key', 'title'], soft: [], unique: ['key'] },
] as const

export const labelSpec = (label: NodeLabel): LabelSpec =>
  LABEL_SPECS.find((s) => s.label === label) as LabelSpec

/**
 * The schema statements, in apply order. Every one is `IF NOT EXISTS`, so
 * running the list twice is a no-op — that is what makes the setup path
 * idempotent, and it is the reason the setup path needs no wipe.
 *
 * Names are explicit (`org_member_entra_id`) rather than generated, so
 * `SHOW CONSTRAINTS` output can be diffed against this list by name and a
 * constraint this ontology no longer declares is identifiable as a leftover.
 */
export const CONSTRAINT_STATEMENTS: readonly string[] = LABEL_SPECS.flatMap((spec) =>
  spec.unique.map(
    (prop) =>
      `CREATE CONSTRAINT ${constraintName(spec.label, prop)} IF NOT EXISTS ` +
      `FOR (n:\`${spec.label}\`) REQUIRE n.\`${prop}\` IS UNIQUE`,
  ),
)

/** `org_member_entra_id` — snake_cased label + property, `org_` namespaced so a
 *  leftover from the pre-ontology graph is distinguishable at a glance. */
export function constraintName(label: NodeLabel, property: string): string {
  return `org_${snake(label)}_${snake(property)}`
}

// A function declaration, not a const arrow: `CONSTRAINT_STATEMENTS` calls
// `constraintName` at module-init time, so an arrow declared below it would
// still be in its TDZ.
function snake(s: string): string {
  return s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

/** Every constraint name this ontology declares. */
export const CONSTRAINT_NAMES: readonly string[] = LABEL_SPECS.flatMap((spec) =>
  spec.unique.map((prop) => constraintName(spec.label, prop)),
)

// ============================================================================
// Validation — the presence half, which the database cannot do here
// ============================================================================

/** One reason a record cannot be written, or was written incomplete. */
export interface Violation {
  property: string
  tier: 'hard' | 'soft'
}

/**
 * A candidate `Member` as the ingest hands it over. Deliberately not
 * `Record<string, unknown>`: the four required properties are the contract, and
 * a typo in one of them should be a typecheck error rather than a runtime skip.
 */
export interface MemberRecord {
  entraId: string
  displayName: string
  mail: string
  department: string | null
  jobTitle: string | null
}

const filled = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0

/**
 * Check one member against the ontology. Returns every violation, not the
 * first — an ingest report that says "3 rejected" is worth much less than one
 * that says which property was missing on each.
 *
 * `ok` is false only for a **hard** violation. A soft violation is reported
 * alongside `ok: true`, which is the two-tier policy in one line of code.
 */
export function validateMember(record: Partial<MemberRecord>): {
  ok: boolean
  violations: Violation[]
} {
  const spec = labelSpec('Member')
  const violations: Violation[] = []
  for (const property of spec.hard) {
    if (!filled(record[property as keyof MemberRecord])) violations.push({ property, tier: 'hard' })
  }
  for (const property of spec.soft) {
    if (!filled(record[property as keyof MemberRecord])) violations.push({ property, tier: 'soft' })
  }
  return { ok: !violations.some((v) => v.tier === 'hard'), violations }
}

// ============================================================================
// Conformance — how the un-enforceable half is measured instead of assumed
// ============================================================================

/**
 * Counts every node whose label set is outside {@link NODE_LABELS}, every
 * relationship whose type is outside {@link RELATION_TYPES}, every node
 * missing a hard property, and every instance of an
 * {@link INFERRED_ONLY_RELATION_TYPES} relation that lacks `inferred: true`.
 *
 * The last check is what keeps `COLLABORATES_WITH` from becoming a silent
 * back door around the no-reports-to decision: the relation type itself is
 * conforming (it is declared), but a non-inferred instance — one written by
 * a future caller that skipped the enrichment writer — is drift, exactly like
 * an out-of-ontology label would be.
 *
 * This exists because app-side validation binds only the callers that route
 * through it. `neo4j/graph-edit.server.ts` mints labels and relationship types
 * from free-text UI inputs, validating their *shape* and not their membership
 * in this ontology, so the browser can still create a node label or an edge
 * type nothing here declares — including a reporting edge. Rather than widen
 * that module (a behaviour change nobody asked for), the drift is made
 * countable: run this after any session of manual graph editing, and see
 * `docs/org-graph.md` § "The gap app-side validation leaves".
 *
 * Read-only by construction — no write clause appears in it.
 */
export const NON_CONFORMING_CYPHER = `
  CALL {
    MATCH (n)
    WHERE NOT any(l IN labels(n) WHERE l IN $labels)
    RETURN 'node_label' AS kind, labels(n) AS detail, count(*) AS count
    UNION ALL
    MATCH ()-[r]->()
    WHERE NOT type(r) IN $relationTypes
    RETURN 'relation_type' AS kind, [type(r)] AS detail, count(*) AS count
    UNION ALL
    MATCH (n:Member)
    WHERE n.entraId IS NULL OR n.displayName IS NULL OR n.mail IS NULL
    RETURN 'member_missing_hard' AS kind, [] AS detail, count(*) AS count
    UNION ALL
    MATCH ()-[r]->()
    WHERE type(r) IN $inferredOnlyRelationTypes AND coalesce(r.inferred, false) = false
    RETURN 'relation_missing_inferred_flag' AS kind, [type(r)] AS detail, count(*) AS count
  }
  WITH kind, detail, count WHERE count > 0
  RETURN kind, detail, count ORDER BY kind, count DESC
`

/** Parameters {@link NON_CONFORMING_CYPHER} expects. */
export const conformanceParams = (): {
  labels: string[]
  relationTypes: string[]
  inferredOnlyRelationTypes: string[]
} => ({
  labels: [...NODE_LABELS],
  relationTypes: [...RELATION_TYPES],
  inferredOnlyRelationTypes: [...INFERRED_ONLY_RELATION_TYPES],
})
