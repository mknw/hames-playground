import { catalogueChecks } from '../catalogue-checks'
import type { ConversationScenario } from '../types'

// #1058, the graph half: with Project nodes in the knowledge graph (what the
// org-knowledge hook writes when it is on and the person accepts), a projects
// question is answered from the graph alone — no office route, no web, and none of
// the release turn's deflections ("no dedicated Project node… consult internal
// documentation"). Invented project names only.
export const scenario: ConversationScenario = {
  id: '50-org-projects-in-graph',
  title: 'With Project nodes in the graph, a projects question is answered from the graph',
  priority: 'should',
  baseline: false,
  p4: false,
  messages: ['What projects are active at Lantern in the knowledge graph?'],
  expectedTools: ['read_neo4j_cypher'],
  expectedArgs: {
    read_neo4j_cypher: (a) => /project/i.test(String(a.query ?? '')),
  },
  expectedRoutes: ['info-retrieval'],
  answerIncludes: ['Lantern Portal', 'Lantern Field Ops', 'Lantern Beacon'],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  toolData: {
    read_neo4j_cypher: [
      { name: 'Lantern Portal' },
      { name: 'Lantern Field Ops' },
      { name: 'Lantern Beacon' },
    ],
  },
  scriptedArgs: {
    read_neo4j_cypher: { query: 'MATCH (p:Project) RETURN p.name AS name' },
  },
  answerFromPrompt: true,
  // The catalogue's answerNotMatches fails a live answer that reports no Project
  // node or defers the user to internal documentation while the graph rows above
  // name three.
  ...catalogueChecks('50-org-projects-in-graph'),
}
