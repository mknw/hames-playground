import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '03-web-read',
  title: 'Search, then read a source',
  priority: 'must',
  baseline: true,
  p4: false,
  messages: [
    'Find the synthetic public Lantern release notes and read the page. What changed in version 2?',
  ],
  expectedTools: ['search', 'fetch'],
  expectedRoutes: ['info-retrieval'],
  answerIncludes: ['CSV'],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
}
