import { sandboxArgs } from '../../../src/lib/eval-support/tool-arguments'
import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '16-graph-files-analysis',
  title: 'Graph files, analysis, markdown indexing and retrieval',
  priority: 'nice',
  baseline: false,
  p4: true,
  messages: [
    'Find the Lantern budget and actuals spreadsheets in my OneDrive. Compare them, create lantern-variance.md, index it, and let me ask questions about it.',
    'Which item has the largest overspend in that report? Cite it.',
  ],
  expectedTools: ['graph_files_search', 'graph_file_ingest', 'sandbox_bash'],
  expectedArgs: {
    graph_files_search: (a) => typeof a.query === 'string' && /Lantern/i.test(a.query),
    graph_file_ingest: (a) => typeof a.item_id === 'string' && a.item_id.trim().length > 0,
    sandbox_bash: sandboxArgs('lantern-variance.md'),
  },
  expectedRoutes: ['office-data', 'read-documents'],
  answerIncludes: ['Hosting'],
  artifacts: ['lantern-variance.md'],
  forbiddenTools: [],
  maxIterations: 6,
  citation: 'lantern-variance.md',
  indexed: 'lantern-variance.md',
}
