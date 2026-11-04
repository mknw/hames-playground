/**
 * Intent-shaped graph edit OPS (#226 C2), checked against the host's ontology
 * since org-knowledge slice 6 (LD-16: "any change to the graph must adhere to
 * the ontology"). The auth gate stays with the host's `'use server'` wrapper;
 * these pin the ops' own contract — every operation owns its Cypher (values
 * ride as parameters), admits only the ontology's labels, relation types and
 * properties, merges a repeated name onto one node, stamps provenance, and
 * closes the session even on failure.
 *
 * A small ontology stands in for the host's; names are synthetic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  defineOntology,
  type OntologyClass,
} from '@hames-ai/harness-patterns/org-knowledge-ontology'

type Call = { q: string; p: Record<string, unknown> }
const calls: Call[] = []
/** Rows the next tx.run answers with, in order; an empty answer when none is queued. */
const answers: Record<string, unknown>[][] = []
const txRun = vi.fn(async (q: string, p: Record<string, unknown> = {}) => {
  calls.push({ q, p })
  const rows = answers.shift() ?? []
  return { records: rows.map((r) => ({ get: (k: string) => r[k] })) }
})
const sessionClose = vi.fn(async () => undefined)
const driverSession = vi.fn(() => ({
  executeWrite: async (fn: (tx: { run: typeof txRun }) => unknown) => fn({ run: txRun }),
  close: sessionClose,
}))

vi.mock('../../neo4j/client', () => ({
  getNeo4jDriver: () => ({ session: driverSession }),
}))

const repo = () => import('../../neo4j/graph-edit.server')

const cls = (label: string, extra: Partial<OntologyClass> = {}): OntologyClass => ({
  label,
  nameProperty: 'name',
  required: ['name'],
  optional: [],
  derived: {},
  closed: {},
  dates: [],
  lines: [],
  identity: 'nameKey',
  personFree: false,
  creatable: true,
  ...extra,
})

const ONTOLOGY = defineOntology({
  classes: [
    cls('Member', { nameProperty: 'displayName', required: ['displayName'], creatable: false }),
    cls('Pillar', { required: ['name', 'objective'], creatable: false }),
    cls('Theme', { optional: ['discipline'] }),
    cls('Project', { optional: ['status', 'description'] }),
    cls('Deliverable', { optional: ['description'] }),
  ],
  relations: [
    {
      type: 'COORDINATES',
      from: ['Member'],
      to: ['Pillar', 'Theme'],
      cardinality: { side: 'to', min: 0, max: 1, onExisting: 'replace' },
      proposable: true,
      why: 'w',
    },
    {
      type: 'WORKS_ON',
      from: ['Member'],
      to: ['Project'],
      cardinality: null,
      proposable: true,
      why: 'w',
    },
    {
      type: 'DELIVERS',
      from: ['Project'],
      to: ['Deliverable'],
      cardinality: { side: 'to', min: 1, max: 1, onExisting: 'refuse' },
      proposable: true,
      why: 'w',
    },
  ],
})

const ACTOR = { userId: 'user-a', now: '2026-11-04T10:00:00.000Z' }

beforeEach(() => {
  vi.clearAllMocks()
  calls.length = 0
  answers.length = 0
})

describe('the ontology decides what may be written', () => {
  // Design pin: an unknown label is refused. Mutation: restore the shape-only
  // check (drop canvasCreateRefusal) → `Concept` reaches a query.
  it('refuses a label the ontology does not declare, before any query', async () => {
    const { createGraphNode } = await repo()
    await expect(createGraphNode(ONTOLOGY, ACTOR, 'Concept', 'GraphQL')).rejects.toThrow(
      /Concept is not a label of the ontology \(create one of: Theme, Project\)/,
    )
    expect(txRun).not.toHaveBeenCalled()
  })

  it('never creates a member or a pillar, nor a node that needs more than a name', async () => {
    const { createGraphNode } = await repo()
    await expect(createGraphNode(ONTOLOGY, ACTOR, 'Member', 'Halyard Pruitt')).rejects.toThrow(
      /linked to, never created/,
    )
    await expect(createGraphNode(ONTOLOGY, ACTOR, 'Pillar', 'Pillar D')).rejects.toThrow(
      /linked to, never created/,
    )
    await expect(createGraphNode(ONTOLOGY, ACTOR, 'Deliverable', 'guide')).rejects.toThrow(
      /needs more than a name/,
    )
    await expect(
      createGraphNode(ONTOLOGY, ACTOR, 'Theme', 'Theme 9', 'stewardship'),
    ).rejects.toThrow(/Theme has no property description/)
    expect(txRun).not.toHaveBeenCalled()
  })

  it('refuses a relation type outside the ontology, and an injected one, before any query', async () => {
    const { linkGraphNodes } = await repo()
    for (const type of ['RELATES_TO', 'X]->(b) MATCH (n) DETACH DELETE n //']) {
      await expect(linkGraphNodes(ONTOLOGY, ACTOR, 'e1', 'e2', type)).rejects.toThrow(
        /is not a relation of the ontology/,
      )
    }
    expect(txRun).not.toHaveBeenCalled()
  })

  it('refuses an injected property key before any query', async () => {
    const { setGraphNodeProperty } = await repo()
    await expect(
      setGraphNodeProperty(ONTOLOGY, ACTOR, 'e1', 'k = 1 WITH n MATCH (m)', 'v'),
    ).rejects.toThrow(/Invalid property key/)
    expect(txRun).not.toHaveBeenCalled()
  })
})

describe('createGraphNode', () => {
  // Design pins: creating an existing name merges (mutation: CREATE again →
  // the statement no longer merges on the name key); createdBy is the session
  // user (mutation: omit it → no createdBy in the statement or its params).
  it('merges on the name key, stamps createdBy on creation only, and returns the elementId', async () => {
    answers.push([{ elementId: '4:abc:99' }])
    const { createGraphNode } = await repo()
    await expect(
      createGraphNode(ONTOLOGY, ACTOR, 'Project', 'Project  Heron', 'A logistics workstream'),
    ).resolves.toBe('4:abc:99')
    const [{ q, p }] = calls
    expect(
      q.startsWith(
        'MERGE (n:`Project` {nameKey: $nameKey}) ON CREATE SET n += $props, n.id = $id, n.createdBy = $actor, n.createdAt = $now ',
      ),
    ).toBe(true)
    expect(q).toContain('SET n.lastEditedBy = $actor, n.lastEditedAt = $now')
    expect(q.split('createdBy').length - 1).toBe(1)
    expect(p).toMatchObject({
      nameKey: 'project heron',
      props: { name: 'Project  Heron', description: 'A logistics workstream' },
      update: { description: 'A logistics workstream' },
      actor: 'user-a',
      now: ACTOR.now,
    })
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(sessionClose).toHaveBeenCalledTimes(1)
  })
})

describe('linkGraphNodes', () => {
  it('reads both ends, checks them, and merges the edge with provenance', async () => {
    answers.push([{ labels: ['Member'] }], [{ labels: ['Project'] }])
    const { linkGraphNodes } = await repo()
    await linkGraphNodes(ONTOLOGY, ACTOR, 'e1', 'e2', 'WORKS_ON')
    const merge = calls.at(-1)!
    expect(merge.q).toContain(
      'MERGE (a)-[r:`WORKS_ON`]->(b) ON CREATE SET r.id = $id, r.createdBy = $actor, r.createdAt = $now',
    )
    expect(merge.p).toMatchObject({ sourceId: 'e1', targetId: 'e2', actor: 'user-a' })
  })

  it('refuses ends of the wrong labels without writing', async () => {
    answers.push([{ labels: ['Project'] }], [{ labels: ['Project'] }])
    const { linkGraphNodes } = await repo()
    await expect(linkGraphNodes(ONTOLOGY, ACTOR, 'e1', 'e2', 'WORKS_ON')).rejects.toThrow(
      /WORKS_ON joins Member to Project/,
    )
    expect(calls.some((c) => c.q.includes('MERGE'))).toBe(false)
  })

  it('refuses a second coordinator rather than doubling it', async () => {
    answers.push([{ labels: ['Member'] }], [{ labels: ['Theme'] }], [{ taken: 1 }])
    const { linkGraphNodes } = await repo()
    await expect(linkGraphNodes(ONTOLOGY, ACTOR, 'm2', 't1', 'COORDINATES')).rejects.toThrow(
      /COORDINATES allows 1 per node/,
    )
    expect(calls.some((c) => c.q.includes('MERGE'))).toBe(false)
  })

  it('refuses when an endpoint matches no node instead of resolving as success (#314)', async () => {
    const { linkGraphNodes } = await repo()
    await expect(linkGraphNodes(ONTOLOGY, ACTOR, 'gone', 'e2', 'WORKS_ON')).rejects.toThrow(
      /matched no graph node/,
    )
  })
})

describe('setGraphNodeProperty', () => {
  it('sets a declared property, the name key with a name, and lastEditedBy where it changes', async () => {
    answers.push([{ labels: ['Project'] }])
    const { setGraphNodeProperty } = await repo()
    await setGraphNodeProperty(ONTOLOGY, ACTOR, 'e1', 'name', 'Heron')
    const update = calls.at(-1)!
    expect(update.q).toContain('SET n += $props')
    expect(update.q).toContain('SET n.lastEditedBy = $actor, n.lastEditedAt = $now')
    expect(update.q).not.toContain('createdBy')
    expect(update.p).toMatchObject({
      nodeId: 'e1',
      props: { name: 'Heron', nameKey: 'heron' },
      actor: 'user-a',
    })
  })

  it('refuses an undeclared property and an edit to a member', async () => {
    const { setGraphNodeProperty } = await repo()
    answers.push([{ labels: ['Project'] }])
    await expect(setGraphNodeProperty(ONTOLOGY, ACTOR, 'e1', 'owner', 'x')).rejects.toThrow(
      /Project has no property owner/,
    )
    answers.push([{ labels: ['Member'] }])
    await expect(setGraphNodeProperty(ONTOLOGY, ACTOR, 'e2', 'displayName', 'x')).rejects.toThrow(
      /Member nodes are not edited here/,
    )
    expect(calls.some((c) => c.q.includes('SET'))).toBe(false)
  })

  it('refuses when the node matches nothing (#314), and closes the session on a throw', async () => {
    const { setGraphNodeProperty } = await repo()
    await expect(setGraphNodeProperty(ONTOLOGY, ACTOR, 'gone', 'status', 'active')).rejects.toThrow(
      /matched no graph node/,
    )
    expect(sessionClose).toHaveBeenCalledTimes(1)
  })
})
