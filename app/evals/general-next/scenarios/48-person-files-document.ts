import type { ConversationScenario } from '../types'

// #1032: one route's result feeds the next, three times over. The graph names
// the person, the office route searches their files by that name, and the
// documents route reads the plan the files point at. The two facts the answer
// needs sit past the first 200 characters of the plan, where the compact route
// record's excerpt stops, so they reach the answer writer only when it reads the
// route's complete trace. Invented people, files and dates only.
const PLAN = [
  '# Lantern rollout plan',
  '',
  'This plan describes how the Lantern service moves from the pilot group to every',
  'team. It covers the order of the waves, who signs off each wave, and what we',
  'watch during the first week. Read the risk register alongside it.',
  '',
  '## Dates and owners',
  '',
  'Go-live: 2031-02-17. Wave one starts the Monday before.',
  'Budget owner: Tomas Reyes. Questions about spend go to the budget owner.',
].join('\n')

export const scenario: ConversationScenario = {
  id: '48-person-files-document',
  title: 'A person from the graph, their files, then the document they point to',
  priority: 'should',
  baseline: false,
  p4: false,
  messages: [
    'Who is the rollout lead for Project Lantern in the knowledge graph? Search my OneDrive for files from that person, then read the rollout plan among them in my uploaded documents and tell me its go-live date and budget owner.',
  ],
  expectedTools: ['read_neo4j_cypher', 'graph_files_search'],
  expectedArgs: {
    read_neo4j_cypher: (a) => typeof a.query === 'string' && a.query.trim().length > 0,
    // The person the graph returned is what the files are searched by.
    graph_files_search: (a) => typeof a.query === 'string' && /varga/i.test(a.query),
  },
  expectedRoutes: ['info-retrieval', 'office-data', 'read-documents'],
  answerIncludes: ['Ines Varga', 'lantern-rollout-plan.md', '2031-02-17', 'Tomas Reyes'],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  toolData: {
    read_neo4j_cypher: [
      { name: 'Ines Varga', role: 'Rollout lead', project: 'Lantern', team: 'Platform' },
    ],
    graph_files_search: [
      { name: 'lantern-rollout-plan.md', sharedBy: 'Ines Varga', lastModified: '2030-11-02' },
      { name: 'lantern-risk-register.xlsx', sharedBy: 'Ines Varga', lastModified: '2030-10-21' },
    ],
  },
  uploads: { 'lantern-rollout-plan.md': PLAN },
  scriptedArgs: {
    read_neo4j_cypher: {
      query:
        "MATCH (p:Person)-[:WORKS_ON]->(:Project {name: 'Lantern'}) RETURN p.name AS name, p.role AS role",
    },
    graph_files_search: { query: 'Ines Varga' },
  },
  answerFromPrompt: true,
}
