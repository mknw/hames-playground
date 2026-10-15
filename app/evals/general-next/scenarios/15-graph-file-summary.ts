import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '15-graph-file-summary',
  title: 'Graph file to sandbox summary',
  priority: 'should',
  baseline: false,
  p4: true,
  messages: [
    'Find lantern-brief.docx in my synthetic OneDrive fixtures, read it, and write lantern-brief-summary.docx.',
  ],
  expectedTools: ['graph_files_search', 'graph_file_ingest', 'sandbox_bash'],
  expectedRoutes: ['office-data'],
  answerIncludes: ['lantern-brief-summary.docx'],
  artifacts: ['lantern-brief-summary.docx'],
  forbiddenTools: [],
  maxIterations: 6,
}
