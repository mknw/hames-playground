import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '03-web-read',
  title: 'Search, then read a source',
  priority: 'must',
  baseline: true,
  p4: false,
  // A POPULAR package (#775): the seeded lantern-notes.md stays as a present-but-wrong
  // LOCAL decoy — it must not match the ask, or the router reads the ask as answerable
  // from uploaded documents and read-documents outroutes the web route again.
  messages: ['Find the Next.js release notes and read the page. What changed in version 15.5?'],
  expectedTools: ['search', 'fetch'],
  expectedArgs: {
    search: (a) => /Next\.js/i.test(String(a.query)),
    fetch: (a) => a.url === 'https://example.invalid/nextjs',
  },
  expectedRoutes: ['info-retrieval'],
  answerIncludes: ['Turbopack', 'https://example.invalid/nextjs'],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
}
