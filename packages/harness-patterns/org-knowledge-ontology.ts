/**
 * A graph ontology as data — the vocabulary the organizational-knowledge hook
 * checks every proposed node, property and edge against
 * (`docs/plan/org-knowledge-hook.md`, slice 1).
 *
 * Core carries the SHAPE of an ontology and the rules that read it; it names
 * no class. The host declares its own classes and relations through
 * {@link defineOntology}, which refuses a malformed declaration at module load
 * (an endpoint label nobody declared, a relation with no cardinality, a
 * duplicate type), so a host ontology cannot read like a contract and be one
 * entry short of one.
 *
 * Pure and I/O-free, and safe to import from client code: the canvas reads the
 * same {@link nameKey} the validator and the write key on.
 */

/** How a class is told apart from its siblings, which is what "the same node"
 *  means when a proposal repeats one (axiom A1).
 *  - `nameKey`: one node per {@link nameKey} of its name property, per label.
 *  - `owner`: one node per name under the node owning it (a deadline's label
 *    under its project or deliverable).
 *  - `none`: never matched; every proposal is a new node (a fact). */
export type OntologyIdentity = 'nameKey' | 'owner' | 'none'

/** Where a derived property's value comes from. */
export type DerivedSource = 'evidence' | 'today'

export interface OntologyClass {
  readonly label: string
  /** The property a person names the node by (`name`, `displayName`, …).
   *  `null` for a class nobody names (a fact). */
  readonly nameProperty: string | null
  /** Properties a proposal must give for a NEW node of this class. */
  readonly required: readonly string[]
  /** Properties a proposal may give besides the required ones. */
  readonly optional: readonly string[]
  /** Properties the hook fills itself and a proposal may not draft, each with
   *  its source: the element's `evidence` span, or the day it was said. */
  readonly derived: Readonly<Record<string, DerivedSource>>
  /** Properties whose value comes from a closed set, with that set. Their
   *  values are vocabulary, so value closure (V4) does not apply to them. */
  readonly closed: Readonly<Record<string, readonly string[]>>
  /** Properties holding an ISO 8601 day (`YYYY-MM-DD`). */
  readonly dates: readonly string[]
  /** Properties holding one line of at most {@link MAX_TEXT_CHARS}. */
  readonly lines: readonly string[]
  readonly identity: OntologyIdentity
  /** Whether the node's one-line text properties and its evidence must name no
   *  person in the host's roster (V9) — a fact is never about a person. */
  readonly personFree: boolean
  /** Whether a proposal may create a node of this class (V1). A class that may
   *  not is linked to only, and must resolve to exactly one existing node. */
  readonly creatable: boolean
}

/** At most `max` edges of a type on one node, counted on `side` — the
 *  `from` end (a project's one pillar) or the `to` end (a pillar's one
 *  coordinator). `min` binds only a NEW node on that side (a new deliverable
 *  must arrive with its project); an existing node already has what it has.
 *  `onExisting` says what a proposal meeting an existing edge to a DIFFERENT
 *  node does: `replace` it (shown to the person, A12) or be `refuse`d. */
export interface Cardinality {
  readonly side: 'from' | 'to'
  readonly min: 0 | 1
  readonly max: 1
  readonly onExisting: 'replace' | 'refuse'
}

export interface OntologyRelation {
  readonly type: string
  readonly from: readonly string[]
  readonly to: readonly string[]
  /** `null` is the explicit "any number" — required, so a relation cannot be
   *  declared without someone deciding its cardinality. */
  readonly cardinality: Cardinality | null
  /** Whether a proposal may add one (V1). `false` for an edge only a
   *  directory ingest writes. */
  readonly proposable: boolean
  /** One line on why the relation exists. */
  readonly why: string
}

export interface GraphOntology {
  readonly classes: readonly OntologyClass[]
  readonly relations: readonly OntologyRelation[]
}

/** Longest one-line text property, in characters (a fact's `text`). */
export const MAX_TEXT_CHARS = 280

/**
 * Check a declaration and return it. Throws on:
 * - a duplicate label or relation type;
 * - a relation endpoint naming no declared class;
 * - a relation whose `cardinality` is absent (`undefined`): "any number" is
 *   written as `null`, never left out;
 * - a class property listed in two of required / optional / derived, or a
 *   closed, date or line property outside them;
 * - a creatable class with no way to be told apart from a twin (`identity`
 *   `nameKey` without a name property).
 */
export function defineOntology(spec: GraphOntology): GraphOntology {
  const labels = new Set<string>()
  for (const c of spec.classes) {
    if (labels.has(c.label)) throw new Error(`ontology: duplicate class ${c.label}`)
    labels.add(c.label)
    const lists = [c.required, c.optional, Object.keys(c.derived)]
    const all = lists.flat()
    if (new Set(all).size !== all.length) {
      throw new Error(`ontology: ${c.label} lists a property twice`)
    }
    for (const p of [...Object.keys(c.closed), ...c.dates, ...c.lines]) {
      if (!all.includes(p)) throw new Error(`ontology: ${c.label}.${p} is typed but not declared`)
    }
    if (c.identity === 'nameKey' && c.nameProperty === null) {
      throw new Error(`ontology: ${c.label} is keyed by name but has no name property`)
    }
  }
  const types = new Set<string>()
  for (const r of spec.relations) {
    if (types.has(r.type)) throw new Error(`ontology: duplicate relation ${r.type}`)
    types.add(r.type)
    if (r.cardinality === undefined) {
      throw new Error(`ontology: relation ${r.type} has no cardinality (use null for any number)`)
    }
    for (const label of [...r.from, ...r.to]) {
      if (!labels.has(label)) throw new Error(`ontology: ${r.type} names undeclared class ${label}`)
    }
  }
  return spec
}

export function classOf(ontology: GraphOntology, label: string): OntologyClass | undefined {
  return ontology.classes.find((c) => c.label === label)
}

export function relationOf(ontology: GraphOntology, type: string): OntologyRelation | undefined {
  return ontology.relations.find((r) => r.type === type)
}

/**
 * The key two names compare equal under (axiom A1): NFKC (so full-width and
 * compatibility forms fold), lower case, and every run of whitespace collapsed
 * to one space, trimmed. A node of a `nameKey` class stores this beside its
 * name, and a uniqueness constraint on it makes the axiom the database's.
 */
export function nameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
}

/** `text` under {@link nameKey}, split on runs of non-alphanumeric characters
 *  — the token sequence value closure (V4) compares. */
export function valueTokens(text: string): string[] {
  return nameKey(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0)
}

// ============================================================================
// One property, and what a hand edit may do
// ============================================================================

const LINE_BREAK = /[\r\n\u2028\u2029\u0085]/u
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/

/** A real calendar day written `YYYY-MM-DD`. */
export function isIsoDay(value: string): boolean {
  const m = ISO_DAY.exec(value)
  if (!m) return false
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const date = new Date(Date.UTC(y, mo - 1, d))
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d
}

/**
 * Why `key = value` may not be stored on a node of `cls`, or `null`. The one
 * property rule the validator (V2) and a hand edit on the canvas share: the
 * key is one the class declares as required or optional (never derived, never
 * provenance), the value is a non-empty string, a closed-set value is in its
 * set, a day is an ISO day, and a one-line text is one line of at most
 * {@link MAX_TEXT_CHARS}.
 */
export function propertyRefusal(cls: OntologyClass, key: string, value: unknown): string | null {
  if (![...cls.required, ...cls.optional].includes(key)) {
    return `${cls.label} has no property ${key} (it has ${[...cls.required, ...cls.optional].join(', ')})`
  }
  if (typeof value !== 'string' || value.trim() === '') return `${cls.label}.${key} needs a value`
  const closed = cls.closed[key]
  if (closed && !closed.includes(value)) return `${cls.label}.${key} is one of ${closed.join(', ')}`
  if (cls.dates.includes(key) && !isIsoDay(value)) return `${cls.label}.${key} is a day, YYYY-MM-DD`
  if (
    cls.lines.includes(key) &&
    (LINE_BREAK.test(value) || Array.from(value).length > MAX_TEXT_CHARS)
  ) {
    return `${cls.label}.${key} is one line of at most ${MAX_TEXT_CHARS} characters`
  }
  return null
}

/** The labels a person may create by hand on the canvas: creatable, keyed by
 *  name, needing nothing but a name, and owed no edge at creation (a
 *  deliverable needs its project, so it is proposed in a conversation). */
export function canvasCreatableLabels(ontology: GraphOntology): string[] {
  return ontology.classes
    .filter((c) => canvasCreateRefusal(ontology, c.label) === null)
    .map((c) => c.label)
}

/** Why a node of `label` may not be created by hand on the canvas, or `null`. */
export function canvasCreateRefusal(ontology: GraphOntology, label: string): string | null {
  const cls = classOf(ontology, label)
  const allowed = () =>
    ontology.classes
      .filter((c) => c.label !== label && canvasCreateRefusal(ontology, c.label) === null)
      .map((c) => c.label)
  if (!cls)
    return `${label} is not a label of the ontology (create one of: ${allowed().join(', ')})`
  if (!cls.creatable) return `${label} nodes are linked to, never created here`
  const needsMore =
    cls.identity !== 'nameKey' ||
    cls.required.some((p) => p !== cls.nameProperty) ||
    ontology.relations.some(
      (r) =>
        r.cardinality?.min === 1 && (r.cardinality.side === 'from' ? r.from : r.to).includes(label),
    )
  if (needsMore) return `a ${label} needs more than a name; state it in a conversation instead`
  return null
}

/** Why an edge of `type` between nodes carrying `fromLabels` and `toLabels` may
 *  not be added by hand, or `null`. Cardinality needs the graph, so the caller
 *  checks it; this is the vocabulary half. */
export function canvasLinkRefusal(
  ontology: GraphOntology,
  type: string,
  fromLabels: readonly string[],
  toLabels: readonly string[],
): string | null {
  const rel = relationOf(ontology, type)
  if (!rel || !rel.proposable) {
    const allowed = ontology.relations.filter((r) => r.proposable).map((r) => r.type)
    return `${type} is not a relation of the ontology (use one of: ${allowed.join(', ')})`
  }
  if (!fromLabels.some((l) => rel.from.includes(l)) || !toLabels.some((l) => rel.to.includes(l))) {
    return `${type} joins ${rel.from.join(' or ')} to ${rel.to.join(' or ')}`
  }
  return null
}
