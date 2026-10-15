import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '04-library-docs',
  title: 'Resolve a library before reading its docs',
  priority: 'should',
  baseline: true,
  p4: false,
  messages: ['Find the SolidJS createSignal docs and show me a tiny counter example.'],
  expectedTools: ['resolve-library-id', 'get-library-docs'],
  expectedRoutes: ['info-retrieval'],
  answerIncludes: ['createSignal'],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
}
