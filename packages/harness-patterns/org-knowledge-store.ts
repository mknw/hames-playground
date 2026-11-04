/**
 * The organizational-knowledge graph store — the seam the hook reads the graph
 * through and writes an accepted assertion through
 * (`docs/plan/org-knowledge-hook.md`, "Acceptance and the write", slice 2).
 *
 * Two operations, both owned by the host:
 *
 * - {@link OrgGraphStore.snapshot} reads what a draft references: the nodes it
 *   names (by label and name key) or keys, every edge touching them, and the
 *   nodes at the other end — what the validator's resolution, owner matching
 *   and cardinality checks read.
 * - {@link OrgGraphStore.apply} writes ONE validated assertion in ONE
 *   transaction, after re-reading what the preview read:
 *     1. every node the preview resolved still exists and still holds the
 *        properties the preview read; every edge it would remove still exists;
 *        no new edge of a bounded relation has appeared on a node the
 *        assertion bounds — otherwise `stale`, and nothing is written;
 *     2. a node keyed by name MERGEs on `(label, nameKey)`, a node keyed under
 *        its owner merges under that owner, any other node is created; an
 *        existing node is addressed by its key;
 *     3. `id`, `createdBy` and `createdAt` are set when a node or edge is
 *        CREATED and never again (A7, A8); `lastEditedBy` / `lastEditedAt` are
 *        set only where a stored property actually changes;
 *     4. a replacement deletes the edges it removes in the same transaction.
 *   A retried assertion finds its nodes and edges and changes nothing (LD-14).
 *
 * This module holds the interface and {@link createMemoryOrgGraphStore}, the
 * in-memory adapter tests and evals run on. The Neo4j adapter is the host's.
 * Both satisfy one contract suite.
 */

import {
  classOf,
  nameKey,
  relationOf,
  type GraphOntology,
  type OntologyClass,
} from './org-knowledge-ontology'
import type {
  CheckedAssertion,
  CheckedNode,
  GraphSnapshot,
  SnapshotEdge,
  SnapshotNode,
} from './org-knowledge-validate.server'

/** What a draft references: names by label, and node keys. */
export interface OrgGraphRefs {
  readonly names: readonly { readonly label: string; readonly name: string }[]
  readonly keys: readonly string[]
}

/** Who accepted, and when (ISO timestamp). `userId` is an internal user id,
 *  never a name or an email (A8). */
export interface OrgActor {
  readonly userId: string
  readonly now: string
}

export type OrgApplyResult =
  | {
      readonly status: 'applied'
      /** The stored key of every node of the assertion, by draft ref. */
      readonly keys: Readonly<Record<string, string>>
    }
  | { readonly status: 'stale' }

export interface OrgGraphStore {
  snapshot(refs: OrgGraphRefs): Promise<GraphSnapshot>
  apply(assertion: CheckedAssertion, actor: OrgActor): Promise<OrgApplyResult>
}

/** The provenance properties no proposal may set: the write's own. */
export const PROVENANCE_PROPERTIES = [
  'id',
  'createdBy',
  'createdAt',
  'lastEditedBy',
  'lastEditedAt',
  'nameKey',
] as const

/** A stored node key for an `id`. Keys are prefixed so a key's kind is never
 *  guessed: `id:` for a node with a stable id, and whatever legacy prefix a
 *  host gives a node that has none (the Neo4j adapter: `entraId:` for a
 *  member, `element:` for anything else). */
export const idKey = (id: string): string => `id:${id}`

// ============================================================================
// Shared apply logic: the stale check, over any readable view of the graph
// ============================================================================

/** The read side `isStale` needs, so both adapters run the same check. */
export interface StaleView {
  node(key: string): SnapshotNode | undefined
  edges(type: string, side: 'from' | 'to', key: string): readonly SnapshotEdge[]
}

const sameEdge = (a: SnapshotEdge, b: SnapshotEdge): boolean =>
  a.type === b.type && a.from === b.from && a.to === b.to

/**
 * Whether what the preview read has changed underneath the assertion. Pure
 * over `view`, which the caller reads INSIDE its write transaction.
 */
export function isStale(
  assertion: CheckedAssertion,
  ontology: GraphOntology,
  view: StaleView,
): boolean {
  for (const n of assertion.nodes) {
    if (!n.existing) continue
    const now = view.node(n.existing.key)
    if (!now || now.label !== n.existing.label) return true
    for (const [prop, value] of Object.entries(n.existing.properties)) {
      if (now.properties[prop] !== value) return true
    }
  }
  const keyOfRef = new Map(assertion.nodes.map((n) => [n.element.ref, n.existing?.key]))
  for (const e of assertion.edges) {
    for (const removed of e.removes) {
      if (!view.edges(removed.type, 'from', removed.from).some((x) => sameEdge(x, removed))) {
        return true
      }
    }
    const card = relationOf(ontology, e.element.type)?.cardinality
    if (!card) continue
    const pinnedRef = card.side === 'from' ? e.element.from : e.element.to
    const otherRef = card.side === 'from' ? e.element.to : e.element.from
    const pinned = keyOfRef.get(pinnedRef)
    if (!pinned) continue
    const other = keyOfRef.get(otherRef)
    const current = view.edges(e.element.type, card.side, pinned)
    const unexpected = current.filter(
      (x) =>
        (card.side === 'from' ? x.to : x.from) !== other && !e.removes.some((r) => sameEdge(r, x)),
    )
    if (unexpected.length > 0) return true
  }
  return false
}

/** The properties a node is stored with, provenance excluded. */
export function storedProperties(cls: OntologyClass, n: CheckedNode): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(n.properties)) {
    if (!(PROVENANCE_PROPERTIES as readonly string[]).includes(k)) out[k] = v
  }
  if (cls.identity === 'nameKey' && cls.nameProperty && out[cls.nameProperty]) {
    out.nameKey = nameKey(out[cls.nameProperty])
  }
  return out
}

/** The properties an EXISTING node is updated with: its name and name key are
 *  its identity and stay as stored (a restatement in another case must not
 *  rename the node), everything else is as drafted. */
export function updatedProperties(cls: OntologyClass, n: CheckedNode): Record<string, string> {
  const out = storedProperties(cls, n)
  delete out.nameKey
  if (cls.nameProperty) delete out[cls.nameProperty]
  return out
}

// ============================================================================
// The in-memory adapter
// ============================================================================

interface MemNode {
  key: string
  label: string
  properties: Record<string, string>
}
interface MemEdge {
  type: string
  from: string
  to: string
  properties: Record<string, string>
}

export interface MemoryOrgGraph {
  readonly nodes: readonly MemNode[]
  readonly edges: readonly MemEdge[]
}

export interface MemoryOrgGraphStore extends OrgGraphStore {
  /** The whole graph, as copies — for graders and tests. */
  dump(): MemoryOrgGraph
  /** A write made outside the hook (another writer), for tests and evals. */
  setProperty(key: string, prop: string, value: string): void
  /** An edge added outside the hook (another writer), for tests and evals. */
  addEdge(type: string, from: string, to: string): void
}

/**
 * An in-memory {@link OrgGraphStore}. `seed` nodes keep the keys they are
 * given; nodes it creates get `id:<uuid>` keys. `newId` is injectable so a test
 * can name what will be minted.
 */
export function createMemoryOrgGraphStore(
  ontology: GraphOntology,
  seed: { nodes?: readonly SnapshotNode[]; edges?: readonly SnapshotEdge[] } = {},
  newId: () => string = () => crypto.randomUUID(),
): MemoryOrgGraphStore {
  let nodes: MemNode[] = (seed.nodes ?? []).map((n) => ({
    key: n.key,
    label: n.label,
    properties: { ...n.properties },
  }))
  let edges: MemEdge[] = (seed.edges ?? []).map((e) => ({ ...e, properties: {} }))

  const asSnapshotNode = (n: MemNode): SnapshotNode => ({
    key: n.key,
    label: n.label,
    properties: { ...n.properties },
  })
  const asSnapshotEdge = (e: MemEdge): SnapshotEdge => ({ type: e.type, from: e.from, to: e.to })

  return {
    async snapshot(refs) {
      const wanted = new Set<string>(refs.keys)
      for (const { label, name } of refs.names) {
        const cls = classOf(ontology, label)
        if (!cls?.nameProperty) continue
        const key = nameKey(name)
        for (const n of nodes) {
          const v = n.properties[cls.nameProperty]
          if (n.label === label && typeof v === 'string' && nameKey(v) === key) wanted.add(n.key)
        }
      }
      const touching = edges.filter((e) => wanted.has(e.from) || wanted.has(e.to))
      const around = new Set([...wanted, ...touching.flatMap((e) => [e.from, e.to])])
      return {
        nodes: nodes.filter((n) => around.has(n.key)).map(asSnapshotNode),
        edges: touching.map(asSnapshotEdge),
      }
    },

    async apply(assertion, actor) {
      // One transaction: work on copies, commit by swapping them in.
      const ns: MemNode[] = nodes.map((n) => ({ ...n, properties: { ...n.properties } }))
      let es: MemEdge[] = edges.map((e) => ({ ...e, properties: { ...e.properties } }))
      const view: StaleView = {
        node: (key) => {
          const n = ns.find((x) => x.key === key)
          return n ? asSnapshotNode(n) : undefined
        },
        edges: (type, side, key) =>
          es.filter((e) => e.type === type && e[side] === key).map(asSnapshotEdge),
      }
      if (isStale(assertion, ontology, view)) return { status: 'stale' }

      const created = (): Record<string, string> => ({
        id: newId(),
        createdBy: actor.userId,
        createdAt: actor.now,
      })
      const setChanged = (n: MemNode, props: Record<string, string>): void => {
        const changed = Object.entries(props).some(([k, v]) => n.properties[k] !== v)
        if (!changed) return
        Object.assign(n.properties, props)
        n.properties.lastEditedBy = actor.userId
        n.properties.lastEditedAt = actor.now
      }

      const keys: Record<string, string> = {}
      // Owner-identified nodes are placed after their owner is.
      const ordered = [...assertion.nodes].sort(
        (a, b) =>
          Number(classOf(ontology, a.element.label)?.identity === 'owner') -
          Number(classOf(ontology, b.element.label)?.identity === 'owner'),
      )
      for (const n of ordered) {
        const cls = classOf(ontology, n.element.label)!
        if (n.existing) {
          const target = ns.find((x) => x.key === n.existing!.key)!
          keys[n.element.ref] = target.key
          if (cls.creatable) setChanged(target, updatedProperties(cls, n))
          continue
        }
        const props = storedProperties(cls, n)
        let match: MemNode | undefined
        if (cls.identity === 'nameKey') {
          match = ns.find((x) => x.label === cls.label && x.properties.nameKey === props.nameKey)
        } else if (cls.identity === 'owner' && cls.nameProperty) {
          const owning = assertion.edges.find((e) => e.element.to === n.element.ref)
          const owner = owning ? keys[owning.element.from] : undefined
          const children = new Set(
            es.filter((e) => e.type === owning?.element.type && e.from === owner).map((e) => e.to),
          )
          match = ns.find(
            (x) =>
              x.label === cls.label &&
              children.has(x.key) &&
              x.properties[cls.nameProperty!] === props[cls.nameProperty!],
          )
        }
        if (match) {
          setChanged(match, updatedProperties(cls, n))
          keys[n.element.ref] = match.key
          continue
        }
        const provenance = created()
        const node: MemNode = {
          key: idKey(provenance.id),
          label: cls.label,
          properties: { ...props, ...provenance },
        }
        ns.push(node)
        keys[n.element.ref] = node.key
      }

      for (const e of assertion.edges) {
        es = es.filter((x) => !e.removes.some((r) => sameEdge(r, x)))
        const from = keys[e.element.from]
        const to = keys[e.element.to]
        const exists = es.some((x) => x.type === e.element.type && x.from === from && x.to === to)
        if (!exists) es.push({ type: e.element.type, from, to, properties: created() })
      }

      nodes = ns
      edges = es
      return { status: 'applied', keys }
    },

    setProperty(key, prop, value) {
      const node = nodes.find((x) => x.key === key)
      if (!node) throw new Error(`memory org graph: no node ${key}`)
      node.properties[prop] = value
    },

    addEdge(type, from, to) {
      edges.push({ type, from, to, properties: {} })
    },

    dump() {
      return {
        nodes: nodes.map((n) => ({ ...n, properties: { ...n.properties } })),
        edges: edges.map((e) => ({ ...e, properties: { ...e.properties } })),
      }
    },
  }
}
