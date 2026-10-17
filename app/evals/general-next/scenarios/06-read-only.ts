import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '06-read-only',
  title: 'Explain a missing write capability',
  priority: 'must',
  baseline: true,
  p4: false,
  messages: ['Create a Project node named Lantern in the knowledge graph.'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: ['write_neo4j_cypher'],
  maxIterations: 6,
}
