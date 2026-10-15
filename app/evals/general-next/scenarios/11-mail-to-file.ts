import { sandboxArgs, mailArgs } from '../../../src/lib/eval-support/tool-arguments'
import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '11-mail-to-file',
  title: 'Find synthetic mail, then create a document',
  priority: 'must',
  baseline: false,
  p4: false,
  messages: [
    'Find the Lantern launch email in my inbox. Turn its checklist into lantern-launch.md and give me the file.',
  ],
  expectedTools: ['graph_mail_recent', 'sandbox_bash'],
  expectedArgs: {
    sandbox_bash: sandboxArgs(['lantern-launch.md']),
    graph_mail_recent: mailArgs,
  },
  expectedRoutes: ['office-data'],
  answerIncludes: ['lantern-launch.md', 'CSV'],
  artifacts: ['lantern-launch.md'],
  forbiddenTools: [],
  maxIterations: 6,
}
