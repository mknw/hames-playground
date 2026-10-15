import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '03-web-read',
  title: 'Search, then read a source',
  priority: 'must',
  baseline: true,
  p4: false,
  messages: ['Find the Lantern release notes and read the page. What changed in version 2?'],
  expectedTools: ['search', 'fetch'],
  expectedArgs: {
    search: (a) => /Lantern/i.test(String(a.query)),
    fetch: (a) => a.url === 'https://example.invalid/lantern',
  },
  expectedRoutes: ['info-retrieval'],
  answerIncludes: ['CSV', 'https://example.invalid/lantern'],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
}
