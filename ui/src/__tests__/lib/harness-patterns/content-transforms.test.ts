/**
 * omitResultFields — the lens behind SimpleLoopConfig.resultOmit.
 *
 * A pure recursive omit: named keys are deleted at every object level, arrays
 * recurse element-wise, primitives pass through. Used to build the controller
 * turn log's compact view of a tool result; the event store keeps the full
 * result, so these semantics only ever narrow what the loop LLM reads.
 */
import { describe, it, expect } from 'vitest'
import {
  omitResultFields,
  stripThinkBlocks,
  truncateToolResults,
} from '../../../lib/harness-patterns/content-transforms'
import type { ContextEvent } from '../../../lib/harness-patterns/types'

function event(type: ContextEvent['type'], data: unknown): ContextEvent {
  return { id: 'e1', type, timestamp: 1, patternId: 'p', data } as unknown as ContextEvent
}

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
    const out = omitResultFields({ a: 1, b: 2, c: { a: 3, d: 4 } }, ['a', 'b']) as Record<
      string,
      unknown
    >
    expect(out).toEqual({ c: { d: 4 } })
  })
})

describe('stripThinkBlocks', () => {
  it('removes reasoning blocks from an assistant message', () => {
    const out = stripThinkBlocks(
      event('assistant_message', { content: '<think>ramble\nmore</think>\nAnswer: 42' }),
    )

    expect((out.data as { content: string }).content).toBe('Answer: 42')
  })

  it('removes every block, not just the first', () => {
    const out = stripThinkBlocks(
      event('assistant_message', { content: '<think>a</think>one<think>b</think>two' }),
    )

    expect((out.data as { content: string }).content).toBe('onetwo')
  })

  it('returns the original event when there is nothing to strip', () => {
    const ev = event('assistant_message', { content: 'plain answer' })

    expect(stripThinkBlocks(ev)).toBe(ev)
  })

  it('leaves non-assistant events alone', () => {
    const ev = event('tool_result', { result: '<think>not reasoning</think>' })

    expect(truncateToolResults(1000)(stripThinkBlocks(ev))).toBe(ev)
  })

  it('never mutates the source event', () => {
    const ev = event('assistant_message', { content: '<think>x</think>y' })

    stripThinkBlocks(ev)

    expect((ev.data as { content: string }).content).toBe('<think>x</think>y')
  })
})

describe('truncateToolResults', () => {
  it('truncates an over-long string result and marks it', () => {
    const out = truncateToolResults(10)(event('tool_result', { result: 'x'.repeat(50) }))

    expect((out.data as { result: string }).result).toBe(`${'x'.repeat(10)}...[truncated]`)
  })

  it('serializes a structured result before measuring it', () => {
    const out = truncateToolResults(5)(event('tool_result', { result: { a: 'long value here' } }))

    expect((out.data as { result: string }).result).toBe('{"a":...[truncated]')
  })

  it('returns the original event when the result already fits', () => {
    const ev = event('tool_result', { result: 'short' })

    expect(truncateToolResults(100)(ev)).toBe(ev)
  })

  it('leaves non-tool_result events alone', () => {
    const ev = event('assistant_message', { content: 'x'.repeat(50) })

    expect(truncateToolResults(5)(ev)).toBe(ev)
  })
})
