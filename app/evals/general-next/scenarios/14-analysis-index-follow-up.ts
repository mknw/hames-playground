import { sandboxArgs } from '../../../src/lib/eval-support/tool-arguments'
import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '14-analysis-index-follow-up',
  title: 'Compute, convert to markdown, then retrieve in a later turn',
  // should (owner 2026-10-28: depends on sandbox-output ingestion, not yet verified)
  priority: 'should',
  baseline: false,
  p4: false,
  messages: [
    'I uploaded lantern-notes.md and lantern-sales.csv. Analyse sales against the notes, save lantern-analysis.md, index it for this chat, and offer to answer questions about it.',
    'From the analysis you just indexed, which region sold more and by how much? Cite that analysis.',
  ],
  expectedTools: ['sandbox_bash'],
  expectedArgs: {
    // Declared output first, then inputs; the notes may arrive through a `sandbox_read`
    // earlier in the turn (the run-6 shape) instead of being named by the script.
    sandbox_bash: sandboxArgs('lantern-analysis.md', 'lantern-notes.md', 'lantern-sales.csv'),
  },
  expectedRoutes: ['office-data', 'read-documents'],
  answerIncludes: ['North', '47', 'South', '19', '28'],
  artifacts: ['lantern-analysis.md'],
  forbiddenTools: [],
  maxIterations: 6,
  citation: 'lantern-analysis.md',
  indexed: 'lantern-analysis.md',
}
