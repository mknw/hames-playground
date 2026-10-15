import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '01-greeting',
  title: 'A short answer without tools',
  priority: 'must',
  baseline: true,
  p4: false,
  messages: ['Hi! What can you help me with?'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  noTools: true,
}
