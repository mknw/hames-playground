import type { ConversationScenario, ConversationResult } from './conversation'
import { GENERAL_BASELINE, type BaselineStatus } from './general-baseline'

/**
 * Existing musts whose acceptance run is still pending, with the tracking issue
 * (owner ruling 2026-10-27, #808–#809). The flip gate does not block the flip on
 * a pending must: it lists it in the report instead. The pin in flip-gate.test.ts
 * keeps this record in step with the scenario modules' `pendingMustIssue` — a
 * module that gains or loses the flag without this record, or the other way
 * round, reddens there. A pending must that loses its `must` priority reddens too.
 */
export const PENDING_MUSTS: Readonly<Record<string, number>> = {
  '07-follow-up-success': 808,
  '08-follow-up-failure': 809,
}

/** #842 (owner ruling 2026-10-28): a MUST scenario that fails is re-run twice more, so a
 * re-run scenario has at most this many attempts (two extra over its first run). */
export const MUST_RERUN_ATTEMPTS = 3

/** The #842 counting rule for a re-run MUST scenario, over the statuses of the attempts that
 * ran: the scenario passes when at least two of every three attempts pass — a single
 * first-attempt pass (1 of 1) stands — and a pass carried by failed attempts is `flaky`.
 * An attempt that was not made cannot pass: no rows at all is a fail. Statuses other than
 * `pass` (`fail`, `gated`, `stopped`) count as failed attempts. */
export function gradeMustAttempts(statuses: ConversationResult['status'][]): {
  attempts: number
  passes: number
  status: 'pass' | 'fail'
  flaky: boolean
} {
  const attempts = statuses.length
  const passes = statuses.filter((s) => s === 'pass').length
  // Two of every three: `passes * 3 >= attempts * 2` (a first-attempt pass is 1 of 1 and
  // satisfies it). Everything else fails the scenario.
  const status = attempts > 0 && passes * 3 >= attempts * 2 ? 'pass' : 'fail'
  return { attempts, passes, status, flaky: status === 'pass' && passes < attempts }
}

/** The candidate's verdict for one scenario: the counting rule for a MUST, one attempt for
 * every other priority. The flip gate and the runner's exit code read the same rule. */
export function candidateScenarioStatus(
  priority: ConversationScenario['priority'],
  statuses: ConversationResult['status'][],
): 'pass' | 'fail' {
  if (priority === 'must') return gradeMustAttempts(statuses).status
  return statuses.some((s) => s === 'pass') ? 'pass' : 'fail'
}

/**
 * The baseline side is the recorded `general` results, not rows: the agent no
 * longer exists to be run beside the candidate (see `general-baseline.ts`).
 */
export function flipGate(
  live: boolean,
  selectionComplete: boolean,
  candidate: string,
  scenarios: ConversationScenario[],
  rows: ConversationResult[],
  baseline: Readonly<Record<string, BaselineStatus>> = GENERAL_BASELINE,
): { eligible: boolean; reasons: string[]; pendingMusts: string[]; flaky: string[] } {
  const reasons: string[] = []
  const pendingMusts: string[] = []
  const flaky: string[] = []
  if (!live) reasons.push('Live evidence is required')
  if (!selectionComplete) reasons.push('Scenario selection is incomplete')
  for (const s of scenarios) {
    const statuses = rows
      .filter((r) => r.agent === candidate && r.scenario === s.id)
      .map((r) => r.status)
    const gradedMust = s.priority === 'must' ? gradeMustAttempts(statuses) : undefined
    if (gradedMust?.flaky) flaky.push(s.id)
    const candidatePasses = gradedMust
      ? gradedMust.status === 'pass'
      : statuses.some((r) => r === 'pass')
    const issue = PENDING_MUSTS[s.id]
    if (issue && !candidatePasses) pendingMusts.push(`${s.id} (#${issue})`)
    else if (s.priority === 'must' && !candidatePasses) reasons.push(`Candidate must pass ${s.id}`)
    if (s.baseline && baseline[s.id] === 'pass' && !candidatePasses)
      reasons.push(`Baseline regression: ${s.id}`)
  }
  return { eligible: reasons.length === 0, reasons, pendingMusts, flaky }
}
