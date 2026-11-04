/**
 * The Neo4j adapter of the organizational-knowledge graph store
 * (`@hames-ai/harness-patterns/org-knowledge-store`, slice 2 of
 * `docs/plan/org-knowledge-hook.md`). Server only; it is NOT a `'use server'`
 * module, so nothing here is browser-reachable.
 *
 * The write path is the app's, never an agent's: agents stay read-only against
 * Neo4j (`write_neo4j_cypher` is withheld), and this module is reached only
 * from an accepted proposal.
 *
 * ## Labels, types and properties in the Cypher
 * A label or relation type cannot be a Cypher parameter, so it is interpolated —
 * ONLY through {@link L} and {@link T}, which return it backtick-quoted after
 * checking it is a member of the ontology's own sets, and throw otherwise. A
 * property name is never interpolated: it is read as `n[$prop]`. Every value
 * is a parameter. `org-graph-store.test.ts` scans this file so that no other
 * interpolation can enter a statement.
 *
 * ## Keys
 * A node's key is `id:<id>` when it has a stable id, `entraId:<entraId>` for a
 * member the ingest has not yet given one, and `element:<elementId>` for any
 * other legacy node. {@link KEY} computes it in Cypher, so the snapshot and the
 * write agree on one spelling.
 */
import neo4j, { type Driver, type ManagedTransaction } from 'neo4j-driver'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import {
  classOf,
  hasNearKey,
  nameKey,
  nearChecked,
  nearNameKey,
  relationOf,
  type GraphOntology,
} from '@hames-ai/harness-patterns/org-knowledge-ontology'
import {
  isStale,
  newNodeNames,
  OrgSnapshotIncompleteError,
  storedProperties,
  updatedProperties,
  type OrgGraphStore,
  type StaleView,
} from '@hames-ai/harness-patterns/org-knowledge-store'
import type {
  CheckedAssertion,
  GraphSnapshot,
  SnapshotEdge,
  SnapshotNode,
} from '@hames-ai/harness-patterns/org-knowledge-validate.server'

assertServerOnImport()

/** Most rows one snapshot read returns. A draft names a handful of nodes; this
 *  bounds a legacy label with no `nameKey`, whose names are compared here. */
export const SNAPSHOT_ROW_LIMIT = 1000

/** Most nodes of one label the near-duplicate scan reads (V11, LD-24). The
 *  near key folds accents, which Cypher cannot, so the scan reads every name
 *  of the label and compares here. A label larger than this cannot be proven
 *  free of a near-duplicate, so the snapshot THROWS (the hook stops with
 *  `graph-read-error` and proposes nothing) rather than return a partial
 *  view: the owner's "do not duplicate nodes" makes this fail closed. */
export const NEAR_SCAN_LIMIT = 10_000

// ----------------------------------------------------------------------------
// The only interpolations
// ----------------------------------------------------------------------------

function quote(identifier: string): string {
  return '`' + identifier.replace(/`/g, '``') + '`'
}

/** A label of the ontology, backtick-quoted; anything else throws. */
function L(ontology: GraphOntology, label: string): string {
  if (!classOf(ontology, label))
    throw new Error(`org-graph store: ${label} is not an ontology label`)
  return quote(label)
}

/** A relation type of the ontology, backtick-quoted; anything else throws. */
function T(ontology: GraphOntology, type: string): string {
  if (!relationOf(ontology, type))
    throw new Error(`org-graph store: ${type} is not an ontology relation`)
  return quote(type)
}

/** The key of the node bound to the literal alias `a`, in Cypher. */
function KEY(a: 'n' | 'm' | 's' | 'e' | 'a' | 'b' | 'o' | 'd'): string {
  return (
    `CASE WHEN ${a}.id IS NOT NULL THEN 'id:' + ${a}.id ` +
    `WHEN ${a}:Member AND ${a}.entraId IS NOT NULL THEN 'entraId:' + ${a}.entraId ` +
    `ELSE 'element:' + elementId(${a}) END`
  )
}

// ----------------------------------------------------------------------------
// Reading
// ----------------------------------------------------------------------------

type Row = { get: (k: string) => unknown }
type Runner = Pick<ManagedTransaction, 'run'>

const asString = (v: unknown): string =>
  typeof v === 'string' ? v : v === null || v === undefined ? '' : String(v)

function propsOf(node: unknown): Record<string, string> {
  const raw = (node as { properties?: Record<string, unknown> } | null)?.properties ?? {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(raw)) out[k] = asString(v)
  return out
}

function labelOf(node: unknown, ontology: GraphOntology): string {
  const labels = (node as { labels?: string[] } | null)?.labels ?? []
  return labels.find((l) => classOf(ontology, l)) ?? labels[0] ?? ''
}

async function readSnapshot(
  tx: Runner,
  ontology: GraphOntology,
  names: readonly { label: string; name: string }[],
  keys: readonly string[],
): Promise<GraphSnapshot> {
  const found = new Map<string, SnapshotNode>()
  const add = (key: string, node: unknown): void => {
    if (!found.has(key)) {
      found.set(key, { key, label: labelOf(node, ontology), properties: propsOf(node) })
    }
  }

  const byLabel = new Map<string, Set<string>>()
  for (const { label, name } of names) {
    const cls = classOf(ontology, label)
    if (!cls?.nameProperty) continue
    const set = byLabel.get(label) ?? new Set<string>()
    set.add(nameKey(name))
    byLabel.set(label, set)
  }
  // V11: every node of the label whose near key equals a requested name's.
  const nearKeys: string[] = []
  const nearByLabel = new Map<string, Set<string>>()
  for (const { label, name } of names) {
    const cls = classOf(ontology, label)
    // A class the hook may not create is never scanned (LD-24), and an empty
    // near key matches nothing.
    if (!cls || !nearChecked(cls)) continue
    const near = nearNameKey(name, label)
    if (!hasNearKey(near)) continue
    const set = nearByLabel.get(label) ?? new Set<string>()
    set.add(near)
    nearByLabel.set(label, set)
  }
  for (const [label, near] of nearByLabel) {
    const cls = classOf(ontology, label)!
    const res = await tx.run(
      `MATCH (n:${L(ontology, label)}) RETURN n[$prop] AS name, ${KEY('n')} AS key LIMIT $limit`,
      { prop: cls.nameProperty, limit: neo4j.int(NEAR_SCAN_LIMIT + 1) },
    )
    const rows = res.records as unknown as Row[]
    if (rows.length > NEAR_SCAN_LIMIT) {
      throw new OrgSnapshotIncompleteError(
        'org graph snapshot: more than ' +
          String(NEAR_SCAN_LIMIT) +
          ' nodes of one label; the near-duplicate check cannot be complete',
      )
    }
    for (const r of rows) {
      const v = r.get('name')
      if (typeof v === 'string' && near.has(nearNameKey(v, label))) {
        nearKeys.push(asString(r.get('key')))
      }
    }
  }

  for (const [label, wanted] of byLabel) {
    const cls = classOf(ontology, label)!
    const res = await tx.run(
      `MATCH (n:${L(ontology, label)}) WHERE n.nameKey IN $keys OR n.nameKey IS NULL ` +
        `RETURN n, ${KEY('n')} AS key LIMIT $limit`,
      { keys: [...wanted], limit: neo4j.int(SNAPSHOT_ROW_LIMIT) },
    )
    for (const r of res.records as unknown as Row[]) {
      const node = r.get('n')
      const v = propsOf(node)[cls.nameProperty!]
      if (v && wanted.has(nameKey(v))) add(asString(r.get('key')), node)
    }
  }
  const byKey = [...new Set([...keys, ...nearKeys])]
  if (byKey.length > 0) {
    const res = await tx.run(`MATCH (n) WHERE ${KEY('n')} IN $keys RETURN n, ${KEY('n')} AS key`, {
      keys: byKey,
    })
    for (const r of res.records as unknown as Row[]) add(asString(r.get('key')), r.get('n'))
  }

  const edges: SnapshotEdge[] = []
  const anchors = [...found.keys()]
  if (anchors.length > 0) {
    const res = await tx.run(
      `MATCH (n)-[r]-(m) WHERE ${KEY('n')} IN $keys ` +
        `WITH DISTINCT r, startNode(r) AS s, endNode(r) AS e, m ` +
        `RETURN type(r) AS type, ${KEY('s')} AS from, ${KEY('e')} AS to, m, ${KEY('m')} AS mkey ` +
        `LIMIT $limit`,
      { keys: anchors, limit: neo4j.int(SNAPSHOT_ROW_LIMIT) },
    )
    const seen = new Set<string>()
    for (const r of res.records as unknown as Row[]) {
      const e = {
        type: asString(r.get('type')),
        from: asString(r.get('from')),
        to: asString(r.get('to')),
      }
      const id = [e.type, e.from, e.to].join('|')
      if (!seen.has(id)) {
        seen.add(id)
        edges.push(e)
      }
      add(asString(r.get('mkey')), r.get('m'))
    }
  }
  return { nodes: [...found.values()], edges }
}

function viewOf(snapshot: GraphSnapshot): StaleView {
  return {
    node: (key) => snapshot.nodes.find((n) => n.key === key),
    edges: (type, side, key) => snapshot.edges.filter((e) => e.type === type && e[side] === key),
    nodesOf: (label) => snapshot.nodes.filter((n) => n.label === label),
  }
}

// ----------------------------------------------------------------------------
// Writing
// ----------------------------------------------------------------------------

export interface Neo4jOrgGraphStoreOptions {
  readonly ontology: GraphOntology
  /** The driver, read per call (the app passes `getNeo4jDriver`). */
  readonly driver: () => Driver
  readonly newId?: () => string
}

export function createNeo4jOrgGraphStore(opts: Neo4jOrgGraphStoreOptions): OrgGraphStore {
  const { ontology } = opts
  const newId = opts.newId ?? (() => crypto.randomUUID())

  return {
    async snapshot(refs) {
      const session = opts.driver().session({ defaultAccessMode: neo4j.session.READ })
      try {
        return await session.executeRead((tx) => readSnapshot(tx, ontology, refs.names, refs.keys))
      } finally {
        await session.close()
      }
    },

    async apply(assertion, actor) {
      const session = opts.driver().session({ defaultAccessMode: neo4j.session.WRITE })
      try {
        return await session.executeWrite((tx) => applyIn(tx, assertion, actor))
      } finally {
        await session.close()
      }
    },
  }

  async function applyIn(
    tx: Runner,
    assertion: CheckedAssertion,
    actor: { userId: string; now: string },
  ) {
    // 1. Re-read, inside this transaction, everything the preview read.
    const watched = new Set<string>()
    for (const n of assertion.nodes) if (n.existing) watched.add(n.existing.key)
    for (const e of assertion.edges) for (const r of e.removes) watched.add(r.from)
    // Each new name-keyed node's name too, so the re-read holds any
    // near-duplicate written since the preview (LD-24): `isStale` refuses it.
    const now = await readSnapshot(tx, ontology, newNodeNames(assertion, ontology), [...watched])
    if (isStale(assertion, ontology, viewOf(now))) return { status: 'stale' as const }

    const keys: Record<string, string> = {}
    const base = { actor: actor.userId, now: actor.now }

    // 2. Nodes. Owner-identified nodes go after their owner.
    const ordered = [...assertion.nodes].sort(
      (a, b) =>
        Number(classOf(ontology, a.element.label)?.identity === 'owner') -
        Number(classOf(ontology, b.element.label)?.identity === 'owner'),
    )
    for (const n of ordered) {
      const cls = classOf(ontology, n.element.label)!
      if (n.existing) {
        keys[n.element.ref] = n.existing.key
        if (!cls.creatable) continue
        await tx.run(
          `MATCH (n) WHERE ${KEY('n')} = $key ` +
            `WITH n, [k IN keys($props) WHERE n[k] IS NULL OR toString(n[k]) <> $props[k]] AS changed ` +
            `SET n += $props ` +
            `FOREACH (_ IN CASE WHEN size(changed) > 0 THEN [1] ELSE [] END | ` +
            `SET n.lastEditedBy = $actor, n.lastEditedAt = $now)`,
          { ...base, key: n.existing.key, props: updatedProperties(cls, n) },
        )
        continue
      }
      const props = storedProperties(cls, n)
      if (cls.identity === 'nameKey') {
        const res = await tx.run(
          `MERGE (n:${L(ontology, cls.label)} {nameKey: $nameKey}) ` +
            `ON CREATE SET n += $props, n.id = $id, n.createdBy = $actor, n.createdAt = $now ` +
            `WITH n, [k IN keys($update) WHERE n[k] IS NULL OR toString(n[k]) <> $update[k]] AS changed ` +
            `SET n += $update ` +
            `FOREACH (_ IN CASE WHEN size(changed) > 0 THEN [1] ELSE [] END | ` +
            `SET n.lastEditedBy = $actor, n.lastEditedAt = $now) ` +
            `RETURN ${KEY('n')} AS key`,
          {
            ...base,
            nameKey: props.nameKey,
            props,
            update: updatedProperties(cls, n),
            id: newId(),
          },
        )
        keys[n.element.ref] = asString((res.records[0] as unknown as Row).get('key'))
        continue
      }
      if (cls.identity === 'owner' && cls.nameProperty) {
        const owning = assertion.edges.find((e) => e.element.to === n.element.ref)
        if (!owning) throw new Error(`org-graph store: ${cls.label} has no owner in its assertion`)
        const ownerKey = keys[owning.element.from]
        const found = await tx.run(
          `MATCH (o)-[:${T(ontology, owning.element.type)}]->(d:${L(ontology, cls.label)}) ` +
            `WHERE ${KEY('o')} = $owner AND d[$nameProp] = $name RETURN ${KEY('d')} AS key LIMIT 1`,
          { owner: ownerKey, nameProp: cls.nameProperty, name: props[cls.nameProperty] },
        )
        if (found.records.length > 0) {
          const key = asString((found.records[0] as unknown as Row).get('key'))
          await tx.run(
            `MATCH (d) WHERE ${KEY('d')} = $key ` +
              `WITH d, [k IN keys($props) WHERE d[k] IS NULL OR toString(d[k]) <> $props[k]] AS changed ` +
              `SET d += $props ` +
              `FOREACH (_ IN CASE WHEN size(changed) > 0 THEN [1] ELSE [] END | ` +
              `SET d.lastEditedBy = $actor, d.lastEditedAt = $now)`,
            { ...base, key, props: updatedProperties(cls, n) },
          )
          keys[n.element.ref] = key
          continue
        }
      }
      const res = await tx.run(
        `CREATE (n:${L(ontology, cls.label)}) ` +
          `SET n += $props, n.id = $id, n.createdBy = $actor, n.createdAt = $now ` +
          `RETURN ${KEY('n')} AS key`,
        { ...base, props, id: newId() },
      )
      keys[n.element.ref] = asString((res.records[0] as unknown as Row).get('key'))
    }

    // 3. Edges: the replaced ones go, the new ones merge.
    for (const e of assertion.edges) {
      for (const r of e.removes) {
        await tx.run(
          `MATCH (a)-[r:${T(ontology, r.type)}]->(b) WHERE ${KEY('a')} = $from AND ${KEY('b')} = $to DELETE r`,
          { from: r.from, to: r.to },
        )
      }
      await tx.run(
        `MATCH (a) WHERE ${KEY('a')} = $from MATCH (b) WHERE ${KEY('b')} = $to ` +
          `MERGE (a)-[r:${T(ontology, e.element.type)}]->(b) ` +
          `ON CREATE SET r.id = $id, r.createdBy = $actor, r.createdAt = $now`,
        { ...base, from: keys[e.element.from], to: keys[e.element.to], id: newId() },
      )
    }
    return { status: 'applied' as const, keys }
  }
}
