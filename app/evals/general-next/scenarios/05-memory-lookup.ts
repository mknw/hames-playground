import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '05-memory-lookup',
  title: 'Read a named memory entity',
  priority: 'should',
  baseline: true,
  p4: false,
  messages: ['Look up the Lantern project in the memory graph. What is its release tag?'],
  expectedTools: ['search_nodes'],
  expectedArgs: { search_nodes: (a) => /Lantern/i.test(String(a.query)) },
  expectedRoutes: ['info-retrieval'],
  answerIncludes: ['LANTERN-2'],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
}
