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
