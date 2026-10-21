import type { ConversationScenario, ConversationResult } from './conversation'
import { GENERAL_BASELINE, type BaselineStatus } from './general-baseline'

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
) {
  const reasons: string[] = []
  if (!live) reasons.push('Live evidence is required')
  if (!selectionComplete) reasons.push('Scenario selection is incomplete')
  for (const s of scenarios) {
    const candidatePasses = rows.some(
      (r) => r.agent === candidate && r.scenario === s.id && r.status === 'pass',
    )
    if (s.priority === 'must' && !candidatePasses) reasons.push(`Candidate must pass ${s.id}`)
    if (s.baseline && baseline[s.id] === 'pass' && !candidatePasses)
      reasons.push(`Baseline regression: ${s.id}`)
  }
  return { eligible: reasons.length === 0, reasons }
}
