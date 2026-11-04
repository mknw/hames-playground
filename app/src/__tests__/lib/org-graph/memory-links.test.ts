// @vitest-environment node
/**
 * Memory → graph node links, the graph half and the link step (org-knowledge
 * slice 8, LD-15). A recording driver stands in for Neo4j; names are synthetic.
 *
 * Pins, each with the mutation that reddens it:
 *  - a link to a member is never made (mutation: include Member names — drop
 *    both the query's `NOT n:Member` and the code's label check);
 *  - a node is linked only when its name occurs in the evidence as a token
 *    run (mutation: link every row the query returns);
 *  - only an inserted or updated memory is (re)linked, and a failure links
 *    nothing without throwing.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  candidateNameKeys,
  currentNodeNames,
  findLinkableNodes,
} from '../../../lib/org-graph/memory-links.server'
import { linkWrittenMemories } from '../../../lib/memory/graph-links.server'

vi.mock('../../../lib/db/memories.server', () => ({ replaceMemoryGraphLinks: vi.fn() }))

type Row = Record<string, unknown>

/** A READ-session double whose rows obey the query's `NOT n:Member` and
 *  `nameKey IN $keys` / `id IN $ids` filters only when the query says so. */
function graphOf(nodes: Row[]) {
  const queries: string[] = []
  const driver = () =>
    ({
      session: () => ({
        executeRead: async (fn: (tx: unknown) => unknown) =>
          fn({
            run: async (q: string, p: Record<string, unknown>) => {
              queries.push(q)
              let rows = nodes
              if (/NOT n:Member/.test(q))
                rows = rows.filter((r) => !(r.labels as string[]).includes('Member'))
              if (p.keys)
                rows = rows.filter((r) => (p.keys as string[]).includes(r.nameKey as string))
              if (p.ids) rows = rows.filter((r) => (p.ids as string[]).includes(r.id as string))
              return { records: rows.map((r) => ({ get: (k: string) => r[k] })) }
            },
          }),
        close: async () => undefined,
      }),
    }) as never
  return { driver, queries }
}

const NODES: Row[] = [
  { id: 'n-osprey', name: 'Osprey', nameKey: 'osprey', labels: ['Project'] },
  { id: 'n-calder', name: 'Calder & Vos Ltd', nameKey: 'calder & vos ltd', labels: ['Partner'] },
  { id: 'n-tamsin', name: 'Tamsin Orrin', nameKey: 'tamsin orrin', labels: ['Member'] },
  { id: 'n-theme', name: 'Theme 1', nameKey: 'theme 1', labels: ['Theme'] },
]

describe('findLinkableNodes', () => {
  it('links the non-member nodes the evidence names', async () => {
    const { driver } = graphOf(NODES)
    const ids = await findLinkableNodes(
      'I review the Osprey budget with Calder & Vos Ltd every Friday.',
      driver,
    )
    expect(ids.sort()).toEqual(['n-calder', 'n-osprey'])
  })

  // Pin: a link to a member is never made.
  it('never links a member, even one the evidence names', async () => {
    const { driver, queries } = graphOf(NODES)
    const ids = await findLinkableNodes('Tamsin Orrin and I run Theme 1 together.', driver)
    expect(ids).toEqual(['n-theme'])
    expect(queries[0]).toMatch(/NOT n:Member/)
  })

  it('never links a member the query returned anyway', async () => {
    // A graph double that ignores the query's filter: the code's own label
    // check still holds.
    const leaky = () =>
      ({
        session: () => ({
          executeRead: async (fn: (tx: unknown) => unknown) =>
            fn({
              run: async () => ({
                records: NODES.map((r) => ({ get: (k: string) => r[k] })),
              }),
            }),
          close: async () => undefined,
        }),
      }) as never
    const ids = await findLinkableNodes('Tamsin Orrin reviews the Osprey plan.', leaky)
    expect(ids).toEqual(['n-osprey'])
  })

  it('needs the whole name as a run of the evidence’s words', async () => {
    const { driver } = graphOf([
      { id: 'n-heron', name: 'Heron Two', nameKey: 'heron two', labels: ['Project'] },
      { id: 'n-heron-2', name: 'Heron', nameKey: 'heron', labels: ['Project'] },
    ])
    expect(await findLinkableNodes('Heron is fine. Two days left.', driver)).toEqual(['n-heron-2'])
    expect(candidateNameKeys('Osprey, really.')).toContain('osprey')
  })
})

describe('currentNodeNames — the recheck at recall', () => {
  it('returns the names the graph holds now, skipping a missing node and any member', async () => {
    const { driver } = graphOf(NODES)
    const names = await currentNodeNames(['n-osprey', 'n-gone', 'n-tamsin'], driver)
    expect([...names.entries()]).toEqual([['n-osprey', 'Osprey']])
  })
})

describe('linkWrittenMemories', () => {
  const payload = {
    v: 1,
    tier: 'self_deployed',
    embedSpace: 's',
    eventId: 'evt-1',
    conversationId: 'c-1',
    items: [
      {
        ref: 'i0',
        ordinal: 0,
        kind: 'semantic',
        content: 'c0',
        evidence: 'I own the Osprey review',
        embedding: [],
        dedupe: 'new',
      },
      {
        ref: 'i1',
        ordinal: 1,
        kind: 'semantic',
        content: 'c1',
        evidence: 'I like Theme 1',
        embedding: [],
        dedupe: 'new',
      },
      {
        ref: 'i2',
        ordinal: 2,
        kind: 'semantic',
        content: 'c2',
        evidence: 'Again the Osprey review',
        embedding: [],
        dedupe: 'new',
      },
    ],
  } as never
  const written = (ordinal: number, action: string, eventId = 'evt-1') =>
    ({
      id: `e${ordinal}`,
      type: 'memory_written',
      patternId: 'memory-confirm',
      ts: 0,
      data: {
        memoryId: `m${ordinal}`,
        kind: 'semantic',
        tier: 'self_deployed',
        eventId,
        ordinal,
        action,
      },
    }) as never

  it('links each inserted or updated memory from its evidence, and skips a reinforced one', async () => {
    const find = vi.fn(async (text: string) => (text.includes('Osprey') ? ['n-osprey'] : []))
    const replace = vi.fn(async () => undefined)
    const linked = await linkWrittenMemories(
      'user-a',
      payload,
      [
        written(0, 'inserted'),
        written(1, 'updated'),
        written(2, 'reinforced'),
        written(0, 'inserted', 'other-evt'),
      ],
      { find, replace },
    )
    expect(find.mock.calls.map((c) => c[0])).toEqual(['I own the Osprey review', 'I like Theme 1'])
    expect(replace.mock.calls).toEqual([
      ['user-a', 'm0', ['n-osprey']],
      ['user-a', 'm1', []],
    ])
    expect(linked).toBe(1)
  })

  it('links nothing and does not throw when the graph cannot be read', async () => {
    const replace = vi.fn(async () => undefined)
    await expect(
      linkWrittenMemories('user-a', payload, [written(0, 'inserted')], {
        find: () => Promise.reject(new Error('graph down')),
        replace,
      }),
    ).resolves.toBe(0)
    expect(replace).not.toHaveBeenCalled()
  })
})
