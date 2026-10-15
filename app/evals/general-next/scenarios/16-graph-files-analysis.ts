import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '16-graph-files-analysis',
  title: 'Graph files, analysis, markdown indexing and retrieval',
  priority: 'nice',
  baseline: false,
  p4: true,
  messages: [
    'Find the synthetic Lantern budget and actuals spreadsheets in my fixture drive. Compare them, create lantern-variance.md, index it, and let me ask questions about it.',
    'Which item has the largest overspend in that report? Cite it.',
  ],
  expectedTools: ['graph_files_search', 'graph_file_ingest', 'sandbox_bash'],
  expectedRoutes: ['office-data', 'read-documents'],
  answerIncludes: ['Hosting'],
  artifacts: ['lantern-variance.md'],
  forbiddenTools: [],
  maxIterations: 6,
  citation: 'lantern-variance.md',
  indexed: 'lantern-variance.md',
}
