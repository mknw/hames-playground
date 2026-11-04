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

/** The synthetic directory: members exist; the hook links to them, never creates them. */
export const SYNTHETIC_MEMBERS: ReadonlyArray<{ displayName: string; mail: string }> = [
  { displayName: 'Tamsin Orrin', mail: 'tamsin.orrin@example.invalid' },
  { displayName: 'Dorrit Wexley', mail: 'dorrit.wexley@example.invalid' },
  { displayName: 'Mira Cedar', mail: 'mira.cedar@example.invalid' },
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
const member = (id: string, displayName: string): SnapshotNode => ({
  key: `id:${id}`,
  label: 'Member',
  properties: { id, displayName },
})
const edge = (type: string, from: string, to: string): SnapshotEdge => ({
  type,
  from: `id:${from}`,
  to: `id:${to}`,
})

const SEEDS: Record<OrgSeedName, { nodes: SnapshotNode[]; edges: SnapshotEdge[] }> = {
  members: {
    nodes: [
      member('m-tamsin', 'Tamsin Orrin'),
      member('m-dorrit', 'Dorrit Wexley'),
      member('m-mira', 'Mira Cedar'),
    ],
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
