/**
 * The org-knowledge graders of the general-next Eval (slice 7): each one goes red on
 * a scripted trace that does the forbidden thing, and green on one that does not. They
 * read the trace the driver records — the synthetic graph, the proposals, a turn's
 * graph tool results — never the reply.
 *
 * Mutations, each verified red (make the check return pass):
 * - `proposalRaisedCheck` → `pass: true` → "a turn with no proposal fails it" goes red.
 * - `noProposalRaisedCheck` → `pass: true` → "a raised proposal fails it" goes red.
 * - `graphEntryCountCheck` → `pass: true` → "a second Heron fails it" goes red.
 * - `graphLacksEntryCheck` → `pass: true` → "a present node fails it" goes red.
 * - `graphNodePropertyCheck` → `pass: true` → "another owner fails it" goes red.
 * - `graphElementsIncludeCheck` → `pass: true` → "a canvas without the fact fails it" goes red.
 */
import { describe, expect, it } from 'vitest'
import type { ContextEvent } from '@hames-ai/harness-patterns'
import {
  graphElementsIncludeCheck,
  graphEntryCountCheck,
  graphLacksEntryCheck,
  graphNodePropertyCheck,
  noProposalRaisedCheck,
  orgChecks,
  proposalRaisedCheck,
} from '../../../lib/eval-support/org-checks'
import type {
  OrgGraphSnapshot,
  OrgTrace,
  OrgTurnTrace,
} from '../../../lib/eval-support/org-scenario'
import {
  createSyntheticOrgGraph,
  orgGraphSnapshot,
  syntheticMentionsMember,
} from '../../../lib/eval-support/synthetic-org-graph'

const EMPTY: OrgGraphSnapshot = { nodes: [], edges: [] }
const heron = (key: string, createdBy = 'eval-user') => ({
  key,
  label: 'Project',
  properties: { id: key, name: 'Heron', createdBy },
})
const osprey = { key: 'id:p-osprey', label: 'Project', properties: { name: 'Osprey' } }
const pillarA = { key: 'id:pl-A', label: 'Pillar', properties: { name: 'Pillar A' } }

function turn(over: Partial<OrgTurnTrace> = {}): OrgTurnTrace {
  return {
    owner: 'eval-user',
    userMessage: 'm',
    settle: { proposed: 0, rejected: {}, skipped: 'gate' },
    inputs: [],
    ...over,
  }
}
const proposed = turn({
  settle: { proposed: 1, rejected: {} },
  proposal: {
    requestId: 'r1',
    elements: [
      { kind: 'node', term: 'Project', names: ['Heron'], verdict: 'new', removes: [] },
      {
        kind: 'edge',
        term: 'COORDINATES',
        names: ['Tamsin Orrin', 'Theme 1'],
        verdict: 'new',
        removes: ['Dorrit Wexley -> Theme 1'],
      },
    ],
  },
})
function trace(over: Partial<OrgTrace> = {}): OrgTrace {
  return {
    seed: EMPTY,
    final: EMPTY,
    turns: [turn()],
    owners: { $userA: 'eval-user', $userB: 'eval-other-user', $driverUserId: 'eval-user' },
    ...over,
  }
}

describe('proposalRaised', () => {
  const c = { check: 'proposalRaised', says: 's', terms: ['Project'], facts: ['Heron'] } as const
  it('passes on a proposal carrying the term and naming the fact', () => {
    expect(proposalRaisedCheck(trace({ turns: [proposed] }), c).pass).toBe(true)
  })
  it('a turn with no proposal fails it', () => {
    const r = proposalRaisedCheck(trace(), c)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/none \(gate\)/)
  })
  it('a proposal on another turn fails it when a turn is named', () => {
    const t = trace({ turns: [proposed, turn()] })
    expect(proposalRaisedCheck(t, { ...c, turn: 2 }).pass).toBe(false)
    expect(proposalRaisedCheck(t, { ...c, turn: 1 }).pass).toBe(true)
  })
  it('a fact only a removed edge names counts, a missing term does not', () => {
    const t = trace({ turns: [proposed] })
    expect(proposalRaisedCheck(t, { ...c, terms: ['COORDINATES'], facts: ['Dorrit'] }).pass).toBe(
      true,
    )
    expect(proposalRaisedCheck(t, { ...c, terms: ['Deadline'] }).pass).toBe(false)
  })
})

describe('noProposalRaised', () => {
  const c = { check: 'noProposalRaised', says: 's' } as const
  it('passes when no turn raised one', () => {
    expect(noProposalRaisedCheck(trace(), c).pass).toBe(true)
  })
  it('a raised proposal fails it', () => {
    const r = noProposalRaisedCheck(trace({ turns: [turn(), proposed] }), c)
    expect(r.pass).toBe(false)
    expect(r.detail).toBe('proposal on turn 2')
  })
  it('a run where the hook never ran fails it', () => {
    expect(noProposalRaisedCheck(undefined, c).pass).toBe(false)
  })
})

describe('graphEntryCount', () => {
  it('counts nodes by label and name', () => {
    const c = {
      check: 'graphEntryCount',
      says: 's',
      terms: ['Project'],
      facts: ['Heron'],
      count: 1,
    } as const
    expect(
      graphEntryCountCheck(trace({ final: { nodes: [heron('a'), osprey], edges: [] } }), c).pass,
    ).toBe(true)
  })
  it('a second Heron fails it', () => {
    const c = {
      check: 'graphEntryCount',
      says: 's',
      terms: ['Project'],
      facts: ['Heron'],
      count: 1,
    } as const
    const r = graphEntryCountCheck(
      trace({ final: { nodes: [heron('a'), heron('b')], edges: [] } }),
      c,
    )
    expect(r.pass).toBe(false)
    expect(r.detail).toBe('2 found, want 1')
  })
  it('counts the edges of a relation type touching a named node', () => {
    const final = {
      nodes: [osprey, pillarA],
      edges: [{ type: 'IN_PILLAR', from: 'id:p-osprey', to: 'id:pl-A' }],
    }
    const c = {
      check: 'graphEntryCount',
      says: 's',
      terms: ['IN_PILLAR'],
      facts: ['Osprey'],
      count: 1,
    } as const
    expect(graphEntryCountCheck(trace({ final }), c).pass).toBe(true)
    expect(graphEntryCountCheck(trace({ final }), { ...c, count: 0 }).pass).toBe(false)
  })
  it('with no facts, counts every node of the label', () => {
    const c = { check: 'graphEntryCount', says: 's', terms: ['Fact'], count: 0 } as const
    const fact = { key: 'f', label: 'Fact', properties: { text: 'x', kind: 'status' } }
    expect(graphEntryCountCheck(trace({ final: { nodes: [osprey], edges: [] } }), c).pass).toBe(
      true,
    )
    expect(graphEntryCountCheck(trace({ final: { nodes: [fact], edges: [] } }), c).pass).toBe(false)
  })
})

describe('graphLacksEntry', () => {
  const c = { check: 'graphLacksEntry', says: 's', facts: ['Kittiwake'] } as const
  it('passes when no node is named by the fact', () => {
    expect(graphLacksEntryCheck(trace({ final: { nodes: [osprey], edges: [] } }), c).pass).toBe(
      true,
    )
  })
  it('a present node fails it, matched in part and in any case', () => {
    const kittiwake = { key: 'k', label: 'Project', properties: { name: 'Project KITTIWAKE' } }
    const r = graphLacksEntryCheck(trace({ final: { nodes: [kittiwake], edges: [] } }), c)
    expect(r.pass).toBe(false)
    expect(r.detail).toMatch(/Project Project KITTIWAKE/)
  })
})

describe('graphNodeProperty', () => {
  const c = {
    check: 'graphNodeProperty',
    says: 's',
    node: 'heron',
    property: 'createdBy',
    equals: '$userA',
  } as const
  it('resolves an owner placeholder and compares', () => {
    expect(
      graphNodePropertyCheck(trace({ final: { nodes: [heron('a')], edges: [] } }), c).pass,
    ).toBe(true)
  })
  it('another owner fails it', () => {
    const t = trace({ final: { nodes: [heron('a', 'eval-other-user')], edges: [] } })
    expect(graphNodePropertyCheck(t, c).pass).toBe(false)
  })
  it('an unknown placeholder or a missing node fails it', () => {
    const t = trace({ final: { nodes: [heron('a')], edges: [] } })
    expect(graphNodePropertyCheck(t, { ...c, equals: '$nobody' }).pass).toBe(false)
    expect(graphNodePropertyCheck(t, { ...c, node: 'Alder' }).pass).toBe(false)
  })
})

describe('graphElementsInclude', () => {
  const c = { check: 'graphElementsInclude', says: 's', turn: 2, facts: ['Heron'] } as const
  const read = (name: string) =>
    ({
      type: 'tool_result',
      ts: 1,
      patternId: 'neo4j-query',
      data: {
        tool: 'read_neo4j_cypher',
        result: [{ n: { identity: 7, labels: ['Project'], properties: { name } } }],
        success: true,
      },
    }) as unknown as ContextEvent
  it('passes when the turn’s graph results draw the fact', () => {
    expect(graphElementsIncludeCheck([{ events: [] }, { events: [read('Heron')] }], c).pass).toBe(
      true,
    )
  })
  it('a canvas without the fact fails it, and so does another turn’s', () => {
    expect(graphElementsIncludeCheck([{ events: [] }, { events: [read('Osprey')] }], c).pass).toBe(
      false,
    )
    expect(graphElementsIncludeCheck([{ events: [read('Heron')] }, { events: [] }], c).pass).toBe(
      false,
    )
  })
})

describe('orgChecks', () => {
  it('runs every check of a row, in order', () => {
    const names = orgChecks(
      [
        { check: 'noProposalRaised', says: 'a' },
        { check: 'graphLacksEntry', says: 'b', facts: ['x'] },
      ],
      trace(),
      [],
    ).map((r) => r.name)
    expect(names).toEqual(['no proposal raised: a', 'graph lacks: b'])
  })
})

describe('the synthetic org graph', () => {
  it('builds a fresh store per call holding exactly the named seeds', () => {
    const a = createSyntheticOrgGraph(['osprey', 'pillars', 'osprey-in-pillar-a'])
    const g = orgGraphSnapshot(a)
    expect(g.nodes.map((n) => n.properties.name).sort()).toEqual([
      'Osprey',
      'Pillar A',
      'Pillar B',
      'Pillar C',
    ])
    expect(g.edges).toEqual([{ type: 'IN_PILLAR', from: 'id:p-osprey', to: 'id:pl-A' }])
    expect(orgGraphSnapshot(createSyntheticOrgGraph(['heron'])).nodes).toHaveLength(1)
  })
  it('refuses an edge whose ends are not seeded', () => {
    expect(() => createSyntheticOrgGraph(['osprey-in-pillar-a'])).toThrow(/both ends seeded/)
  })
  it('names a member by full name or address in any case, by one part only capitalised', () => {
    expect(syntheticMentionsMember('ask TAMSIN ORRIN')).toBe(true)
    expect(syntheticMentionsMember('mail dorrit.wexley@example.invalid')).toBe(true)
    expect(syntheticMentionsMember('Mira said so')).toBe(true)
    expect(syntheticMentionsMember('a cedar tree')).toBe(false)
    expect(syntheticMentionsMember('Admiration')).toBe(false)
  })
})
