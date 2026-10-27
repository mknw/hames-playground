import type { ConversationScenario, ConversationResult } from './conversation'
import { GENERAL_BASELINE, type BaselineStatus } from './general-baseline'

/**
 * Existing musts whose acceptance run is still pending, with the tracking issue
 * (owner ruling 2026-10-27, #808–#810). The flip gate does not block the flip on
 * a pending must: it lists it in the report instead. The pin in flip-gate.test.ts
 * keeps this record in step with the scenario modules' `pendingMustIssue` — a
 * module that gains or loses the flag without this record, or the other way
 * round, reddens there. A pending must that loses its `must` priority reddens too.
 */
export const PENDING_MUSTS: Readonly<Record<string, number>> = {
  '07-follow-up-success': 808,
  '08-follow-up-failure': 809,
  '14-analysis-index-follow-up': 810,
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
): { eligible: boolean; reasons: string[]; pendingMusts: string[] } {
  const reasons: string[] = []
  const pendingMusts: string[] = []
  if (!live) reasons.push('Live evidence is required')
  if (!selectionComplete) reasons.push('Scenario selection is incomplete')
  for (const s of scenarios) {
    const candidatePasses = rows.some(
      (r) => r.agent === candidate && r.scenario === s.id && r.status === 'pass',
    )
    const issue = PENDING_MUSTS[s.id]
    if (issue && !candidatePasses) pendingMusts.push(`${s.id} (#${issue})`)
    else if (s.priority === 'must' && !candidatePasses) reasons.push(`Candidate must pass ${s.id}`)
    if (s.baseline && baseline[s.id] === 'pass' && !candidatePasses)
      reasons.push(`Baseline regression: ${s.id}`)
  }
  return { eligible: reasons.length === 0, reasons, pendingMusts }
}
