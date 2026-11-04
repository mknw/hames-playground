/**
 * The organizational-graph ontology — one source of truth, pure and I/O-free.
 *
 * The graph holds organizational structure only: **members, pillars, themes,
 * teams, projects and what attaches to them**, and the relations between them
 * (`docs/plan/org-knowledge-hook.md`, "The ontology"). This module is the
 * machine-readable half of `docs/org-graph.md`; the doc is the prose half and
 * cites these exports rather than restating them. Change one, change the
 * other. The organizational-knowledge hook checks every proposal against
 * {@link ORG_ONTOLOGY}.
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

import {
  defineOntology,
  type GraphOntology,
  type OntologyClass,
  type OntologyRelation,
} from '@hames-ai/harness-patterns/org-knowledge-ontology'

/**
 * The ontology as data, in the shape `@hames-ai/harness-patterns` checks a
 * proposal against (`docs/plan/org-knowledge-hook.md`, "The ontology"). Ten
 * classes; every name here is a vocabulary term, never organisation data — the
 * seeded pillars and themes come from configuration outside the repo.
 *
 * `Member` [the design's Person] and `Pillar` are linked to and never created
 * by a proposal (axioms A3, A6). `Theme` is seeded AND proposable (amended A6).
 * `Team` [Group] is the directory's group and a proposal's group alike, so one
 * team cannot exist twice (LD-1). `Knowledge`, `AUTHORED` and `STEWARDS` are
 * retired (LD-2): declared, never written, in no ruling.
 */
export const NODE_LABELS = [
  'Member',
  'Pillar',
  'Theme',
  'Team',
  'Project',
  'Deliverable',
  'Deadline',
  'Partner',
  'Resource',
  'Fact',
] as const
export type NodeLabel = (typeof NODE_LABELS)[number]

/** Resource kinds and fact kinds: closed sets, by ruling (Fact: 2026-11-04). */
export const RESOURCE_KINDS = ['document', 'system', 'dataset', 'tool'] as const
export const FACT_KINDS = ['budget', 'status', 'decision', 'risk'] as const

const NONE = {} as const
const named = (
  label: NodeLabel,
  extra: Partial<OntologyClass> & Pick<OntologyClass, 'creatable'>,
): OntologyClass => ({
  label,
  nameProperty: 'name',
  required: ['name'],
  optional: [],
  derived: NONE,
  closed: NONE,
  dates: [],
  lines: [],
  identity: 'nameKey',
  personFree: false,
  ...extra,
})

/** Every label that is not a person or a fact: what a fact may be about. */
const ABOUTABLE: readonly NodeLabel[] = NODE_LABELS.filter((l) => l !== 'Member' && l !== 'Fact')

export const ORG_ONTOLOGY: GraphOntology = defineOntology({
  classes: [
    {
      label: 'Member',
      nameProperty: 'displayName',
      required: ['displayName'],
      optional: [],
      derived: NONE,
      closed: NONE,
      dates: [],
      lines: [],
      identity: 'nameKey',
      personFree: false,
      creatable: false,
    },
    named('Pillar', { required: ['name', 'objective'], creatable: false }),
    named('Theme', { optional: ['discipline'], creatable: true }),
    named('Team', { creatable: true }),
    named('Project', { optional: ['status', 'description'], creatable: true }),
    named('Deliverable', { optional: ['description'], creatable: true }),
    {
      label: 'Deadline',
      nameProperty: 'label',
      required: ['label', 'date'],
      optional: [],
      derived: NONE,
      closed: NONE,
      dates: ['date'],
      lines: [],
      identity: 'owner',
      personFree: false,
      creatable: true,
    },
    named('Partner', { creatable: true }),
    named('Resource', {
      required: ['name', 'kind'],
      optional: ['location'],
      closed: { kind: RESOURCE_KINDS },
      creatable: true,
    }),
    {
      label: 'Fact',
      nameProperty: null,
      required: ['text', 'kind'],
      optional: [],
      derived: { evidence: 'evidence', statedOn: 'today' },
      closed: { kind: FACT_KINDS },
      dates: [],
      lines: ['text'],
      identity: 'none',
      personFree: true,
      creatable: true,
    },
  ],
  relations: [
    {
      type: 'COORDINATES',
      from: ['Member'],
      to: ['Pillar', 'Theme'],
      cardinality: { side: 'to', min: 0, max: 1, onExisting: 'replace' },
      proposable: true,
      why: 'Who coordinates a pillar or a theme: exactly one each, and a new coordinator replaces the old one in one proposal (A12).',
    },
    {
      type: 'MEMBER_OF',
      from: ['Member'],
      to: ['Theme', 'Team'],
      cardinality: null,
      proposable: true,
      why: 'Who belongs to which theme or team; the one relation the roster ingest is for.',
    },
    {
      type: 'WORKS_ON',
      from: ['Member', 'Team'],
      to: ['Project'],
      cardinality: null,
      proposable: true,
      why: 'Which people and teams work on a project.',
    },
    {
      type: 'IN_PILLAR',
      from: ['Project'],
      to: ['Pillar'],
      cardinality: { side: 'from', min: 0, max: 1, onExisting: 'replace' },
      proposable: true,
      why: 'The one objective a project serves, so it is counted once in every per-pillar view (A2).',
    },
    {
      type: 'PARTNERS_ON',
      from: ['Partner'],
      to: ['Project'],
      cardinality: null,
      proposable: true,
      why: 'Which external organisations a project is run with.',
    },
    {
      type: 'DELIVERS',
      from: ['Project'],
      to: ['Deliverable'],
      cardinality: { side: 'to', min: 1, max: 1, onExisting: 'refuse' },
      proposable: true,
      why: 'What a project produces; each deliverable belongs to exactly one project (LD-3).',
    },
    {
      type: 'HAS_DEADLINE',
      from: ['Project', 'Deliverable'],
      to: ['Deadline'],
      cardinality: { side: 'to', min: 1, max: 1, onExisting: 'refuse' },
      proposable: true,
      why: 'When a project or deliverable is due; a deadline answers no question without its owner (A4).',
    },
    {
      type: 'USES',
      from: ['Project'],
      to: ['Resource'],
      cardinality: null,
      proposable: true,
      why: 'The documents, systems, datasets and tools a project relies on; a resource may serve several.',
    },
    {
      type: 'ABOUT',
      from: ['Fact'],
      to: ABOUTABLE,
      cardinality: { side: 'from', min: 1, max: 1, onExisting: 'refuse' },
      proposable: true,
      why: 'What a fact is about: exactly one node, never a person and never another fact (A5).',
    },
    {
      type: 'PART_OF',
      from: ['Team'],
      to: ['Team'],
      cardinality: null,
      proposable: false,
      why: 'Team nesting as the directory records it; written by the ingest only, structural, and explicitly not a reporting line.',
    },
  ],
})

/**
 * The relation set, read off {@link ORG_ONTOLOGY}.
 *
 * **No reports-to, by decision.** No `REPORTS_TO` / `MANAGES` / `LEADS` edge
 * exists here, and `COORDINATES` is not a stand-in for one: it points at a
 * pillar or a theme, never at a person, so nothing in this ontology can express
 * authority of one individual over another. Graph's `/users` payload carries a
 * `manager` relationship; the ingest does not read it.
 */
export const RELATIONS: readonly OntologyRelation[] = ORG_ONTOLOGY.relations

export const RELATION_TYPES: readonly string[] = RELATIONS.map((r) => r.type)

/**
 * Required properties per label as stored, split into the two tiers the module
 * header explains, and the properties a uniqueness constraint is declared on.
 * Every class but `Member` carries a stable `id` (A7); every class keyed by
 * name carries `nameKey` (A1), so the database holds both axioms against every
 * writer. `Member` keeps its directory identity until the ingest gives it an
 * `id` (the ingest re-check, a data job).
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

const PROVENANCE = ['id', 'createdBy', 'createdAt'] as const

export const LABEL_SPECS: readonly LabelSpec[] = NODE_LABELS.map((label): LabelSpec => {
  if (label === 'Member') {
    return {
      label,
      hard: ['entraId', 'displayName', 'mail'],
      soft: ['department', 'jobTitle'],
      unique: ['entraId', 'mail'],
    }
  }
  const cls = ORG_ONTOLOGY.classes.find((c) => c.label === label)!
  const byName = cls.identity === 'nameKey'
  const stored = [...cls.required, ...Object.keys(cls.derived)]
  return {
    label,
    hard: [...PROVENANCE, ...stored, ...(byName ? ['nameKey'] : [])],
    soft: [],
    // A directory team keeps its entraId identity; a proposed one has none,
    // and a uniqueness constraint admits any number of absent values.
    unique: [...(label === 'Team' ? ['entraId'] : []), 'id', ...(byName ? ['nameKey'] : [])],
  }
})

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
 * relationship whose type is outside {@link RELATION_TYPES}, every
 * relationship of a declared type whose (start label, end label) pair is not
 * one {@link RELATIONS} declares for that type, and every `Member` missing a
 * hard property.
 *
 * The endpoint branch is separate from the type branch because a known type
 * between the wrong labels is drift the type check cannot see: a `USES` edge
 * between two nodes outside the ontology passes `type(r) IN $relationTypes`.
 * A node, or either end of a relationship, conforms when ANY one of its labels
 * does — the same reading the label branch uses for a node. The pairs come from
 * {@link conformanceParams}, read off the ontology's own relations, and are
 * never restated here.
 *
 * This exists because app-side validation binds only the callers that route
 * through it. `neo4j/graph-edit.server.ts` checks the canvas's edits against
 * the ontology, but a writer that routes through neither it nor the hook (a
 * script, a future tool) is bound by nothing here, so the drift is made
 * countable instead: run this after any such write, and see
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
    MATCH (a)-[r]->(b)
    WHERE type(r) IN $relationTypes
      AND NOT any(e IN $relationEndpoints
                  WHERE e.type = type(r) AND e.from IN labels(a) AND e.to IN labels(b))
    RETURN 'relation_endpoints' AS kind,
           [type(r),
            coalesce(reduce(s = head(labels(a)), l IN tail(labels(a)) | s + ':' + l), ''),
            coalesce(reduce(s = head(labels(b)), l IN tail(labels(b)) | s + ':' + l), '')]
             AS detail,
           count(*) AS count
    UNION ALL
    MATCH (n:Member)
    WHERE n.entraId IS NULL OR n.displayName IS NULL OR n.mail IS NULL
    RETURN 'member_missing_hard' AS kind, [] AS detail, count(*) AS count
  }
  WITH kind, detail, count WHERE count > 0
  RETURN kind, detail, count ORDER BY kind, count DESC
`

/** One (type, start label, end label) triple the ontology declares. */
export interface RelationEndpoint {
  type: string
  from: string
  to: string
}

/** Every endpoint pair {@link RELATIONS} declares, one triple per pair. */
export const RELATION_ENDPOINTS: readonly RelationEndpoint[] = RELATIONS.flatMap((r) =>
  r.from.flatMap((from) => r.to.map((to) => ({ type: r.type, from, to }))),
)

/** Parameters {@link NON_CONFORMING_CYPHER} expects. */
export const conformanceParams = (): {
  labels: string[]
  relationTypes: string[]
  relationEndpoints: RelationEndpoint[]
} => ({
  labels: [...NODE_LABELS],
  relationTypes: [...RELATION_TYPES],
  relationEndpoints: RELATION_ENDPOINTS.map((e) => ({ ...e })),
})
