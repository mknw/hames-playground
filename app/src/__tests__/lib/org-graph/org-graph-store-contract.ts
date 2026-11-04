/**
 * The one contract every `OrgGraphStore` adapter satisfies
 * (`docs/plan/org-knowledge-hook.md`, slice 2): the in-memory adapter runs it
 * in layer 1; the Neo4j adapter runs it against a DISPOSABLE database only
 * (`org-graph-store-neo4j.test.ts`). Assertions are produced by the real
 * validator from a draft, so the suite exercises what the hook will hand the
 * store. Every name is synthetic.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  validateOrgDraft,
  type CheckedAssertion,
  type DraftElement,
  type GraphSnapshot,
  type SnapshotEdge,
  type SnapshotNode,
} from '@hames-ai/harness-patterns/org-knowledge-validate.server'
import type { OrgGraphStore } from '@hames-ai/harness-patterns/org-knowledge-store'
import { ORG_ONTOLOGY } from '../../../lib/org-graph/ontology'

export interface StoredGraph {
  nodes: { key: string; label: string; properties: Record<string, string> }[]
  edges: { type: string; from: string; to: string; properties: Record<string, string> }[]
}

export interface StoreHarness {
  store: OrgGraphStore
  /** Everything in the store, provenance included. */
  read(): Promise<StoredGraph>
  /** A write made behind the hook's back (another writer). */
  setProperty(key: string, prop: string, value: string): Promise<void>
  addEdge(type: string, from: string, to: string): Promise<void>
}

export type MakeStore = (seed: {
  nodes: SnapshotNode[]
  edges: SnapshotEdge[]
}) => Promise<StoreHarness>

const TODAY = '2026-11-04'
const A = { userId: 'user-a', now: '2026-11-04T10:00:00.000Z' }
const B = { userId: 'user-b', now: '2026-11-05T10:00:00.000Z' }

/** A seed node: key `id:<id>`, with `id` among its properties as stored. */
export const seedNode = (
  id: string,
  label: string,
  props: Record<string, string>,
): SnapshotNode => ({
  key: `id:${id}`,
  label,
  properties: { id, ...props },
})

const n = (
  ref: string,
  label: string,
  properties: Record<string, string>,
  evidence: string,
): DraftElement => ({
  kind: 'node',
  ref,
  label,
  properties,
  evidence,
  assertion: 0,
})
const e = (type: string, from: string, to: string, evidence: string): DraftElement => ({
  kind: 'edge',
  type,
  from,
  to,
  evidence,
  assertion: 0,
})

/** Snapshot through the store, validate, and return the one assertion. */
async function prepare(
  store: OrgGraphStore,
  elements: DraftElement[],
  message: string,
): Promise<CheckedAssertion> {
  const names = elements.flatMap((el) => {
    if (el.kind !== 'node') return []
    const name = el.properties.name ?? el.properties.displayName ?? el.properties.label
    return name ? [{ label: el.label, name }] : []
  })
  const snapshot: GraphSnapshot = await store.snapshot({ names, keys: [] })
  const v = validateOrgDraft({ elements }, snapshot, ORG_ONTOLOGY, {
    userMessage: message,
    today: TODAY,
    mentionsMember: () => false,
  })
  expect(v.rejected).toEqual({})
  expect(v.accepted).toHaveLength(1)
  return v.accepted[0]
}

const HERON_MSG = "We've started calling the new logistics workstream Project Heron."
const heronDraft = [n('p', 'Project', { name: 'Heron' }, 'workstream Project Heron')]

const OSPREY = seedNode('osprey', 'Project', {
  name: 'Osprey',
  nameKey: 'osprey',
  status: 'on hold',
})

export function orgGraphStoreContract(adapter: string, make: MakeStore): void {
  describe(`OrgGraphStore contract: ${adapter}`, () => {
    let h: StoreHarness
    const fresh = async (nodes: SnapshotNode[] = [], edges: SnapshotEdge[] = []) => {
      h = await make({ nodes, edges })
      return h
    }
    beforeEach(async () => {
      await fresh()
    })

    it('creates a new node with id, nameKey, createdBy and createdAt', async () => {
      const a = await prepare(h.store, heronDraft, HERON_MSG)
      const r = await h.store.apply(a, A)
      expect(r.status).toBe('applied')
      const { nodes } = await h.read()
      expect(nodes).toHaveLength(1)
      const [heron] = nodes
      expect(heron.label).toBe('Project')
      expect(heron.properties).toMatchObject({
        name: 'Heron',
        nameKey: 'heron',
        createdBy: 'user-a',
        createdAt: A.now,
      })
      expect(heron.properties.id).toMatch(/^[0-9a-f-]{36}$/)
      expect(heron.properties.lastEditedBy).toBeUndefined()
      if (r.status === 'applied') expect(r.keys.p).toBe(`id:${heron.properties.id}`)
    })

    // Design pin: a repeat applies to the same node. Mutation: CREATE instead
    // of MERGE → a second Heron.
    it('applies a repeat to the same node, changing nothing', async () => {
      const a = await prepare(h.store, heronDraft, HERON_MSG)
      await h.store.apply(a, A)
      await h.store.apply(a, B)
      const { nodes } = await h.read()
      expect(nodes).toHaveLength(1)
      expect(nodes[0].properties.createdBy).toBe('user-a')
      expect(nodes[0].properties.lastEditedBy).toBeUndefined()
    })

    // Design pin: createdBy is set on create and never on match. Mutation: SET
    // createdBy unconditionally → B's edit rewrites it.
    it('keeps createdBy on an edit and records lastEditedBy', async () => {
      await fresh([OSPREY])
      const msg = "Project Osprey's status is active."
      const a = await prepare(
        h.store,
        [
          n(
            'p',
            'Project',
            { name: 'Osprey', status: 'active' },
            "Project Osprey's status is active",
          ),
        ],
        msg,
      )
      expect(a.nodes[0].verdict).toBe('updates')
      await h.store.apply(a, B)
      const [osprey] = (await h.read()).nodes
      expect(osprey.properties).toMatchObject({
        status: 'active',
        lastEditedBy: 'user-b',
        lastEditedAt: B.now,
      })
      expect(osprey.properties.createdBy).toBeUndefined() // the seed set none, and an edit sets none

      await fresh()
      await h.store.apply(await prepare(h.store, heronDraft, HERON_MSG), A)
      const restated = await prepare(
        h.store,
        [n('p', 'Project', { name: 'Heron', status: 'active' }, 'Project Heron is active')],
        'Project Heron is active.',
      )
      await h.store.apply(restated, B)
      const [heron] = (await h.read()).nodes
      expect(heron.properties).toMatchObject({
        createdBy: 'user-a',
        createdAt: A.now,
        lastEditedBy: 'user-b',
      })
    })

    it('does not rename a node restated in another case', async () => {
      await fresh([seedNode('alder', 'Project', { name: 'Alder', nameKey: 'alder' })])
      const a = await prepare(
        h.store,
        [n('p', 'Project', { name: 'ALDER' }, 'a project called ALDER')],
        'Quick note: we have a project called ALDER.',
      )
      expect(a.nodes[0].verdict).toBe('reinforces')
      await h.store.apply(a, B)
      const [alder] = (await h.read()).nodes
      expect(alder.properties.name).toBe('Alder')
      expect(alder.properties.lastEditedBy).toBeUndefined()
    })

    // Design pin (with the in-memory mutation): the stale case. Mutation: apply
    // without the stale check → the newer value is overwritten.
    it('refuses as stale an update whose node changed since the preview', async () => {
      await fresh([OSPREY])
      const a = await prepare(
        h.store,
        [
          n(
            'p',
            'Project',
            { name: 'Osprey', status: 'active' },
            "Project Osprey's status is active",
          ),
        ],
        "Project Osprey's status is active.",
      )
      await h.setProperty('id:osprey', 'status', 'cancelled')
      expect(await h.store.apply(a, B)).toEqual({ status: 'stale' })
      const [osprey] = (await h.read()).nodes
      expect(osprey.properties.status).toBe('cancelled')
      expect(osprey.properties.lastEditedBy).toBeUndefined()
    })

    it('replaces a coordinator in one write, and refuses as stale when another appeared', async () => {
      const seed = () => [
        seedNode('t1', 'Theme', { name: 'Theme 1', nameKey: 'theme 1' }),
        seedNode('dw', 'Member', { displayName: 'Dorrit Wexley' }),
        seedNode('to', 'Member', { displayName: 'Tamsin Orrin' }),
        seedNode('hp', 'Member', { displayName: 'Halyard Pruitt' }),
      ]
      const draft = [
        n('m', 'Member', { displayName: 'Tamsin Orrin' }, 'Tamsin Orrin has taken over'),
        n('t', 'Theme', { name: 'Theme 1' }, 'coordinator of Theme 1'),
        e('COORDINATES', 'm', 't', 'Tamsin Orrin has taken over as coordinator of Theme 1'),
      ]
      const msg = 'Tamsin Orrin has taken over as coordinator of Theme 1.'

      await fresh(seed(), [{ type: 'COORDINATES', from: 'id:dw', to: 'id:t1' }])
      const a = await prepare(h.store, draft, msg)
      expect(a.edges[0].removes).toEqual([{ type: 'COORDINATES', from: 'id:dw', to: 'id:t1' }])
      expect((await h.store.apply(a, A)).status).toBe('applied')
      const coordinators = (await h.read()).edges.filter((x) => x.type === 'COORDINATES')
      expect(coordinators.map((x) => [x.from, x.to])).toEqual([['id:to', 'id:t1']])
      expect(coordinators[0].properties.createdBy).toBe('user-a')

      await fresh(seed(), [{ type: 'COORDINATES', from: 'id:dw', to: 'id:t1' }])
      const b = await prepare(h.store, draft, msg)
      await h.addEdge('COORDINATES', 'id:hp', 'id:t1')
      expect(await h.store.apply(b, A)).toEqual({ status: 'stale' })
      const after = (await h.read()).edges.filter((x) => x.type === 'COORDINATES')
      expect(after.map((x) => x.from).sort()).toEqual(['id:dw', 'id:hp'])
    })

    it('keeps one deadline under its project and updates its date', async () => {
      await fresh([OSPREY])
      const draft = (date: string, evidence: string, edgeEvidence: string): DraftElement[] => [
        n('p', 'Project', { name: 'Osprey' }, 'the Osprey review'),
        n('d', 'Deadline', { label: 'Osprey review', date }, evidence),
        e('HAS_DEADLINE', 'p', 'd', edgeEvidence),
      ]
      const first = await prepare(
        h.store,
        draft('2026-12-12', 'due on 12 December', 'the Osprey review is due on 12 December'),
        'Note that the Osprey review is due on 12 December.',
      )
      await h.store.apply(first, A)
      const second = await prepare(
        h.store,
        draft('2026-12-15', 'moved to 15 December', 'the Osprey review moved to 15 December'),
        'Actually, scratch that: the Osprey review moved to 15 December.',
      )
      expect(second.nodes[1].verdict).toBe('updates')
      await h.store.apply(second, B)
      const g = await h.read()
      const deadlines = g.nodes.filter((x) => x.label === 'Deadline')
      expect(deadlines).toHaveLength(1)
      expect(deadlines[0].properties).toMatchObject({
        date: '2026-12-15',
        createdBy: 'user-a',
        lastEditedBy: 'user-b',
      })
      expect(g.edges.filter((x) => x.type === 'HAS_DEADLINE')).toHaveLength(1)
    })

    it('creates a fact with its derived properties and its ABOUT edge', async () => {
      await fresh([OSPREY])
      const msg = 'The Osprey budget is 40,000 euro.'
      const a = await prepare(
        h.store,
        [
          n(
            'f',
            'Fact',
            { text: 'The Osprey budget is 40,000 euro', kind: 'budget' },
            'The Osprey budget is 40,000 euro',
          ),
          n('p', 'Project', { name: 'Osprey' }, 'The Osprey budget'),
          e('ABOUT', 'f', 'p', 'The Osprey budget is 40,000 euro'),
        ],
        msg,
      )
      const r = await h.store.apply(a, A)
      const g = await h.read()
      const fact = g.nodes.find((x) => x.label === 'Fact')!
      expect(fact.properties).toMatchObject({
        text: 'The Osprey budget is 40,000 euro',
        kind: 'budget',
        evidence: 'The Osprey budget is 40,000 euro',
        statedOn: TODAY,
        createdBy: 'user-a',
      })
      expect(fact.properties.nameKey).toBeUndefined()
      const about = g.edges.find((x) => x.type === 'ABOUT')!
      expect(r.status === 'applied' && [about.from, about.to]).toEqual([
        r.status === 'applied' && r.keys.f,
        'id:osprey',
      ])
    })
  })
}
