/**
 * Event-stream projections — the read model behind the observability timeline.
 *
 * These were only reachable through a mounted `ObservabilityPanel` before the
 * split (#226 B5). Tested directly here: the row preview per event type, the
 * Interface/Tools lane assignment, and the tool_call → tool_result merge,
 * including the cases the panel's DOM tests can only reach indirectly.
 */
import { describe, it, expect } from 'vitest'
import type { ContextEvent, EventType } from '~/lib/harness-patterns'
import { buildTimelineItems, getEventLane, getEventPreview } from '~/lib/observability/projection'

let seq = 0
const ev = (type: EventType, data: unknown, extra: Partial<ContextEvent> = {}): ContextEvent => ({
  type,
  ts: ++seq,
  patternId: 'neo4j-query',
  data,
  ...extra,
})

describe('getEventPreview', () => {
  it('names the tool for a call and reports success or failure for a result', () => {
    expect(getEventPreview('tool_call', { tool: 'read_neo4j_cypher' })).toBe('read_neo4j_cypher')
    expect(getEventPreview('tool_result', { tool: 'get', success: true })).toBe('get: ok')
    expect(getEventPreview('tool_result', { tool: 'get', success: false })).toBe('get: error')
  })

  it('shows a single controller action by tool name', () => {
    expect(getEventPreview('controller_action', { action: { tool_name: 'json_get' } })).toBe(
      'json_get',
    )
  })

  it('flags a batched controller action with the whole batch', () => {
    const preview = getEventPreview('controller_action', {
      action: {
        tool_name: 'json_get',
        additional_calls: [{ tool_name: 'hset' }, { tool_name: 'sadd' }],
      },
    })
    expect(preview).toBe('×3 json_get, hset, sadd')
  })

  it('truncates message content at 50 characters', () => {
    expect(getEventPreview('user_message', { content: 'short' })).toBe('short')
    expect(getEventPreview('assistant_message', { content: 'x'.repeat(60) })).toBe(
      'x'.repeat(50) + '...',
    )
  })

  it('falls back to an empty preview when a message carries no content', () => {
    expect(getEventPreview('user_message', {})).toBe('')
  })

  it('previews the requested action, the error text and the compacted intent', () => {
    expect(getEventPreview('approval_request', { request: { action: 'write to Neo4j' } })).toBe(
      'write to Neo4j',
    )
    expect(getEventPreview('error', { error: 'y'.repeat(70) })).toBe('y'.repeat(50))
    expect(getEventPreview('intent_compacted', { intent: 'find the orphans' })).toBe(
      'find the orphans',
    )
    expect(getEventPreview('intent_compacted', { intent: 'z'.repeat(60) })).toBe(
      'z'.repeat(50) + '...',
    )
  })

  it('summarises a plan by step count and first line', () => {
    expect(
      getEventPreview('plan_created', { plan: { n_steps: 3, plan: 'read schema\nthen query' } }),
    ).toBe('3 steps: read schema')
    expect(getEventPreview('plan_created', { plan: { n_steps: 1, plan: 'one thing' } })).toBe(
      '1 step: one thing',
    )
  })

  it('reports a skipped plan by its reason and tolerates a missing plan', () => {
    expect(getEventPreview('plan_created', { skipped: 'single tool' })).toBe(
      'skipped (single tool)',
    )
    expect(getEventPreview('plan_created', {})).toBe('0 steps: ')
  })

  it('truncates a long plan head', () => {
    const preview = getEventPreview('plan_created', { plan: { n_steps: 2, plan: 'q'.repeat(80) } })
    expect(preview).toHaveLength(53)
    expect(preview.endsWith('...')).toBe(true)
  })

  it('keys a sanitized preview on findings, so an empty screen reads as an outage', () => {
    expect(getEventPreview('content_sanitized', { tool: 'fetch', findings: [] })).toBe(
      'fetch: screen unavailable',
    )
  })

  it('lists the distinct rules that fired, de-duplicated', () => {
    expect(
      getEventPreview('content_sanitized', {
        tool: 'fetch',
        findings: [{ rule: 'imperative' }, { rule: 'imperative' }, { rule: 'exfil' }],
      }),
    ).toBe('fetch: 3 neutralized (imperative, exfil)')
  })

  it('truncates an oversized rule list', () => {
    const preview = getEventPreview('content_sanitized', {
      tool: 'fetch',
      findings: Array.from({ length: 6 }, (_, i) => ({ rule: `rule-number-${i}` })),
    })
    expect(preview).toHaveLength(53)
    expect(preview.endsWith('...')).toBe(true)
  })

  it('gives pattern boundaries and unknown types no preview', () => {
    expect(getEventPreview('pattern_enter', {})).toBe('')
    expect(getEventPreview('pattern_exit', {})).toBe('')
    expect(getEventPreview('critic_result', { verdict: 'ok' })).toBe('')
  })
})

describe('getEventLane', () => {
  it('puts conversation, boundary and approval events in the Interface lane', () => {
    for (const type of [
      'user_message',
      'assistant_message',
      'pattern_enter',
      'pattern_exit',
      'approval_request',
      'approval_response',
    ] as EventType[]) {
      expect(getEventLane(type)).toBe('interface')
    }
  })

  it('puts everything else in the Tools lane', () => {
    for (const type of [
      'tool_call',
      'tool_result',
      'controller_action',
      'critic_result',
      'error',
      'content_sanitized',
    ] as EventType[]) {
      expect(getEventLane(type)).toBe('tools')
    }
  })
})

describe('buildTimelineItems', () => {
  it('merges a call with the result carrying the same callId', () => {
    const call = ev('tool_call', { tool: 'get', callId: 'c1' })
    const result = ev('tool_result', { tool: 'get', success: true, callId: 'c1' })
    expect(buildTimelineItems([call, result])).toEqual([{ kind: 'tool_pair', call, result }])
  })

  it('leaves a call and a mismatched result as two standalone items', () => {
    const call = ev('tool_call', { tool: 'get', callId: 'c1' })
    const result = ev('tool_result', { tool: 'get', success: true, callId: 'c2' })
    expect(buildTimelineItems([call, result])).toEqual([
      { kind: 'event', event: call },
      { kind: 'event', event: result },
    ])
  })

  it('leaves a callId-less call unmerged', () => {
    const call = ev('tool_call', { tool: 'get' })
    const result = ev('tool_result', { tool: 'get', success: true, callId: 'c1' })
    expect(buildTimelineItems([call, result])).toEqual([
      { kind: 'event', event: call },
      { kind: 'event', event: result },
    ])
  })

  it('pairs each call with its own result when two are interleaved', () => {
    const callA = ev('tool_call', { tool: 'a', callId: 'a' })
    const callB = ev('tool_call', { tool: 'b', callId: 'b' })
    const resultB = ev('tool_result', { tool: 'b', success: true, callId: 'b' })
    const resultA = ev('tool_result', { tool: 'a', success: true, callId: 'a' })
    expect(buildTimelineItems([callA, callB, resultB, resultA])).toEqual([
      { kind: 'tool_pair', call: callA, result: resultA },
      { kind: 'tool_pair', call: callB, result: resultB },
    ])
  })

  it('never consumes one result twice when two calls share a callId', () => {
    const first = ev('tool_call', { tool: 'get', callId: 'dup' })
    const second = ev('tool_call', { tool: 'get', callId: 'dup' })
    const result = ev('tool_result', { tool: 'get', success: true, callId: 'dup' })
    expect(buildTimelineItems([first, second, result])).toEqual([
      { kind: 'tool_pair', call: first, result },
      { kind: 'event', event: second },
    ])
  })

  it('keeps a pending call as a standalone item', () => {
    const call = ev('tool_call', { tool: 'get', callId: 'c1' })
    expect(buildTimelineItems([call])).toEqual([{ kind: 'event', event: call }])
  })

  it('passes non-tool events through in order and handles an empty stream', () => {
    const user = ev('user_message', { content: 'hi' })
    const enter = ev('pattern_enter', {})
    expect(buildTimelineItems([user, enter])).toEqual([
      { kind: 'event', event: user },
      { kind: 'event', event: enter },
    ])
    expect(buildTimelineItems([])).toEqual([])
  })
})
