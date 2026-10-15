import type { ConversationScenario, ConversationResult } from './conversation'

export function flipGate(
  live: boolean,
  selectionComplete: boolean,
  candidate: string,
  scenarios: ConversationScenario[],
  rows: ConversationResult[],
) {
  const reasons: string[] = []
  if (!live) reasons.push('Live evidence is required')
  if (!selectionComplete) reasons.push('Scenario selection is incomplete')
  if (candidate === 'general') reasons.push('A distinct candidate is required')
  for (const s of scenarios) {
    const candidatePasses = rows.some(
      (r) => r.agent === candidate && r.scenario === s.id && r.status === 'pass',
    )
    if (s.priority === 'must' && !candidatePasses) reasons.push(`Candidate must pass ${s.id}`)
    if (
      s.baseline &&
      rows.some((r) => r.agent === 'general' && r.scenario === s.id && r.status === 'pass') &&
      !candidatePasses
    )
      reasons.push(`Baseline regression: ${s.id}`)
  }
  return { eligible: reasons.length === 0, reasons }
}
