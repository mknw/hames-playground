import { projectCountArgs } from '../../../src/lib/eval-support/tool-arguments'
import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '07-follow-up-success',
  title: 'Refer back to a successful turn',
  priority: 'should',
  pendingMustIssue: 808,
  baseline: true,
  p4: false,
  messages: [
    'How many Project nodes are in the knowledge graph?',
    'Who is involved in the three projects with the most people working on them?',
  ],
  expectedTools: ['read_neo4j_cypher'],
  expectedArgs: { read_neo4j_cypher: projectCountArgs },
  expectedRoutes: ['info-retrieval'],
  // The people working on the three projects with the most WORKS_ON people (Dune 3,
  // Birch 2, Cedar 2; rank-4 Ember has 1), in the fixture's first-appearance order.
  answerIncludes: ['Zenith', 'Nadir', 'Apogee', 'Perigee', 'Azimuth', 'Meridian', 'Solstice'],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  turnAnswerIncludes: [
    ['42'],
    ['Zenith', 'Nadir', 'Apogee', 'Perigee', 'Azimuth', 'Meridian', 'Solstice'],
  ],
}
