import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { it, expect } from 'vitest'
import { flipGate } from '../../../lib/eval-support/flip-gate'
import { GENERAL_BASELINE } from '../../../lib/eval-support/general-baseline'
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
): ConversationResult => ({ agent, scenario, status, tier: 'self_deployed', checks: [] })
// The baseline is the RECORDED `general` result: the agent is gone, so no row of
// its own can exist. Passed explicitly so the cases below do not depend on the
// shipped record.
const recorded = { baseline: 'pass' } as const
const rows = [row('general-next', 'must'), row('general-next', 'baseline')]
it('requires live, complete evidence, all candidate musts and no regression on the recorded baseline', () => {
  expect(flipGate(true, true, 'general-next', scenarios, rows, recorded)).toEqual({
    eligible: true,
    reasons: [],
  })
  expect(flipGate(false, true, 'general-next', scenarios, rows, recorded).eligible).toBe(false)
  expect(flipGate(true, false, 'general-next', scenarios, rows, recorded).eligible).toBe(false)
  for (const status of ['fail', 'gated', 'stopped'] as const) {
    expect(
      flipGate(
        true,
        true,
        'general-next',
        scenarios,
        [row('general-next', 'must', status)],
        recorded,
      ).reasons,
    ).toContain('Candidate must pass must')
    expect(
      flipGate(
        true,
        true,
        'general-next',
        scenarios,
        [rows[0], row('general-next', 'baseline', status)],
        recorded,
      ).reasons,
    ).toContain('Baseline regression: baseline')
  }
  expect(flipGate(true, true, 'general-next', scenarios, rows.slice(0, 1), recorded).eligible).toBe(
    false,
  )
})

// A baseline that did not pass bars nothing, as when it was measured in the same run.
it('a recorded baseline that failed imposes no bar', () => {
  expect(
    flipGate(true, true, 'general-next', scenarios, rows.slice(0, 1), { baseline: 'fail' })
      .eligible,
  ).toBe(true)
  expect(flipGate(true, true, 'general-next', scenarios, rows.slice(0, 1), {}).eligible).toBe(true)
})

// A `general` row in the report no longer counts as the baseline: it is the record
// that decides, whatever rows say.
//
// MUTATION: read the baseline from `rows` again (agent === 'general') in flip-gate.ts
// → the first expectation goes green-eligible and this reddens.
it('ignores a stray general row: only the recorded baseline bars the candidate', () => {
  expect(
    flipGate(true, true, 'general-next', scenarios, [rows[0], row('general', 'baseline')], recorded)
      .reasons,
  ).toContain('Baseline regression: baseline')
})

// The shipped record has to cover exactly the scenarios flagged `baseline`. A new
// baseline scenario with no recorded result would bar nothing, silently. Read from
// the scenario files' source: nothing under `src/` may import `evals/`
// (`evals-not-in-ci.test.ts`).
//
// MUTATION: delete one entry from GENERAL_BASELINE (general-baseline.ts), or flag
// another scenario `baseline: true`, and the first assertion reddens.
const DIR = resolve(process.cwd(), 'evals/general-next/scenarios')
const shipped = readdirSync(DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => readFileSync(resolve(DIR, f), 'utf8'))
  .map((src) => ({
    id: /\bid: '([^']+)'/.exec(src)![1],
    baseline: /\bbaseline: (true|false)/.exec(src)![1] === 'true',
  }))
it('the shipped record covers exactly the baseline-flagged scenarios', () => {
  expect(shipped.length).toBeGreaterThan(10)
  expect(Object.keys(GENERAL_BASELINE).sort()).toEqual(
    shipped
      .filter((s) => s.baseline)
      .map((s) => s.id)
      .sort(),
  )
  // Non-vacuous: the record carries both outcomes, so the bar is not a constant.
  expect(Object.values(GENERAL_BASELINE)).toEqual(expect.arrayContaining(['pass', 'fail']))
})

// The shipped record end to end: a candidate that fails a recorded-pass baseline
// scenario is refused, one that fails the recorded-fail scenario is not.
it('bars on a recorded pass and not on a recorded fail', () => {
  const only = (id: string) =>
    [{ id, baseline: true, priority: 'should' }] as ConversationScenario[]
  expect(flipGate(true, true, 'general-next', only('06-read-only'), []).reasons).toContain(
    'Baseline regression: 06-read-only',
  )
  expect(
    flipGate(true, true, 'general-next', only('07-follow-up-success'), []).reasons,
  ).not.toContain('Baseline regression: 07-follow-up-success')
})
