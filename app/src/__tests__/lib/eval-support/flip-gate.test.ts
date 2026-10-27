import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { it, expect } from 'vitest'
import { flipGate, PENDING_MUSTS } from '../../../lib/eval-support/flip-gate'
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
    pendingMusts: [],
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

// A `general` row in a report no longer counts as the baseline: the record decides,
// whatever rows say. The record says `fail` and the stray row says `pass`; the
// candidate is still eligible.
//
// MUTATION: read the baseline from `rows` again (agent === 'general') in flip-gate.ts
// → the stray row bars the candidate and this reddens.
it('ignores a stray general row: only the recorded baseline bars the candidate', () => {
  expect(
    flipGate(true, true, 'general-next', scenarios, [rows[0], row('general', 'baseline')], {
      baseline: 'fail',
    }).eligible,
  ).toBe(true)
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
// A pending must (#808–#810, owner ruling 2026-10-27) does not block the flip: a
// failing run leaves it eligible, but the report must still carry the pending list.
it('lists a pending must that failed instead of blocking, and a passing one is not listed', () => {
  const pending = (id: string) =>
    [{ id, priority: 'must', baseline: false }] as ConversationScenario[]
  const result = flipGate(true, true, 'general-next', pending('07-follow-up-success'), [], {})
  expect(result.eligible).toBe(true)
  expect(result.reasons).toEqual([])
  expect(result.pendingMusts).toEqual(['07-follow-up-success (#808)'])
  expect(
    flipGate(true, true, 'general-next', pending('08-follow-up-failure'), [], {}).pendingMusts,
  ).toEqual(['08-follow-up-failure (#809)'])
  const passing = [
    {
      agent: 'general-next',
      scenario: '07-follow-up-success',
      status: 'pass',
      tier: 'self_deployed',
      checks: [],
    },
  ] as ConversationResult[]
  expect(
    flipGate(true, true, 'general-next', pending('07-follow-up-success'), passing, {}).pendingMusts,
  ).toEqual([])
})

// A must that is NOT pending still blocks: only the record's entries are relieved.
it('a must that is not pending still blocks; a pending one is listed', () => {
  expect(
    flipGate(
      true,
      true,
      'general-next',
      [
        { id: '17-mail-analysis-follow-up', priority: 'must', baseline: false },
      ] as ConversationScenario[],
      [],
      {},
    ).reasons,
  ).toContain('Candidate must pass 17-mail-analysis-follow-up')
  expect(
    flipGate(
      true,
      true,
      'general-next',
      [
        { id: '17-mail-analysis-follow-up', priority: 'must', baseline: false },
      ] as ConversationScenario[],
      [],
      {},
    ).pendingMusts,
  ).toEqual([])
})

// The pending-must record pins the shipped modules: it names exactly the must-priority
// scenarios whose module carries `pendingMustIssue`, with the same issue number. Read
// from the modules' source so a new flag without a record entry (or the reverse) reddens.
//
// MUTATION: add or drop an entry in PENDING_MUSTS (flip-gate.ts), or add/drop a
// `pendingMustIssue` flag on a must module without the matching record change → reddens.
// MUTATION: a pending module that drops `must` for its priority reddens on the third check.
const pendingFromModules = readdirSync(DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => readFileSync(resolve(DIR, f), 'utf8'))
  .map((src) => ({
    id: /\bid: '([^']+)'/.exec(src)![1],
    priority: /\bpriority: '([a-z]+)'/.exec(src)![1],
    issue: /\bpendingMustIssue: (\d+)/.exec(src)?.[1],
  }))
it('PENDING_MUSTS names exactly the must modules flagged pending, by issue number', () => {
  const flagged = pendingFromModules.filter((s) => s.issue)
  expect(flagged.length).toBeGreaterThan(0)
  expect(Object.keys(PENDING_MUSTS).sort()).toEqual(flagged.map((s) => s.id).sort())
  for (const s of flagged) expect(PENDING_MUSTS[s.id]).toBe(Number(s.issue))
  // A pending row that loses its priority is stale: it must still be a must.
  for (const s of flagged) expect(s.priority).toBe('should')
})

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
