/**
 * Neo4j Graph Edit Ops (#226 C2) — identity-free by construction.
 *
 * Intent-shaped operations for a graph visualization UI's edit affordances
 * (create node, link nodes, edit a property). Replaces the deleted
 * `write-action.ts`, whose `executeCypherWrite(cypher, params)` was a
 * browser-reachable arbitrary-Cypher endpoint with no auth.
 *
 * Every operation:
 *  - is gated by the HOST's thin `'use server'` wrapper (per-module
 *    duplicated gate, SD-13) before it reaches this module — the ops
 *    themselves carry no identity;
 *  - owns its Cypher — the client sends intent, never query text;
 *  - passes all values as Cypher parameters;
 *  - validates identifiers (label / relationship type / property key), which
 *    cannot be parameters, against a strict charset allowlist before
 *    interpolating them backtick-quoted.
 *
 * The `'use server'` directive this module carried in the host app is
 * stripped by the package move (#225 PR-C2); `assertServerOnImport()` is the
 * load-time guard that replaces it.
 *
 * ## Every edit adheres to the ontology (org-knowledge slice 6, LD-16)
 * The owner's "any change to the graph must adhere to the ontology" answers
 * `docs/org-graph.md`'s open question, and it CHANGES this module's behaviour:
 * a label or relation type is admitted only when the host's ontology declares
 * it (it used to be any identifier of the right shape), a node is MERGEd on its
 * name key rather than CREATEd (so a repeated name is the same node), a member
 * or a pillar is never created here, a property is one its class declares, and
 * a bounded relation (one coordinator, one pillar) is refused rather than
 * doubled. Each write stamps `createdBy` / `createdAt` where it creates and
 * `lastEditedBy` / `lastEditedAt` where it changes a value.
 *
 * The `actor` an op takes is PROVENANCE ONLY: it is written as a parameter and
 * decides nothing. Authorization stays the host wrapper's gate (SD-13).
 */

import neo4j, { type ManagedTransaction } from 'neo4j-driver'
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import {
  canvasCreateRefusal,
  canvasLinkRefusal,
  classOf,
  nameKey,
  propertyRefusal,
  relationOf,
  type GraphOntology,
} from '@hames-ai/harness-patterns/org-knowledge-ontology'
import { getNeo4jDriver } from './client'

assertServerOnImport()

// Labels and relationship types cannot be Cypher parameters, so they are
// interpolated — only after the ontology has admitted them, and still checked
// against a charset that cannot terminate the backtick quoting (defence in
// depth: an ontology is host data).
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

function assertSafeIdentifier(kind: string, value: string): string {
  if (!SAFE_IDENTIFIER.test(value)) {
    throw new Error(`Invalid ${kind} ${JSON.stringify(value)}: must match ${SAFE_IDENTIFIER}`)
  }
  return value
}

/** Who made the edit, and when (ISO timestamp). Provenance only. */
export interface GraphEditActor {
  readonly userId: string
  readonly now: string
}

type Row = { get: (key: string) => unknown }

async function write<T>(fn: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
  const session = getNeo4jDriver().session({ defaultAccessMode: neo4j.session.WRITE })
  try {
    return await session.executeWrite(fn)
  } finally {
    await session.close()
  }
}

/** The single row a statement's final RETURN produces. */
function firstRow(result: { records: unknown[] }): Row {
  const record = result.records[0] as Row | undefined
  if (!record) throw new Error('Graph edit query returned no summary record')
  return record
}

/** The labels of the node with `nodeId`, or a refusal when none matches (#314). */
async function labelsOf(tx: ManagedTransaction, nodeId: string): Promise<string[]> {
  const res = await tx.run('MATCH (n) WHERE elementId(n) = $nodeId RETURN labels(n) AS labels', {
    nodeId,
  })
  if (res.records.length === 0) {
    throw new Error('Graph edit matched no graph node with that id — nothing was written')
  }
  return (firstRow(res).get('labels') as string[]) ?? []
}

/** Create a node of an ontology label, or merge onto the one of that name.
 *  Resolves with the node's Neo4j elementId: the canvas keys a fresh node by
 *  its user-typed name (#323 B1), so later edits and relations in the same
 *  session need the real id to target it with. */
export async function createGraphNode(
  ontology: GraphOntology,
  actor: GraphEditActor,
  label: string,
  name: string,
  description?: string,
): Promise<string> {
  const refusal = canvasCreateRefusal(ontology, label)
  if (refusal) throw new Error(`Graph edit refused: ${refusal}`)
  const cls = classOf(ontology, label)!
  const safeLabel = assertSafeIdentifier('label', label)
  const props: Record<string, string> = { [cls.nameProperty!]: name.trim() }
  if (description) props.description = description
  for (const [key, value] of Object.entries(props)) {
    const bad = propertyRefusal(cls, key, value)
    if (bad) throw new Error(`Graph edit refused: ${bad}`)
  }
  const update: Record<string, string> = { ...props }
  delete update[cls.nameProperty!]
  return write(async (tx) => {
    const res = await tx.run(
      `MERGE (n:\`${safeLabel}\` {nameKey: $nameKey}) ` +
        `ON CREATE SET n += $props, n.id = $id, n.createdBy = $actor, n.createdAt = $now ` +
        `WITH n, [k IN keys($update) WHERE n[k] IS NULL OR toString(n[k]) <> $update[k]] AS changed ` +
        `SET n += $update ` +
        `FOREACH (_ IN CASE WHEN size(changed) > 0 THEN [1] ELSE [] END | ` +
        `SET n.lastEditedBy = $actor, n.lastEditedAt = $now) ` +
        `RETURN elementId(n) AS elementId`,
      {
        nameKey: nameKey(name),
        props,
        update,
        id: crypto.randomUUID(),
        actor: actor.userId,
        now: actor.now,
      },
    )
    return String(firstRow(res).get('elementId'))
  })
}

/** Add a relation of an ontology type between two nodes matched by elementId.
 *  MERGE keeps a second click idempotent; a bounded relation that already has
 *  its one edge to another node is refused, never doubled. */
export async function linkGraphNodes(
  ontology: GraphOntology,
  actor: GraphEditActor,
  sourceId: string,
  targetId: string,
  relType: string,
): Promise<void> {
  const rel = relationOf(ontology, relType)
  const vocabulary = canvasLinkRefusal(ontology, relType, rel?.from ?? [], rel?.to ?? [])
  if (vocabulary) throw new Error(`Graph edit refused: ${vocabulary}`)
  const safeType = assertSafeIdentifier('relationship type', relType)
  await write(async (tx) => {
    const from = await labelsOf(tx, sourceId)
    const to = await labelsOf(tx, targetId)
    const refusal = canvasLinkRefusal(ontology, relType, from, to)
    if (refusal) throw new Error(`Graph edit refused: ${refusal}`)
    const card = rel!.cardinality
    if (card) {
      const pinned = card.side === 'from' ? sourceId : targetId
      const other = card.side === 'from' ? targetId : sourceId
      const pattern =
        card.side === 'from' ? `(p)-[r:\`${safeType}\`]->(o)` : `(o)-[r:\`${safeType}\`]->(p)`
      const taken = await tx.run(
        `MATCH ${pattern} WHERE elementId(p) = $pinned AND elementId(o) <> $other ` +
          `RETURN count(r) AS taken`,
        { pinned, other },
      )
      if (Number(firstRow(taken).get('taken')) >= card.max) {
        throw new Error(
          `Graph edit refused: ${relType} allows ${card.max} per node, and that node has one; ` +
            'a replacement is proposed in a conversation',
        )
      }
    }
    await tx.run(
      `MATCH (a), (b) WHERE elementId(a) = $sourceId AND elementId(b) = $targetId ` +
        `MERGE (a)-[r:\`${safeType}\`]->(b) ` +
        `ON CREATE SET r.id = $id, r.createdBy = $actor, r.createdAt = $now`,
      { sourceId, targetId, id: crypto.randomUUID(), actor: actor.userId, now: actor.now },
    )
  })
}

/** Set one declared property on the node with the given elementId. */
export async function setGraphNodeProperty(
  ontology: GraphOntology,
  actor: GraphEditActor,
  nodeId: string,
  key: string,
  value: string,
): Promise<void> {
  assertSafeIdentifier('property key', key)
  await write(async (tx) => {
    const labels = await labelsOf(tx, nodeId)
    const cls = labels.map((l) => classOf(ontology, l)).find((c) => c !== undefined)
    if (!cls) throw new Error('Graph edit refused: that node is not of an ontology label')
    if (!cls.creatable)
      throw new Error(`Graph edit refused: ${cls.label} nodes are not edited here`)
    const bad = propertyRefusal(cls, key, value)
    if (bad) throw new Error(`Graph edit refused: ${bad}`)
    const props: Record<string, string> = { [key]: value }
    if (key === cls.nameProperty && cls.identity === 'nameKey') props.nameKey = nameKey(value)
    await tx.run(
      `MATCH (n) WHERE elementId(n) = $nodeId ` +
        `WITH n, [k IN keys($props) WHERE n[k] IS NULL OR toString(n[k]) <> $props[k]] AS changed ` +
        `SET n += $props ` +
        `FOREACH (_ IN CASE WHEN size(changed) > 0 THEN [1] ELSE [] END | ` +
        `SET n.lastEditedBy = $actor, n.lastEditedAt = $now)`,
      { nodeId, props, actor: actor.userId, now: actor.now },
    )
  })
}
