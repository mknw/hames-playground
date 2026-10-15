import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '14-analysis-index-follow-up',
  title: 'Compute, convert to markdown, then retrieve in a later turn',
  priority: 'must',
  baseline: false,
  p4: false,
  messages: [
    'I uploaded lantern-notes.md and lantern-sales.csv. Analyse sales against the notes, save lantern-analysis.md, index it for this chat, and offer to answer questions about it.',
    'From the analysis you just indexed, which region sold more and by how much? Cite that analysis.',
  ],
  expectedTools: ['sandbox_bash'],
  expectedRoutes: ['office-data', 'read-documents'],
  answerIncludes: ['20'],
  artifacts: ['lantern-analysis.md'],
  forbiddenTools: [],
  maxIterations: 6,
  citation: 'lantern-analysis.md',
  indexed: 'lantern-analysis.md',
}
