import { sandboxArgs } from '../../../src/lib/eval-support/tool-arguments'
import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '15-graph-file-summary',
  title: 'Graph file to sandbox summary',
  priority: 'should',
  baseline: false,
  p4: true,
  messages: [
    'Find lantern-brief.docx in my OneDrive, read it, and write lantern-brief-summary.docx.',
  ],
  expectedTools: ['graph_files_search', 'graph_file_ingest', 'sandbox_bash'],
  expectedArgs: {
    graph_files_search: (a) => typeof a.query === 'string' && /Lantern/i.test(a.query),
    graph_file_ingest: (a) => typeof a.item_id === 'string' && a.item_id.trim().length > 0,
    sandbox_bash: sandboxArgs('lantern-brief-summary.docx'),
  },
  expectedRoutes: ['office-data'],
  answerIncludes: ['lantern-brief-summary.docx'],
  artifacts: ['lantern-brief-summary.docx'],
  forbiddenTools: [],
  maxIterations: 6,
}
