import { projectCountArgs } from '../../../src/lib/eval-support/tool-arguments'
import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '08-follow-up-failure',
  title: 'Retry after an explicitly failed turn',
  priority: 'should',
  pendingMustIssue: 809,
  baseline: false,
  p4: false,
  messages: [
    'Count the Project nodes in the knowledge graph.',
    'That failed earlier. Please try the same count again now.',
  ],
  expectedTools: ['read_neo4j_cypher'],
  expectedArgs: { read_neo4j_cypher: projectCountArgs },
  expectedRoutes: ['info-retrieval'],
  answerIncludes: ['42'],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  failFirstTurn: true,
}
