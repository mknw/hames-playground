import { it, expect } from 'vitest'
import { flipGate } from '../../../lib/eval-support/flip-gate'
import type {
  ConversationScenario,
  ConversationResult,
} from '../../../lib/eval-support/conversation'
const scenarios = [
  { id: 'must', priority: 'must' },
  { id: 'baseline', baseline: true, priority: 'should' },
] as ConversationScenario[]
const row = (
  agent: string,
  scenario: string,
  status: ConversationResult['status'] = 'pass',
): ConversationResult => ({ agent, scenario, status, tier: 'verda', checks: [] })
const rows = [
  row('general-next', 'must'),
  row('general', 'baseline'),
  row('general-next', 'baseline'),
]
it('requires live, complete evidence, all candidate musts and no passing-baseline regression', () => {
  expect(flipGate(true, true, 'general-next', scenarios, rows)).toEqual({
    eligible: true,
    reasons: [],
  })
  expect(flipGate(false, true, 'general-next', scenarios, rows).eligible).toBe(false)
  expect(flipGate(true, false, 'general-next', scenarios, rows).eligible).toBe(false)
  expect(flipGate(true, true, 'general', scenarios, rows).eligible).toBe(false)
  for (const status of ['fail', 'gated', 'stopped'] as const) {
    expect(
      flipGate(true, true, 'general-next', scenarios, [row('general-next', 'must', status)])
        .reasons,
    ).toContain('Candidate must pass must')
    expect(
      flipGate(true, true, 'general-next', scenarios, [
        ...rows.slice(0, 2),
        row('general-next', 'baseline', status),
      ]).reasons,
    ).toContain('Baseline regression: baseline')
  }
  expect(flipGate(true, true, 'general-next', scenarios, rows.slice(1)).eligible).toBe(false)
  expect(flipGate(true, true, 'general-next', scenarios, rows.slice(0, 1)).eligible).toBe(true)
})
