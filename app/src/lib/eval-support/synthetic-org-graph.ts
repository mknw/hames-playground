/**
 * The synthetic organizational graph the general-next Eval's org rows run on
 * (org-knowledge slice 7). Every name is invented; pillars and themes are
 * placeholders. A scenario names the seeds it needs; each run builds a fresh
 * in-memory store (`createMemoryOrgGraphStore`), so no row sees another's
 * writes.
 *
 * Pure apart from building that store: no I/O, no model.
 */
import {
  createMemoryOrgGraphStore,
  type MemoryOrgGraphStore,
} from '@hames-ai/harness-patterns/org-knowledge-store'
import type {
  SnapshotEdge,
  SnapshotNode,
} from '@hames-ai/harness-patterns/org-knowledge-validate.server'
import { nameKey } from '@hames-ai/harness-patterns/org-knowledge-ontology'
import { ORG_ONTOLOGY } from '../org-graph/ontology'
import type { OrgGraphSnapshot, OrgSeedName } from './org-scenario'

/** One directory member, in the shape the roster ingest writes a `Member` node. */
export interface SyntheticMember {
  readonly entraId: string
  readonly displayName: string
  readonly mail: string
  /** Soft in the ontology: may be absent, and is then left absent. */
  readonly department?: string
  readonly jobTitle?: string
}

/**
 * The Eval's member directory: ten invented members. Every value is invented —
 * names, addresses (example.com), ids (random v4 UUIDs) and generic role titles.
 * Each carries a job title and no department, so the missing-soft-field path is
 * exercised. Members exist; the hook links to them, never creates them. The Eval
 * reads no live or local graph for them (`no-real-neo4j.test.ts`).
 */
export const SYNTHETIC_MEMBERS: readonly SyntheticMember[] = [
  {
    entraId: '66b10305-be10-4445-935e-6c6f75758dc3',
    displayName: 'Tamsin Orrin',
    mail: 'tamsin.orrin@example.com',
    jobTitle: 'Project Lead',
  },
  {
    entraId: 'e7a1d169-ccbb-4057-9760-79e35a0401d2',
    displayName: 'Halden Mirow',
    mail: 'halden.mirow@example.com',
    jobTitle: 'Research Analyst',
  },
  {
    entraId: '18a167c0-6c79-4b39-abfd-73f08a3f7703',
    displayName: 'Dorrit Wexley',
    mail: 'dorrit.wexley@example.com',
    jobTitle: 'Delivery Lead',
  },
  {
    entraId: '66b61238-3225-4459-9071-ae878118e825',
    displayName: 'Corwin Delacy',
    mail: 'corwin.delacy@example.com',
    jobTitle: 'Project Lead',
  },
  {
    entraId: '1aa2b6a1-09cf-4ff9-a5ba-6fcca05b204e',
    displayName: 'Yvaine Rocholl',
    mail: 'yvaine.rocholl@example.com',
    jobTitle: 'Project Lead',
  },
  {
    entraId: '85552dbc-6f99-4dde-a4a5-4b48fa78b797',
    displayName: 'Mira Cedar',
    mail: 'mira.cedar@example.com',
    jobTitle: 'Project Lead',
  },
  {
    entraId: 'fa35ecbc-8683-45b7-a287-d1a04107bed2',
    displayName: 'Osric Thelwall',
    mail: 'osric.thelwall@example.com',
    jobTitle: 'Executive Director',
  },
  {
    entraId: 'b23924fe-38a0-46ce-9fc1-c5c13af160c3',
    displayName: 'Liesel Brunvoll',
    mail: 'liesel.brunvoll@example.com',
    jobTitle: 'Project Lead',
  },
  {
    entraId: '36510112-b51e-40c9-a9fd-b8508ae704d8',
    displayName: 'Bastian Kettleby',
    mail: 'bastian.kettleby@example.com',
    jobTitle: 'Delivery Lead',
  },
  {
    entraId: '9f403ff1-e52f-4f28-8c03-7ab994ffaa8f',
    displayName: 'Pernille Ostrander',
    mail: 'pernille.ostrander@example.com',
    jobTitle: 'Project Lead',
  },
]

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const bounded = (form: string, flags: string) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escape(form)}(?![\\p{L}\\p{N}])`, flags)

/**
 * V9 for the Eval: does a text name a synthetic member? A full name or an
 * address matches in any case; one part of a name alone only when written
 * capitalised. The production matcher (the app's member-mentions module) reads
 * the directory with the same rules; the Eval's directory is this list.
 */
export function syntheticMentionsMember(text: string): boolean {
  const t = text.normalize('NFKC')
  return SYNTHETIC_MEMBERS.some(
    (m) =>
      bounded(m.displayName, 'iu').test(t) ||
      bounded(m.mail, 'iu').test(t) ||
      m.displayName.split(' ').some((part) => bounded(part, 'u').test(t)),
  )
}

const node = (id: string, label: string, props: Record<string, string>): SnapshotNode => ({
  key: `id:${id}`,
  label,
  properties: {
    id,
    ...props,
    ...(props.name ? { nameKey: nameKey(props.name) } : {}),
    createdBy: 'seed',
  },
})
/** A member's node id: `m-` and the given name, lower-cased (`m-dorrit`). */
const memberId = (m: SyntheticMember) => `m-${m.displayName.split(' ')[0].toLowerCase()}`
const member = (m: SyntheticMember): SnapshotNode => ({
  key: `id:${memberId(m)}`,
  label: 'Member',
  // The ingest's fields, plus the synthetic store's node `id` (the ingest writes
  // none; the seeds' edges address nodes by it). A missing soft field stays absent.
  properties: { id: memberId(m), ...m },
})
const edge = (type: string, from: string, to: string): SnapshotEdge => ({
  type,
  from: `id:${from}`,
  to: `id:${to}`,
})

const SEEDS: Record<OrgSeedName, { nodes: SnapshotNode[]; edges: SnapshotEdge[] }> = {
  members: {
    nodes: SYNTHETIC_MEMBERS.map(member),
    edges: [],
  },
  osprey: { nodes: [node('p-osprey', 'Project', { name: 'Osprey' })], edges: [] },
  heron: { nodes: [node('p-heron', 'Project', { name: 'Heron' })], edges: [] },
  alder: { nodes: [node('p-alder', 'Project', { name: 'Alder' })], edges: [] },
  pillars: {
    nodes: ['A', 'B', 'C'].map((x) =>
      node(`pl-${x}`, 'Pillar', { name: `Pillar ${x}`, objective: `objective ${x}` }),
    ),
    edges: [],
  },
  'osprey-in-pillar-a': { nodes: [], edges: [edge('IN_PILLAR', 'p-osprey', 'pl-A')] },
  'theme-1': {
    nodes: [node('t-1', 'Theme', { name: 'Theme 1' })],
    edges: [edge('COORDINATES', 'm-dorrit', 't-1')],
  },
  fernwick: { nodes: [node('pa-fernwick', 'Partner', { name: 'Fernwick Ltd' })], edges: [] },
}

/** A fresh store holding exactly the named seeds (an edge's ends must be seeded too). */
export function createSyntheticOrgGraph(seeds: readonly OrgSeedName[]): MemoryOrgGraphStore {
  const nodes = new Map<string, SnapshotNode>()
  const edges: SnapshotEdge[] = []
  for (const name of seeds) {
    for (const n of SEEDS[name].nodes) nodes.set(n.key, n)
    edges.push(...SEEDS[name].edges)
  }
  for (const e of edges) {
    if (!nodes.has(e.from) || !nodes.has(e.to)) {
      throw new Error(`synthetic org graph: ${e.type} needs both ends seeded`)
    }
  }
  return createMemoryOrgGraphStore(ORG_ONTOLOGY, { nodes: [...nodes.values()], edges })
}

/** The store's contents as the graders read them. */
export function orgGraphSnapshot(store: MemoryOrgGraphStore): OrgGraphSnapshot {
  const g = store.dump()
  return {
    nodes: g.nodes.map((n) => ({ key: n.key, label: n.label, properties: { ...n.properties } })),
    edges: g.edges.map((e) => ({ type: e.type, from: e.from, to: e.to })),
  }
}

/** Node properties a graph read never shows: the store's own bookkeeping and the
 *  member fields the draft has no use for. */
const HIDDEN_PROPERTIES = new Set(['id', 'nameKey', 'createdBy', 'entraId', 'mail'])

const nodeName = (n: { properties: Record<string, string> }) =>
  n.properties.name ?? n.properties.displayName ?? n.properties.label ?? n.properties.text ?? ''

/**
 * What the org rows' draft loop reads for `read_neo4j_cypher` (LD-22): the
 * scenario's OWN synthetic org graph, the one its candidate is validated
 * against. Before this the draft's reads reached the route's miniature project
 * graph (`evals/general-next/driver.ts`), so a live draft looked for Theme 1
 * and was shown Alder and Dune. Canned rather than Cypher: a query that quotes
 * a literal gets the nodes whose name contains one (or is contained in one),
 * case-insensitively, with the edges touching them; a query that quotes none
 * gets the whole graph. Node rows are `{ label, ...properties }`, edge rows
 * `{ from, type, to }` by name.
 */
export function syntheticOrgGraphRead(store: MemoryOrgGraphStore, query: string): unknown[] {
  const g = store.dump()
  const literals = [...query.matchAll(/'([^']+)'|"([^"]+)"/g)]
    .map((m) => (m[1] ?? m[2]).toLowerCase())
    .filter((l) => l.trim() !== '')
  const named = (name: string) => {
    const n = name.toLowerCase()
    return n !== '' && literals.some((l) => n.includes(l) || l.includes(n))
  }
  const nodes = literals.length === 0 ? g.nodes : g.nodes.filter((n) => named(nodeName(n)))
  const keys = new Set(nodes.map((n) => n.key))
  const byKey = new Map(g.nodes.map((n) => [n.key, nodeName(n)]))
  return [
    ...nodes.map((n) => ({
      label: n.label,
      ...Object.fromEntries(
        Object.entries(n.properties).filter(([k]) => !HIDDEN_PROPERTIES.has(k)),
      ),
    })),
    ...g.edges
      .filter((e) => keys.has(e.from) || keys.has(e.to))
      .map((e) => ({ from: byKey.get(e.from) ?? '', type: e.type, to: byKey.get(e.to) ?? '' })),
  ]
}

/** The two read-only tools the draft holds, served from `store` — a run-scoped
 *  transport, so it outranks the route's process-wide synthetic transport. */
export function syntheticOrgDraftTransport(store: MemoryOrgGraphStore) {
  return {
    id: 'general-eval-synthetic-org-graph',
    ownsTool: (name: string) => name === 'read_neo4j_cypher' || name === 'get_neo4j_schema',
    namespaceFor: () => 'neo4j',
    listTools: async () => [],
    callTool: async (name: string, args: Record<string, unknown>) => ({
      success: true,
      data:
        name === 'get_neo4j_schema'
          ? {
              labels: ORG_ONTOLOGY.classes.map((c) => c.label),
              relationships: ORG_ONTOLOGY.relations.map((r) => r.type),
            }
          : syntheticOrgGraphRead(store, typeof args.query === 'string' ? args.query : ''),
    }),
  }
}
