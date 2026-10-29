/**
 * Event-stream projections — the read model behind the observability timeline.
 *
 * These were only reachable through a mounted `ObservabilityPanel` before the
 * split (#226 B5). Tested directly here: the row preview per event type, the
 * Interface/Tools lane assignment, which events are a guard's, and the
 * tool_call → tool_result merge, including the cases the panel's DOM tests can
 * only reach indirectly.
 */
import { describe, it, expect } from 'vitest'
import type { ContextEvent, EventType } from '../../types'
import {
  buildTimelineItems,
  getEventLane,
  getEventPreview,
  isGuardEvent,
} from '../../observability/projection'
import { GUARD_EGRESS } from '../../egress-gate.server'
import { GUARD_SCREEN } from '../../guard-gate.server'

let seq = 0
const ev = (type: EventType, data: unknown, extra: Partial<ContextEvent> = {}): ContextEvent => ({
  type,
  ts: ++seq,
  patternId: 'neo4j-query',
  data,
  ...extra,
})

describe('getEventPreview', () => {
  it('previews a decision_made as its verdict or its abstain, never its question', () => {
    const base = { key: 'route', question: 'SECRET QUESTION', label: 'web', stateChars: 9 }
    expect(getEventPreview('decision_made', { ...base, abstained: false })).toBe('route: web')
    expect(
      getEventPreview('decision_made', {
        ...base,
        label: 'chat',
        abstained: true,
        reason: 'low-confidence',
      }),
    ).toBe('route: abstained (low-confidence) → chat')
    expect(getEventPreview('decision_made', { ...base, abstained: false })).not.toContain('SECRET')
  })

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

  it('previews the decision, the error text and the compacted intent', () => {
    // A decision previews its kind and outcome — never the question or the
    // summary, which hold strings an attacker can choose (#433 P3).
    expect(
      getEventPreview('hitl_request', {
        kind: 'provenance',
        question: 'Use offer.docx?',
        summary: { filename: 'offer.docx' },
      }),
    ).toBe('decision requested: provenance')
    expect(
      getEventPreview('hitl_response', { kind: 'provenance', choice: 'sanitize', by: 'person' }),
    ).toBe('decision: provenance → sanitize (person)')
    expect(getEventPreview('hitl_response', { kind: 'confirm', choice: null, by: 'expired' })).toBe(
      'decision: confirm → none (expired)',
    )
    // Legacy (#433 F9): what an older run stored is not read.
    expect(getEventPreview('approval_request', { request: { action: 'write to Neo4j' } })).toBe(
      'legacy approval event',
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
      'injection · fetch: screen unavailable',
    )
  })

  it('lists the distinct rules that fired, de-duplicated', () => {
    expect(
      getEventPreview('content_sanitized', {
        tool: 'get',
        findings: [{ rule: 'imperative' }, { rule: 'imperative' }, { rule: 'exfil' }],
      }),
    ).toBe('injection · get: 3 neutralized (imperative, exfil)')
  })

  it('truncates an oversized rule list', () => {
    const preview = getEventPreview('content_sanitized', {
      tool: 'fetch',
      findings: Array.from({ length: 6 }, (_, i) => ({ rule: `rule-number-${i}` })),
    })
    expect(preview).toHaveLength(53)
    expect(preview.endsWith('...')).toBe(true)
  })

  // Mutation: delete the `warning` case → the timeline row has no preview.
  it('previews a warning by its sentence, truncated like the others', () => {
    expect(getEventPreview('warning', { message: 'Earlier results could not be ranked.' })).toBe(
      'Earlier results could not be ranked.',
    )
    const long = getEventPreview('warning', { message: 'x'.repeat(80) })
    expect(long).toBe('x'.repeat(50) + '...')
  })

  // #437. Mutation: delete the `loop_recovery` case → the row has no preview,
  // so the panel shows a recovery with nothing saying what failed or when.
  it('previews a loop recovery by its class, tool and round', () => {
    expect(
      getEventPreview('loop_recovery', {
        failure: 'tool_error',
        error: 'Permission denied',
        tool: 'read_file',
        turn: 2,
        maxTurns: 12,
      }),
    ).toBe('tool_error read_file · 3/12')
    expect(
      getEventPreview('loop_recovery', {
        failure: 'unparseable_output',
        error: 'x',
        turn: 0,
        maxTurns: 6,
      }),
    ).toBe('unparseable_output · 1/6')
  })

  // Boundary guards: a guard's row names the guard, then what it did.
  // Mutation: return the action alone (drop the guard prefix) → every row below
  // reads like the Tools lane's, which is the complaint this fixes.
  it("leads a guard's preview with the guard's name", () => {
    const decision = { question: 'Q', abstained: false, stateChars: 9 }
    expect(
      getEventPreview('decision_made', {
        ...decision,
        key: GUARD_SCREEN.key,
        type: 'noul',
        label: 'false',
        pTrue: 0.12,
      }),
    ).toBe('injection · guard.screen: false (p=0.12)')
    expect(
      getEventPreview('decision_made', { ...decision, key: GUARD_EGRESS.key, label: 'personal' }),
    ).toBe('egress · guard.egress: personal')
    expect(getEventPreview('model_call', { role: 'screen', source: 'web/fetch' })).toBe(
      'injection · screen web/fetch',
    )
    expect(
      getEventPreview('warning', {
        task: 'egress_check',
        message: 'the company directory could not be read',
        fallback: 'x',
      }),
    ).toBe('egress · the company directory could not be read')
    // Not a guard's: unchanged.
    expect(getEventPreview('decision_made', { ...decision, key: 'route', label: 'web' })).toBe(
      'route: web',
    )
    expect(getEventPreview('model_call', { role: 'describe', items: 3 })).toBe('describe ×3')
  })

  // A shadow gate's row says what the gate WOULD have done at its configured
  // threshold (`wouldRun`, #784 item 10), not the argmax label, which can read
  // 'false' while the gate would have run the screen.
  // MUTATION: drop the `wouldRun` branch from the `decision_made` preview: a
  // shadow row at p=0.30 reads 'false' again.
  it('previews a shadow guard.screen row with what the gate would have done', () => {
    const decision = { question: 'Q', abstained: false, stateChars: 9 }
    const shadow = (wouldRun: boolean, label: string, pTrue: number) =>
      getEventPreview('decision_made', {
        ...decision,
        key: GUARD_SCREEN.key,
        type: 'noul',
        label,
        pTrue,
        shadow: true as const,
        wouldRun,
      })
    expect(shadow(true, 'false', 0.3)).toBe('injection · guard.screen: would screen (p=0.30)')
    expect(shadow(false, 'true', 0.1)).toBe('injection · guard.screen: would skip (p=0.10)')
    // Not shadow (or an event from before the field existed): the label, unchanged.
    expect(
      getEventPreview('decision_made', {
        ...decision,
        key: GUARD_SCREEN.key,
        type: 'noul',
        label: 'false',
        pTrue: 0.3,
      }),
    ).toBe('injection · guard.screen: false (p=0.30)')
  })

  // Mutation: quote `spans` in the audit preview → a person's name on the row.
  it('previews an egress audit by counting the matched names, never quoting them', () => {
    const audit = {
      tool: 'web_search',
      hosts: ['news.example'],
      spans: ['Ravi Example', 'Mira Cedar'],
      probs: { personal: 0.1, company: 0.1, nothing_private: 0.8 },
      allowedBy: 'decide',
    }
    expect(getEventPreview('egress_audit', audit)).toBe(
      'egress · web_search: let out by decide, 2 names',
    )
    expect(getEventPreview('egress_audit', { ...audit, spans: ['Ravi Example'] })).toBe(
      'egress · web_search: let out by decide, 1 name',
    )
  })

  // Mutation: drop `category` or `closes` → a refusal that closed the route
  // reads the same as one that did not; drop the `cause` fallback → an
  // unchecked refusal reads `refused ()`.
  it('previews an egress refusal by its cause, category and what it closed', () => {
    const refused = { tool: 'fetch', route: 'info' }
    expect(
      getEventPreview('egress_refused', {
        ...refused,
        cause: 'decide',
        category: 'company',
        closes: 'route',
      }),
    ).toBe('egress · fetch: refused (company, closes route)')
    expect(
      getEventPreview('egress_refused', {
        ...refused,
        cause: 'decide',
        category: 'personal',
        closes: 'none',
      }),
    ).toBe('egress · fetch: refused (personal)')
    expect(
      getEventPreview('egress_refused', { ...refused, cause: 'unchecked', closes: 'none' }),
    ).toBe('egress · fetch: refused (unchecked)')
  })

  // Mutation: preview the K5 warning by its sentence alone → the row never says
  // why the privacy filter was unavailable.
  it("previews the privacy filter's warning by what it withheld and why", () => {
    const warning = {
      task: 'web_privacy',
      message: 'earlier results withheld: privacy filter unavailable',
      fallback: 'This step ran without earlier results.',
    }
    expect(
      getEventPreview('warning', {
        ...warning,
        detail: { reason: 'directory-empty', events: 12, fields: 3 },
      }),
    ).toBe('privacy · withheld 12 events (directory-empty)')
    // Recorded before the warning carried a reason: its sentence.
    expect(getEventPreview('warning', warning)).toBe(
      'privacy · earlier results withheld: privacy filter...',
    )
  })

  it('caps a guard preview at the same 50 characters', () => {
    const preview = getEventPreview('egress_refused', {
      tool: 't'.repeat(60),
      cause: 'unchecked',
      closes: 'none',
    })
    expect(preview).toBe(`egress · ${'t'.repeat(41)}...`)
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
      'hitl_request',
      'hitl_response',
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
      'warning',
    ] as EventType[]) {
      expect(getEventLane(type)).toBe('tools')
    }
  })
})

describe('isGuardEvent', () => {
  // Mutation: drop any one arm of `guardOf` → that guard's row falls back to the
  // Tools lane; key the decision on anything but the declared key → a rename of
  // GUARD_SCREEN or GUARD_EGRESS reddens this test instead of emptying the lane.
  it("claims every guard's record by its declared marker", () => {
    const guards: Array<[EventType, unknown]> = [
      ['content_sanitized', { tool: 'fetch', findings: [] }],
      ['egress_audit', { tool: 'fetch', spans: [] }],
      ['egress_refused', { tool: 'fetch', cause: 'decide', closes: 'none' }],
      ['decision_made', { key: GUARD_SCREEN.key, label: 'true' }],
      ['decision_made', { key: GUARD_EGRESS.key, label: 'personal' }],
      ['model_call', { role: 'screen', source: 'web/fetch' }],
      ['warning', { task: 'egress_check', message: 'm', fallback: 'f' }],
      ['warning', { task: 'web_privacy', message: 'm', fallback: 'f' }],
    ]
    for (const [type, data] of guards) expect(isGuardEvent(type, data), type).toBe(true)
  })

  it('leaves every other event, including the same types without a guard marker', () => {
    const others: Array<[EventType, unknown]> = [
      ['decision_made', { key: 'next_step', label: 'answer' }],
      ['model_call', { role: 'describe', items: 2 }],
      ['warning', { task: 'title', message: 'm', fallback: 'f' }],
      ['warning', undefined],
      ['tool_call', { tool: 'fetch' }],
      ['tool_result', { tool: 'fetch', success: true }],
      ['error', { error: 'x' }],
      ['user_message', { content: 'hi' }],
    ]
    for (const [type, data] of others) expect(isGuardEvent(type, data), type).toBe(false)
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
