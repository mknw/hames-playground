/**
 * Tests for `mergeGraphElements` — the dedup + touched-flag refresh logic
 * that drives the accumulator in `routes/index.tsx`.
 */

import { describe, it, expect } from 'vitest'
import { mergeGraphElements } from '../../lib/graph-merge'
import type { GraphElement } from '@hames-ai/agents'

const node = (id: string, extra: Record<string, unknown> = {}): GraphElement => ({
  data: { id, label: id, ...extra },
  source: 'neo4j',
})

describe('mergeGraphElements', () => {
  it('appends fresh elements when there is no overlap', () => {
    const out = mergeGraphElements([node('A')], [node('B'), node('C')])
    expect(out.map((e) => e.data?.id)).toEqual(['A', 'B', 'C'])
  })

  it('skips fresh elements whose id already exists (no overwrite of fields)', () => {
    const original = node('A', { keep: 'me' })
    const replacement = node('A', { keep: 'overwritten', extra: 'new' })
    const out = mergeGraphElements([original], [replacement])
    expect(out).toHaveLength(1)
    // Existing element's fields are preserved; only `touched` would be patched.
    expect(out[0].data).toEqual({ id: 'A', label: 'A', keep: 'me' })
  })

  it('clears touched from existing elements when the fresh batch sets touched anywhere', () => {
    const prev = [node('A', { touched: true }), node('B', { touched: true })]
    const out = mergeGraphElements(prev, [node('C', { touched: true })])
    expect(out).toHaveLength(3)
    const a = out.find((e) => e.data?.id === 'A')!
    const b = out.find((e) => e.data?.id === 'B')!
    const c = out.find((e) => e.data?.id === 'C')!
    expect((a.data as Record<string, unknown>).touched).toBeUndefined()
    expect((b.data as Record<string, unknown>).touched).toBeUndefined()
    expect((c.data as Record<string, unknown>).touched).toBe(true)
  })

  it('promotes an existing element to touched when the new batch tags its id', () => {
    const out = mergeGraphElements([node('A'), node('B')], [node('A', { touched: true })])
    const a = out.find((e) => e.data?.id === 'A')!
    const b = out.find((e) => e.data?.id === 'B')!
    expect((a.data as Record<string, unknown>).touched).toBe(true)
    expect((b.data as Record<string, unknown>).touched).toBeUndefined()
  })

  it('does not mutate touched on existing elements when the fresh batch has no touched flags', () => {
    const prev = [node('A', { touched: true })]
    const out = mergeGraphElements(prev, [node('B')])
    const a = out.find((e) => e.data?.id === 'A')!
    expect((a.data as Record<string, unknown>).touched).toBe(true)
  })

  it('reproduces the user-reported sequence: query KVDB, then query Redis', () => {
    // Query 1: "Find concepts containing database" → KVDB touched, Redis is neighborhood.
    const afterQuery1 = mergeGraphElements(
      [],
      [node('Key-Value Database', { touched: true }), node('Redis')],
    )
    expect(touchedIds(afterQuery1)).toEqual(['Key-Value Database'])

    // Query 2: "Show me everything about Redis" → Redis touched, KVDB is neighborhood.
    const afterQuery2 = mergeGraphElements(afterQuery1, [
      node('Redis', { touched: true }),
      node('Key-Value Database'),
    ])
    expect(touchedIds(afterQuery2)).toEqual(['Redis'])
  })
})

// The org-knowledge acceptance (docs/plan/org-knowledge-hook.md, "The Org.graph tab").
// Mutations, each verified red:
// - never strip `added` → "a second acceptance moves the added flag" goes red.
// - append unconditionally → "neighbours already drawn are not re-added" goes red.
describe('mergeGraphElements — the added flag', () => {
  const added = (els: GraphElement[]) =>
    els.filter((e) => (e.data as Record<string, unknown>).added === true).map((e) => e.data?.id)

  it('a second acceptance moves the added flag', () => {
    const first = mergeGraphElements([], [node('Heron', { added: true }), node('Osprey')])
    const second = mergeGraphElements(first, [node('Alder', { added: true }), node('Heron')])
    expect(added(second)).toEqual(['Alder'])
  })

  it('an accepted element already drawn is flagged in place', () => {
    const out = mergeGraphElements([node('Osprey', { x: 1 })], [node('Osprey', { added: true })])
    expect(out).toEqual([node('Osprey', { x: 1, added: true })])
  })

  it('neighbours already drawn are not re-added, and drawn elements keep their place', () => {
    const drawn = [node('Osprey'), node('Pillar A')]
    const out = mergeGraphElements(drawn, [
      node('Heron', { added: true }),
      node('Pillar A'),
      node('Osprey'),
    ])
    expect(out.map((e) => e.data?.id)).toEqual(['Osprey', 'Pillar A', 'Heron'])
  })

  it('a batch carrying neither flag leaves both alone', () => {
    const prev = [node('A', { added: true, touched: true })]
    expect(mergeGraphElements(prev, [node('B')])[0].data).toMatchObject({
      added: true,
      touched: true,
    })
  })

  it('a touched batch strips touched but keeps added, and the other way round', () => {
    const prev = [node('A', { added: true, touched: true })]
    expect(mergeGraphElements(prev, [node('B', { touched: true })])[0].data).toEqual({
      id: 'A',
      label: 'A',
      added: true,
    })
    expect(mergeGraphElements(prev, [node('B', { added: true })])[0].data).toEqual({
      id: 'A',
      label: 'A',
      touched: true,
    })
  })
})

function touchedIds(elements: readonly GraphElement[]): string[] {
  return elements
    .filter((e) => (e.data as Record<string, unknown> | undefined)?.touched === true)
    .map((e) => e.data?.id as string)
    .sort()
}
