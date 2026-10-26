import { projectCountArgs } from '../../../src/lib/eval-support/tool-arguments'
import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '07-follow-up-success',
  title: 'Refer back to a successful turn',
  priority: 'must',
  baseline: true,
  p4: false,
  messages: [
    'How many Project nodes are in the knowledge graph?',
    'Who is involved in the three most popular?',
  ],
  expectedTools: ['read_neo4j_cypher'],
  expectedArgs: { read_neo4j_cypher: projectCountArgs },
  expectedRoutes: ['info-retrieval'],
  answerIncludes: ['Mira', 'Theo', 'Priya', 'Sana'],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  turnAnswerIncludes: [['42'], ['Mira', 'Theo', 'Priya', 'Sana']],
}
