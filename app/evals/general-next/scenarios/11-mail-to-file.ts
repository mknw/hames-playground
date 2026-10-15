import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '11-mail-to-file',
  title: 'Find synthetic mail, then create a document',
  priority: 'must',
  baseline: false,
  p4: false,
  messages: [
    'Find the synthetic Lantern launch email in my fixture mailbox. Turn its checklist into lantern-launch.md and give me the file.',
  ],
  expectedTools: ['graph_mail_recent', 'sandbox_bash'],
  expectedRoutes: ['office-data'],
  answerIncludes: ['lantern-launch.md'],
  artifacts: ['lantern-launch.md'],
  forbiddenTools: [],
  maxIterations: 6,
}
