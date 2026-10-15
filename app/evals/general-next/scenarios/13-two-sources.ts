import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '13-two-sources',
  title: 'Combine the knowledge graph and uploaded notes',
  priority: 'must',
  baseline: false,
  p4: false,
  messages: [
    'Compare the Project count in the knowledge graph with the target count in lantern-notes.md. How far apart are they? Cite the notes.',
  ],
  expectedTools: ['read_neo4j_cypher'],
  expectedRoutes: ['info-retrieval', 'read-documents'],
  answerIncludes: ['8'],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  citation: 'lantern-notes.md',
}
