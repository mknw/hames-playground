/**
 * What the Org.graph tab draws after an acceptance (`docs/plan/org-knowledge-hook.md`,
 * "The Org.graph tab", slice 5): the accepted elements and their one-hop
 * neighbourhood, read through the store seam (`snapshot` by key), so the
 * in-memory store serves it in tests exactly as the Neo4j adapter does live.
 *
 * - **One key per node.** An element's id is the node's stable `id` when it has
 *   one, the key the graph extractor gives the same node from an agent's read,
 *   so the merge draws it once. Edges use the extractor's triple id.
 * - **`added`** marks what this acceptance added or changed: a node whose
 *   verdict is `new` or `updates`, an edge whose verdict is `new`. A node it only
 *   reinforced is drawn, unmarked.
 * - **Who added it** (LD-18): `createdBy` is an internal user id; each node that
 *   carries one gets `createdByName`, the user's display name resolved here, or
 *   "former user" when the id names nobody. The raw id never needs to reach the
 *   screen.
 * - The neighbourhood is capped at {@link ACCEPTED_EDGE_LIMIT} edges, the
 *   enricher's row cap.
 *
 * Server only: it reads the graph and the users table.
 */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import type { OrgGraphStore } from '@hames-ai/harness-patterns/org-knowledge-store'
import type { OrgProposalPayload } from '@hames-ai/harness-patterns/org-knowledge-hook.server'
import type { SnapshotNode } from '@hames-ai/harness-patterns/org-knowledge-validate.server'
import type { GraphElement } from '@hames-ai/agents'

assertServerOnImport()

/** The enricher's neighbourhood row cap (`neo4j-enricher.server.ts`). */
export const ACCEPTED_EDGE_LIMIT = 100

/** What a node is called on the canvas. */
function nameOf(n: SnapshotNode): string {
  const p = n.properties
  return p.name ?? p.displayName ?? p.label ?? p.text ?? p.id ?? n.key
}

/** The canvas id of a stored node: its `id` property, else its name, else its key. */
function elementId(n: SnapshotNode): string {
  const id = n.properties.id
  return typeof id === 'string' && id !== '' ? id : nameOf(n)
}

export interface AcceptedGraphInput {
  readonly store: Pick<OrgGraphStore, 'snapshot'>
  readonly payload: OrgProposalPayload
  /** The assertion flags the person selected (`a<index>`). */
  readonly selected: readonly string[]
  /** The stored key of every node written, by draft ref (`applyOrgProposal`). */
  readonly keys: Readonly<Record<string, string>>
  /** A user id → display name; null when no such user exists. */
  readonly displayName: (userId: string) => Promise<string | null>
}

export async function acceptedGraph(input: AcceptedGraphInput): Promise<GraphElement[]> {
  const chosen = input.payload.assertions.filter((a) => input.selected.includes(`a${a.index}`))
  const addedNodes = new Set<string>()
  const addedEdges = new Set<string>()
  for (const a of chosen) {
    for (const n of a.nodes) {
      const key = input.keys[n.element.ref]
      if (key && n.verdict !== 'reinforces') addedNodes.add(key)
    }
    for (const e of a.edges) {
      const from = input.keys[e.element.from]
      const to = input.keys[e.element.to]
      if (from && to && e.verdict === 'new') addedEdges.add([e.element.type, from, to].join('|'))
    }
  }
  const anchors = [...new Set(Object.values(input.keys))]
  if (anchors.length === 0) return []

  const snap = await input.store.snapshot({ names: [], keys: anchors })
  const edges = snap.edges.slice(0, ACCEPTED_EDGE_LIMIT)
  const drawn = new Set([...anchors, ...edges.flatMap((e) => [e.from, e.to])])
  const nodes = snap.nodes.filter((n) => drawn.has(n.key))
  const byKey = new Map(nodes.map((n) => [n.key, n]))

  const names = new Map<string, string>()
  for (const id of new Set(nodes.map((n) => n.properties.createdBy).filter(Boolean))) {
    names.set(id, (await input.displayName(id).catch(() => null)) ?? 'former user')
  }

  const out: GraphElement[] = nodes.map((n) => {
    const by = n.properties.createdBy
    return {
      group: 'nodes',
      data: {
        ...n.properties,
        id: elementId(n),
        label: nameOf(n),
        type: n.label,
        kind: 'node',
        ...(by ? { createdByName: names.get(by) } : {}),
        ...(addedNodes.has(n.key) ? { added: true } : {}),
      },
      source: 'neo4j',
    }
  })
  for (const e of edges) {
    const from = byKey.get(e.from)
    const to = byKey.get(e.to)
    if (!from || !to) continue
    const source = elementId(from)
    const target = elementId(to)
    out.push({
      group: 'edges',
      data: {
        id: `${source}-${e.type}-${target}`,
        source,
        target,
        label: e.type,
        kind: 'edge',
        ...(addedEdges.has([e.type, e.from, e.to].join('|')) ? { added: true } : {}),
      },
      source: 'neo4j',
    })
  }
  return out
}
