import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '05-memory-lookup',
  title: 'Recall a confirmed per-user memory in a later turn',
  priority: 'should',
  baseline: true,
  p4: false,
  memory: true,
  messages: ['What do you remember about me?', 'Which release tag goes with that project?'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: ['LANTERN-2'],
  turnAnswerIncludes: [['Lantern'], ['LANTERN-2']],
  artifacts: [],
  forbiddenTools: [],
  noTools: true,
  maxIterations: 6,
}
