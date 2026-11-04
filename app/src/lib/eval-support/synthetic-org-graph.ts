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
 *  member fields the draft has no use for. A predicate may still name them. */
const HIDDEN_PROPERTIES = new Set(['id', 'nameKey', 'createdBy', 'entraId', 'mail'])

const nodeName = (n: { properties: Record<string, string> }) =>
  n.properties.name ?? n.properties.displayName ?? n.properties.label ?? n.properties.text ?? ''

/** A read's outcome: rows, or the error a Neo4j server would give instead. */
export type SyntheticOrgRead =
  { readonly ok: true; readonly rows: unknown[] } | { readonly ok: false; readonly error: string }

type Op = '=' | 'CONTAINS' | 'STARTS WITH' | 'ENDS WITH'
interface Atom {
  readonly v: string
  readonly prop: string
  readonly lower: boolean
  readonly op: Op
  readonly value: string
}

const STRING = String.raw`'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"`
/** A string literal after masking (`§0§`): masking first keeps a literal's
 *  own words ("Port OR Harbour", "WITH") out of the clause and AND/OR split. */
const MASKED = String.raw`§\d+§`
const VALUE = String.raw`(?:toLower\(\s*)?(?:${MASKED}|\$\w+)\s*\)?`
const NODE = /\(\s*(\w+)?\s*(?::\s*(\w+))?\s*(\{[^}]*\})?\s*\)/g
const INLINE = new RegExp(String.raw`(\w+)\s*:\s*(${VALUE})`, 'g')
const ATOM = new RegExp(
  String.raw`^\(?\s*(toLower\(\s*)?(\w+)\.(\w+)\s*\)?\s*(=|CONTAINS|STARTS WITH|ENDS WITH)\s*(${VALUE})\s*\)?$`,
  'i',
)
const SUPPORTED =
  "the synthetic org graph supports MATCH over (v:Label {prop: 'x'}) patterns and a WHERE of v.prop / toLower(v.prop) with =, CONTAINS, STARTS WITH or ENDS WITH, joined by AND / OR"

/**
 * What the org rows' draft loop reads for `read_neo4j_cypher` (LD-23): the
 * scenario's OWN synthetic org graph, the one its candidate is validated
 * against. On the first live run the draft's reads reached the route's
 * miniature project graph instead.
 *
 * As strict as Neo4j on what it supports, so an eval row can fail the way
 * production would (the review of #991, its SHOULD 3): a label is honoured; an
 * inline `{prop: 'x'}` or `v.prop = 'x'` is exact and case-sensitive, so
 * `{name: 'Project Osprey'}` does NOT find a stored "Osprey"; substring
 * matching happens only after CONTAINS / STARTS WITH / ENDS WITH, and
 * case-insensitively only under `toLower(...)`; `$name` reads the call's
 * `params`. A pattern whose node finds nothing makes the whole read empty, as
 * Neo4j's row product would. Anything outside that subset, or not Cypher, is
 * an error naming the subset rather than a lenient guess. Not modelled: the
 * row shape (node rows are `{ label, ...properties }`, edge rows
 * `{ from, type, to }` by name, the edges touching every matched node, of the
 * pattern's relationship types when it names any).
 */
export function syntheticOrgGraphRead(
  store: MemoryOrgGraphStore,
  query: string,
  params: Readonly<Record<string, unknown>> = {},
): SyntheticOrgRead {
  const fail = (why: string): SyntheticOrgRead => ({
    ok: false,
    error: `Invalid query: ${why}; ${SUPPORTED}.`,
  })
  // Mask every string literal first: the checks and splits below then read
  // only Cypher, never a literal's own words.
  const strings: string[] = []
  const q = query.trim().replace(new RegExp(STRING, 'g'), (lit) => `§${strings.push(lit) - 1}§`)
  if (/['"]/.test(q)) return fail('an unterminated string')
  if (!/^(OPTIONAL\s+)?MATCH\b/i.test(q) || !/\bRETURN\b/i.test(q))
    return fail('not a MATCH … RETURN read')
  if (/\b(CREATE|MERGE|DELETE|DETACH|SET|REMOVE|CALL)\b/i.test(q))
    return fail('the graph is read-only and procedures are not served')
  let depth = 0
  for (const ch of q) {
    depth += ch === '(' ? 1 : ch === ')' ? -1 : 0
    if (depth < 0) break
  }
  if (depth !== 0) return fail('unbalanced parentheses')

  const literal = (raw: string): { value: string } | string => {
    const lower = /^toLower\(/i.test(raw)
    const inner = raw.replace(/^toLower\(\s*/i, '').replace(/\s*\)$/, '')
    let v: unknown
    if (inner.startsWith('$')) {
      v = params[inner.slice(1)]
      if (typeof v !== 'string') return `expected parameter ${inner}`
    } else {
      v = strings[Number(inner.slice(1, -1))].slice(1, -1).replace(/\\(.)/g, '$1')
    }
    return { value: lower ? (v as string).toLowerCase() : (v as string) }
  }

  const where = /\bWHERE\b([\s\S]*?)(?=\bRETURN\b|(?<!(?:STARTS|ENDS)\s+)\bWITH\b|$)/i
    .exec(q)?.[1]
    ?.trim()
  const pattern = q.slice(0, where !== undefined ? q.search(/\bWHERE\b/i) : q.search(/\bRETURN\b/i))
  const labels = new Map<string, string | undefined>()
  const atoms: Atom[] = []
  let anon = 0
  for (const m of pattern.matchAll(NODE)) {
    const v = m[1] ?? `_${anon++}`
    labels.set(v, m[2] ?? labels.get(v))
    for (const p of (m[3] ?? '').matchAll(INLINE)) {
      const lit = literal(p[2])
      if (typeof lit === 'string') return fail(lit)
      atoms.push({ v, prop: p[1], lower: false, op: '=', value: lit.value })
    }
  }
  if (labels.size === 0) return fail('no node pattern')
  const types = [...pattern.matchAll(/\[\s*\w*\s*:\s*(\w+(?:\s*\|\s*:?\w+)*)/g)].flatMap((m) =>
    m[1].split('|').map((t) => t.replace(/[:\s]/g, '')),
  )

  // WHERE as OR of AND groups; every atom must be in the supported subset.
  const groups: Atom[][] = []
  for (const group of where ? where.split(/\s+OR\s+/i) : ['']) {
    const g: Atom[] = []
    for (const text of group.trim() === '' ? [] : group.split(/\s+AND\s+/i)) {
      const m = ATOM.exec(text.trim())
      if (!m || !labels.has(m[2]))
        return fail(`unsupported predicate ${JSON.stringify(text.trim())}`)
      const lit = literal(m[5])
      if (typeof lit === 'string') return fail(lit)
      g.push({
        v: m[2],
        prop: m[3],
        lower: Boolean(m[1]),
        op: m[4].toUpperCase() as Op,
        value: lit.value,
      })
    }
    groups.push(g)
  }

  const g = store.dump()
  const holds = (n: (typeof g.nodes)[number], a: Atom) => {
    const raw = n.properties[a.prop]
    if (typeof raw !== 'string') return false
    const have = a.lower ? raw.toLowerCase() : raw
    return a.op === '='
      ? have === a.value
      : a.op === 'CONTAINS'
        ? have.includes(a.value)
        : a.op === 'STARTS WITH'
          ? have.startsWith(a.value)
          : have.endsWith(a.value)
  }
  const base = (v: string) =>
    g.nodes.filter(
      (n) =>
        (labels.get(v) === undefined || n.label === labels.get(v)) &&
        atoms.every((a) => a.v !== v || holds(n, a)),
    )
  const constrained = [...labels.keys()].filter(
    (v) =>
      labels.get(v) !== undefined ||
      atoms.some((a) => a.v === v) ||
      groups.some((gr) => gr.some((a) => a.v === v)),
  )
  if (constrained.length === 0) return { ok: true, rows: rowsOf(g, g.nodes, types) }
  const matched = new Map<string, Set<(typeof g.nodes)[number]>>(
    constrained.map((v) => [v, new Set()]),
  )
  for (const group of groups) {
    const per = constrained.map((v) =>
      base(v).filter((n) => group.every((a) => a.v !== v || holds(n, a))),
    )
    // Neo4j's row product: one pattern node with no match empties the group.
    if (per.some((nodes) => nodes.length === 0)) continue
    per.forEach((nodes, i) => nodes.forEach((n) => matched.get(constrained[i])!.add(n)))
  }
  // In the graph's own order, each node once.
  const hit = new Set([...matched.values()].flatMap((set) => [...set]))
  return {
    ok: true,
    rows: rowsOf(
      g,
      g.nodes.filter((n) => hit.has(n)),
      types,
    ),
  }
}

function rowsOf(
  g: ReturnType<MemoryOrgGraphStore['dump']>,
  nodes: ReturnType<MemoryOrgGraphStore['dump']>['nodes'],
  types: readonly string[],
): unknown[] {
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
      .filter(
        (e) =>
          (keys.has(e.from) || keys.has(e.to)) && (types.length === 0 || types.includes(e.type)),
      )
      .map((e) => ({ from: byKey.get(e.from) ?? '', type: e.type, to: byKey.get(e.to) ?? '' })),
  ]
}

/** The two read-only tools the draft holds, served from `store` — a run-scoped
 *  transport, so it outranks the route's process-wide synthetic transport. A
 *  read the subset refuses comes back as a failed call, as Neo4j's error would. */
export function syntheticOrgDraftTransport(store: MemoryOrgGraphStore) {
  return {
    id: 'general-eval-synthetic-org-graph',
    ownsTool: (name: string) => name === 'read_neo4j_cypher' || name === 'get_neo4j_schema',
    namespaceFor: () => 'neo4j',
    listTools: async () => [],
    callTool: async (name: string, args: Record<string, unknown>) => {
      if (name === 'get_neo4j_schema')
        return {
          success: true,
          data: {
            labels: ORG_ONTOLOGY.classes.map((c) => c.label),
            relationships: ORG_ONTOLOGY.relations.map((r) => r.type),
          },
        }
      const params =
        typeof args.params === 'object' && args.params !== null && !Array.isArray(args.params)
          ? (args.params as Record<string, unknown>)
          : {}
      const read = syntheticOrgGraphRead(
        store,
        typeof args.query === 'string' ? args.query : '',
        params,
      )
      return read.ok
        ? { success: true, data: read.rows }
        : { success: false, data: null, error: read.error }
    },
  }
}
