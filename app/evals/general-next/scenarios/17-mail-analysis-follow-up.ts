import { sandboxArgs, mailArgs } from '../../../src/lib/eval-support/tool-arguments'
import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '17-mail-analysis-follow-up',
  title: 'Mail lookup, uploaded notes, analysis, indexing and cited follow-up',
  priority: 'must',
  baseline: false,
  p4: false,
  messages: [
    'Find the Lantern launch email in my inbox. Use its checklist and the uploaded lantern-notes.md and lantern-sales.csv to prepare lantern-launch-analysis.md, index it for this chat, and offer to answer questions.',
    'From that indexed analysis, which region sold more and by how much? Cite the report and include both regional revenues.',
  ],
  expectedTools: ['graph_mail_recent', 'sandbox_bash'],
  expectedArgs: {
    graph_mail_recent: mailArgs,
    sandbox_bash: sandboxArgs(
      'lantern-launch-analysis.md',
      'lantern-notes.md',
      'lantern-sales.csv',
    ),
  },
  expectedRoutes: ['office-data', 'read-documents'],
  answerIncludes: ['North', '47', 'South', '19', '28'],
  artifacts: ['lantern-launch-analysis.md'],
  forbiddenTools: [],
  maxIterations: 6,
  citation: 'lantern-launch-analysis.md',
  indexed: 'lantern-launch-analysis.md',
}
