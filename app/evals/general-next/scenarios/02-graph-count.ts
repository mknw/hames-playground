import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '02-graph-count',
  title: 'Read the knowledge graph',
  priority: 'must',
  baseline: true,
  p4: false,
  messages: ['How many Project nodes are in the knowledge graph?'],
  expectedTools: ['read_neo4j_cypher'],
  expectedRoutes: ['info-retrieval'],
  answerIncludes: ['42'],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
}
