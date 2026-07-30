/**
 * omitResultFields — the lens behind SimpleLoopConfig.resultOmit.
 *
 * A pure recursive omit: named keys are deleted at every object level, arrays
 * recurse element-wise, primitives pass through. Used to build the controller
 * turn log's compact view of a tool result; the event store keeps the full
 * result, so these semantics only ever narrow what the loop LLM reads.
 */
import { describe, it, expect } from 'vitest'
import { omitResultFields } from '../../../lib/harness-patterns/content-transforms'

describe('omitResultFields', () => {
  const hit = (name: string) => ({
    name,
    webUrl: 'https://example.sharepoint.com/x'.padEnd(500, 'a'),
    item_id: `id-${name}`,
    nested: { webUrl: 'inner', keep: true },
  })

  it('is the identity (same reference) when omit is empty or undefined', () => {
    const data = { a: 1, results: [hit('x')] }
    expect(omitResultFields(data, undefined)).toBe(data)
    expect(omitResultFields(data, [])).toBe(data)
  })

  it('drops the named key at every nesting level, including array elements', () => {
    const data = { query: 'q', total: 14, results: [hit('a'), hit('b')] }
    const out = omitResultFields(data, ['webUrl']) as typeof data
    expect(out.query).toBe('q')
    expect(out.total).toBe(14)
    for (const r of out.results) {
      expect(r).not.toHaveProperty('webUrl')
      expect(r.nested).not.toHaveProperty('webUrl')
      expect(r.nested.keep).toBe(true)
      expect(r.item_id).toMatch(/^id-/)
    }
  })

  it('never mutates the input', () => {
    const data = { results: [hit('a')] }
    const snapshot = JSON.stringify(data)
    omitResultFields(data, ['webUrl'])
    expect(JSON.stringify(data)).toBe(snapshot)
  })

  it('passes primitives through at every level — a pre-serialized JSON string is untouched', () => {
    const asString = JSON.stringify({ webUrl: 'https://x' })
    expect(omitResultFields(asString, ['webUrl'])).toBe(asString)
    expect(omitResultFields(42, ['webUrl'])).toBe(42)
    expect(omitResultFields(null, ['webUrl'])).toBe(null)
    expect(omitResultFields(['a', 'b'], ['webUrl'])).toEqual(['a', 'b'])
  })

  it('omits multiple keys in one pass', () => {
    const out = omitResultFields({ a: 1, b: 2, c: { a: 3, d: 4 } }, ['a', 'b']) as Record<string, unknown>
    expect(out).toEqual({ c: { d: 4 } })
  })
})
