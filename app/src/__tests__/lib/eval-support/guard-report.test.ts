/**
 * The general-next report's per-turn guard counts, computed from the turn's own
 * events alone (boundary guards slice 7; revision 6 slice 17 moved the counts
 * from the retired gate's calls to the injection-ingress-guard
 * classification's, keyed `guard.ingress`). The negative case is the pin's
 * point: a route decision (`next_step`) is not a classification call,
 * whatever its shape, and a Decide failure on a guard question is counted
 * where the redesign looks for it.
 */
import { describe, expect, it, vi } from 'vitest'

// The counts read the classification's key and safe line from their module,
// which self-asserts server-only; the suite runs under jsdom, so the assert
// is mocked exactly as the sibling fixture tests do.
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

import type { ContextEvent } from '@hames-ai/harness-patterns'
import { guardTurnCounts } from '../../../lib/eval-support/guard-report'

const event = (type: string, data: unknown, llmCall?: { durationMs: number }) =>
  ({ type, data, ...(llmCall ? { llmCall } : {}) }) as ContextEvent

/** A classification answer (`guard.ingress`, revision 6): `pSafe` is the
 *  `safe` probability, the argmax label follows it, `null` is an abstention. */
const classify = (
  pSafe: number | null,
  opts: { ms?: number; shadow?: boolean; label?: string } = {},
) =>
  event(
    'decision_made',
    {
      key: 'guard.ingress',
      ...(pSafe === null
        ? { label: null, probs: {}, abstained: true }
        : {
            label: opts.label ?? (pSafe >= 0.5 ? 'safe' : 'instructions-for-ai-detected'),
            probs: {
              safe: pSafe,
              'possible-instructions-for-ai': (1 - pSafe) / 2,
              'instructions-for-ai-detected': (1 - pSafe) / 2,
            },
            abstained: false,
          }),
      ...(opts.shadow ? { shadow: true } : {}),
    },
    opts.ms ? { durationMs: opts.ms } : undefined,
  )
const egressDown = () =>
  event('decision_made', { key: 'guard.egress', abstained: true, reason: 'error' })
const routeDecision = () =>
  event('decision_made', { key: 'next_step', label: 'info-retrieval', abstained: false })
const screenCall = (ms: number) =>
  event('model_call', { role: 'screen', source: 'web/fetch' }, { durationMs: ms })

const turnOf = (...events: ContextEvent[]) => [{ response: 'a', status: 'done', events }]

describe('the per-turn guard counts', () => {
  it('counts classification calls, safe presentations, latency, screens, prompts, audits and Decide failures from events alone', () => {
    const [row] = guardTurnCounts(
      turnOf(
        routeDecision(),
        classify(0.9, { ms: 120 }), // safe, above the line
        classify(0.6, { ms: 80, shadow: true }), // argmax safe, short of the line
        classify(0.05), // detected
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
      classificationCalls: 3,
      classificationShadow: 1,
      classificationUnavailable: 0,
      classificationSafe: 1,
      classificationLatencyMs: 200,
      screenCalls: 1,
      screenLatencyMs: 400,
      promptsRaised: 1,
      promptsDefaulted: 1,
      egressAudited: 1,
      egressRefused: 1,
      decideDown: 1,
    })
  })

  // The half the row is written for: the classification's numbers come from
  // `guard.ingress` alone. A route decision, and the retired gate's
  // `guard.screen` events a persisted capture may still hold, must not land
  // in them. MUTATION: make the counting function read every `decision_made`
  // event (drop the key filter): this assertion turns red.
  it('a route decision and a retired gate event are not classification calls; an empty turn reports zeros', () => {
    const [route] = guardTurnCounts(
      turnOf(
        routeDecision(),
        event('decision_made', { key: 'guard.screen', pTrue: 0.9, abstained: false }),
      ),
    )!
    expect(route.classificationCalls).toBe(0)
    const [empty] = guardTurnCounts(turnOf())!
    expect(empty).toMatchObject({
      classificationCalls: 0,
      classificationShadow: 0,
      classificationUnavailable: 0,
      classificationSafe: 0,
      classificationLatencyMs: null,
      screenCalls: 0,
      screenLatencyMs: null,
      promptsRaised: 0,
      promptsDefaulted: 0,
      egressAudited: 0,
      egressRefused: 0,
      decideDown: 0,
    })
  })

  // MUTATION: count an abstention as a safe presentation, or drop the
  // abstained filter (unavailable reads 0).
  it('an unavailable classification is counted as unavailable and as a guard Decide failure, never as safe', () => {
    const [row] = guardTurnCounts(turnOf(classify(null, { ms: 30 }), classify(0.9)))!
    expect(row.classificationCalls).toBe(2)
    expect(row.classificationUnavailable).toBe(1)
    expect(row.classificationSafe).toBe(1)
    expect(row.decideDown).toBe(1)
    expect(row.classificationLatencyMs).toBe(30)
  })

  // The report applies the classification's own rule: argmax `safe` short of
  // the safe line presents as the cautious middle, so it is not counted safe.
  // MUTATION: drop the `>= GUARD_INGRESS_SAFE_LINE` half of `presentsSafe`.
  it('counts as safe only what presents as safe: argmax safe at or above the line', () => {
    const [row] = guardTurnCounts(turnOf(classify(0.69), classify(0.7), classify(0.95)))!
    expect(row.classificationSafe).toBe(2)
  })

  it('counts per turn, not per conversation', () => {
    const rows = guardTurnCounts([
      { response: 'a', status: 'done', events: [classify(0.9)] },
      { response: 'b', status: 'done', events: [classify(0.05), egressDown()] },
    ])
    expect(rows.map((r) => r.turn)).toEqual([1, 2])
    expect(rows[0]!.classificationCalls).toBe(1)
    expect(rows[1]!.classificationCalls).toBe(1)
    expect(rows[1]!.decideDown).toBe(1)
    expect(rows[0]!.decideDown).toBe(0)
  })
})
