/**
 * The general-next report's per-turn guard counts, computed from the turn's own
 * events alone (boundary guards slice 7; the design's one row marked 7): the
 * gate's skip rate is computable from `decision_made` events keyed
 * `guard.screen` alone, and the report prints it. The negative case is the
 * pin's point: a route decision (`next_step`) is not a gate call, whatever its
 * shape, and a Decide failure on the egress question is counted where the
 * redesign looks for it.
 */
import { describe, expect, it, vi } from 'vitest'

// The counts reuse the slice-3 skip-rate function, whose module (and the egress
// gate's) self-asserts server-only; the suite runs under jsdom, so the assert
// is mocked exactly as the sibling fixture tests do.
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

import type { ContextEvent } from '@hames-ai/harness-patterns'
import { guardTurnCounts } from '../../../lib/eval-support/guard-report'

const event = (type: string, data: unknown, llmCall?: { durationMs: number }) =>
  ({ type, data, ...(llmCall ? { llmCall } : {}) }) as ContextEvent

const gateAnswer = (pTrue: number | null, ms?: number) =>
  event(
    'decision_made',
    { key: 'guard.screen', pTrue, abstained: pTrue === null, shadow: true },
    ms ? { durationMs: ms } : undefined,
  )
const egressDown = () =>
  event('decision_made', { key: 'guard.egress', abstained: true, reason: 'error' })
const routeDecision = () =>
  event('decision_made', { key: 'next_step', label: 'info-retrieval', abstained: false })
const screenCall = (ms: number) =>
  event('model_call', { role: 'screen', source: 'web/fetch' }, { durationMs: ms })

const turnOf = (...events: ContextEvent[]) => [{ response: 'a', status: 'done', events }]

describe('the per-turn guard counts', () => {
  it('counts gate calls, skip rate, latency, screens, prompts, audits and Decide failures from events alone', () => {
    const [row] = guardTurnCounts(
      turnOf(
        routeDecision(),
        gateAnswer(0.05, 120), // below τi 0.15: a (shadow) skip
        gateAnswer(0.9, 80),
        egressDown(),
        screenCall(400),
        event('hitl_request', { kind: 'egress-release', requestId: 'r1' }),
        event('hitl_response', { requestId: 'r1', by: 'unattended', choice: 'refuse' }),
        event('egress_audit', { tool: 'web_search', allowedBy: 'decide' }),
        event('egress_refused', { tool: 'web_search', closes: 'route' }),
      ),
    )!
    expect(row).toMatchObject({
      turn: 1,
      gateCalls: 2,
      gateSkipped: 1,
      gateUnavailable: 0,
      gateSkipRate: 0.5,
      gateLatencyMs: 200,
      screenCalls: 1,
      screenLatencyMs: 400,
      promptsRaised: 1,
      promptsDefaulted: 1,
      egressAudited: 1,
      egressRefused: 1,
      decideDown: 1,
    })
  })

  // The half the row is written for: the gate's numbers come from `guard.screen`
  // alone. A route decision must not land in them.
  // MUTATION: make the counting function read every `decision_made` event
  // (drop the key filter): this assertion turns red. The design's own mutation
  // — drop the key from the gate's event in `guard-gate.server.ts` — reddens
  // the counts above instead (every gate number falls to 0) and slice 3's pin
  // with it.
  it('a route decision is not a gate call, and an empty turn reports zeros with a null latency', () => {
    const [route] = guardTurnCounts(turnOf(routeDecision()))!
    expect(route.gateCalls).toBe(0)
    expect(route.gateSkipRate).toBe(0)
    const [empty] = guardTurnCounts(turnOf())!
    expect(empty).toMatchObject({
      gateCalls: 0,
      gateSkipRate: 0,
      gateLatencyMs: null,
      screenCalls: 0,
      screenLatencyMs: null,
      promptsRaised: 0,
      promptsDefaulted: 0,
      egressAudited: 0,
      egressRefused: 0,
      decideDown: 0,
    })
  })

  it('an unavailable gate answer is counted as unavailable, not as a skip', () => {
    const [row] = guardTurnCounts(turnOf(gateAnswer(null, 30), gateAnswer(0.05)))!
    expect(row.gateCalls).toBe(2)
    expect(row.gateUnavailable).toBe(1)
    expect(row.gateSkipped).toBe(1)
    expect(row.gateSkipRate).toBe(0.5)
    expect(row.gateLatencyMs).toBe(30)
  })

  it('counts per turn, not per conversation', () => {
    const rows = guardTurnCounts([
      { response: 'a', status: 'done', events: [gateAnswer(0.05)] },
      { response: 'b', status: 'done', events: [gateAnswer(0.9), egressDown()] },
    ])
    expect(rows.map((r) => r.turn)).toEqual([1, 2])
    expect(rows[0]!.gateCalls).toBe(1)
    expect(rows[1]!.gateCalls).toBe(1)
    expect(rows[1]!.decideDown).toBe(1)
    expect(rows[0]!.decideDown).toBe(0)
  })

  // #844: a run whose gate ran with GUARD_GATE_THRESHOLD set reads its skips
  // against that τi, not the default. MUTATION: drop the threshold argument
  // from the guardGateSkipRate call: the 0.2 answer is not a skip, red.
  it('reads the skip count against the τi the run used (default 0.15)', () => {
    const turn = turnOf(gateAnswer(0.2), gateAnswer(0.9))
    expect(guardTurnCounts(turn)[0]!.gateSkipped).toBe(0)
    expect(guardTurnCounts(turn, 0.25)[0]!.gateSkipped).toBe(1)
  })
})
