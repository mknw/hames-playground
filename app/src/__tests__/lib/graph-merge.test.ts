/**
 * Tests for `mergeGraphElements` — the dedup + touched-flag refresh logic
 * that drives the accumulator in `routes/index.tsx`.
 */

import { describe, it, expect } from 'vitest'
import { mergeGraphElements } from '../../lib/graph-merge'
import type { GraphElement } from '../../lib/harness-client/types'

const node = (id: string, extra: Record<string, unknown> = {}): GraphElement => ({
  data: { id, label: id, ...extra },
  source: 'neo4j',
})

describe('mergeGraphElements', () => {
  it('appends fresh elements when there is no overlap', () => {
    const out = mergeGraphElements([node('A')], [node('B'), node('C')])
    expect(out.map(e => e.data?.id)).toEqual(['A', 'B', 'C'])
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
    const prev = [
      node('A', { touched: true }),
      node('B', { touched: true }),
    ]
    const out = mergeGraphElements(prev, [node('C', { touched: true })])
    expect(out).toHaveLength(3)
    const a = out.find(e => e.data?.id === 'A')!
    const b = out.find(e => e.data?.id === 'B')!
    const c = out.find(e => e.data?.id === 'C')!
    expect((a.data as Record<string, unknown>).touched).toBeUndefined()
    expect((b.data as Record<string, unknown>).touched).toBeUndefined()
    expect((c.data as Record<string, unknown>).touched).toBe(true)
  })

  it('promotes an existing element to touched when the new batch tags its id', () => {
    const out = mergeGraphElements(
      [node('A'), node('B')],
      [node('A', { touched: true })],
    )
    const a = out.find(e => e.data?.id === 'A')!
    const b = out.find(e => e.data?.id === 'B')!
    expect((a.data as Record<string, unknown>).touched).toBe(true)
    expect((b.data as Record<string, unknown>).touched).toBeUndefined()
  })

  it('does not mutate touched on existing elements when the fresh batch has no touched flags', () => {
    const prev = [node('A', { touched: true })]
    const out = mergeGraphElements(prev, [node('B')])
    const a = out.find(e => e.data?.id === 'A')!
    expect((a.data as Record<string, unknown>).touched).toBe(true)
  })

  it('reproduces the user-reported sequence: query KVDB, then query Redis', () => {
    // Query 1: "Find concepts containing database" → KVDB touched, Redis is neighborhood.
    const afterQuery1 = mergeGraphElements(
      [],
      [
        node('Key-Value Database', { touched: true }),
        node('Redis'),
      ],
    )
    expect(touchedIds(afterQuery1)).toEqual(['Key-Value Database'])

    // Query 2: "Show me everything about Redis" → Redis touched, KVDB is neighborhood.
    const afterQuery2 = mergeGraphElements(
      afterQuery1,
      [
        node('Redis', { touched: true }),
        node('Key-Value Database'),
      ],
    )
    expect(touchedIds(afterQuery2)).toEqual(['Redis'])
  })
})

function touchedIds(elements: readonly GraphElement[]): string[] {
  return elements
    .filter(e => (e.data as Record<string, unknown> | undefined)?.touched === true)
    .map(e => e.data?.id as string)
    .sort()
}
