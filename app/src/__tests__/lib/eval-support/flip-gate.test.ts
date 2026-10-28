import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { it, expect } from 'vitest'
import { flipGate, gradeMustAttempts, PENDING_MUSTS } from '../../../lib/eval-support/flip-gate'
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
    flaky: [],
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
// A pending must (#808–#809, owner ruling 2026-10-27) does not block the flip: a
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

// #842 (owner ruling 2026-10-28): a failing MUST scenario is re-run twice more, and the
// gate counts it as passing when 2 of the 3 attempts pass, marking it flaky. SHOULD
// scenarios are unchanged. The counting rule itself, hermetically:
//
// MUTATION: relax the comparison in gradeMustAttempts (flip-gate.ts) to `passes > 0`
// → the 1-of-3 assertion reddens; tighten it to `passes === attempts` → the 2-of-3
// assertion reddens. MUTATION: make `flaky: status === 'pass'` (drop `&& passes <
// attempts`) → the 3-of-3 assertion reddens.
it('a must re-run: 1 of 3 fails, 2 of 3 passes flaky, 3 of 3 passes clean', () => {
  expect(gradeMustAttempts(['pass', 'fail', 'fail'])).toEqual({
    attempts: 3,
    passes: 1,
    status: 'fail',
    flaky: false,
  })
  expect(gradeMustAttempts(['pass', 'fail', 'pass'])).toEqual({
    attempts: 3,
    passes: 2,
    status: 'pass',
    flaky: true,
  })
  expect(gradeMustAttempts(['pass', 'pass', 'pass'])).toEqual({
    attempts: 3,
    passes: 3,
    status: 'pass',
    flaky: false,
  })
  // A first-attempt pass is 1 of 1: it stands, and it is not flaky. A single failure
  // still fails, and nothing at all cannot pass.
  expect(gradeMustAttempts(['pass'])).toEqual({
    attempts: 1,
    passes: 1,
    status: 'pass',
    flaky: false,
  })
  expect(gradeMustAttempts(['fail']).status).toBe('fail')
  expect(gradeMustAttempts([]).status).toBe('fail')
})

// The counting rule end to end in the gate: attempt rows (numbered by the runner) feed
// the verdict, a flaky pass is listed and stays eligible, a 1-of-3 run blocks, and a
// single first-attempt pass runs once.
//
// MUTATION: read the must verdict from a single `status === 'pass'` row again (drop the
// attempt aggregation in flip-gate.ts) → the 1-of-3 case reddens on eligible.
it('a re-run must passes 2 of 3 as flaky and eligible, and 1 of 3 blocks', () => {
  const must = [{ id: 're-run', priority: 'must', baseline: false }] as ConversationScenario[]
  const attempts = (statuses: ConversationResult['status'][]) =>
    statuses.map((status, i) => ({ ...row('general-next', 're-run', status), attempt: i + 1 }))
  expect(
    flipGate(true, true, 'general-next', must, attempts(['fail', 'pass', 'pass']), {}),
  ).toEqual({ eligible: true, reasons: [], pendingMusts: [], flaky: ['re-run'] })
  const blocked = flipGate(true, true, 'general-next', must, attempts(['fail', 'fail', 'pass']), {})
  expect(blocked.eligible).toBe(false)
  expect(blocked.reasons).toContain('Candidate must pass re-run')
  expect(blocked.flaky).toEqual([])
  expect(flipGate(true, true, 'general-next', must, attempts(['pass']), {}).flaky).toEqual([])
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

// 14-analysis-index-follow-up is a plain should (owner 2026-10-28: depends on
// sandbox-output ingestion, not yet verified): it neither blocks the flip nor is
// listed as a pending must, so it carries neither a `pendingMustIssue` flag nor a
// record entry. The gate report still lists it, as every scenario's results row.
//
// MUTATION: re-add `pendingMustIssue: 810` to its module and/or an entry to
// PENDING_MUSTS — the half-way form reddens the pending-musts pin above, the
// consistent form reddens here — or flip its priority to 'must', which reddens here.
it('14-analysis-index-follow-up is a plain should: no pending flag, no record entry', () => {
  const fourteen = pendingFromModules.find((s) => s.id === '14-analysis-index-follow-up')
  expect(fourteen).toBeDefined()
  expect(fourteen!.issue).toBeUndefined()
  expect(fourteen!.priority).toBe('should')
  expect(PENDING_MUSTS['14-analysis-index-follow-up']).toBeUndefined()
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
