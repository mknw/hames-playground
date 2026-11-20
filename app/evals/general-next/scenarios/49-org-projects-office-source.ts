import { catalogueChecks } from '../catalogue-checks'
import type { ConversationScenario } from '../types'

// #1058 (owner, on release): "The agent still has no notion of where to find
// projects!!!" — asked "What projects are active at <org>?" the release agent went
// to the public web and then answered "no dedicated Project node… consult internal
// DTSC documentation", while the graph it had just queried (the release graph holds
// only Member, Pillar and Theme; no `Project` node is ever written while the
// org-knowledge hook is off) is not where the organisation's projects live — its
// SharePoint and OneDrive files are, and office-data reads those.
//
// The scenario grades the decision path the fix teaches: the graph is queried first
// and holds no Project node; the office route then searches the organisation's own
// files and finds the project folders; no web tool runs before that files search
// (the catalogue row's toolsNotBefore, r2: a live run that goes graph → web → files
// fails it, and hermetically no web tool is scripted at all), and the answer names
// the projects the files search returned instead of deferring the user to
// "internal documentation".
//
// Invented fixtures only; the graph rows are the release shape's emptiness (no
// Project nodes), the file hits are the real graph_files_search result shape.
const LINK = (file: string) => `https://lantern.sharepoint.example.org/sites/projects/${file}`
const hit = (n: number, name: string, folder: string, snippet: string) => ({
  name,
  path: folder,
  site: 'https://lantern.sharepoint.example.org/sites/projects',
  modified: '2030-11-06T09:00:00Z',
  size: 1000 + n,
  drive_id: 'b!synthetic-lantern-drive',
  item_id: `synthetic-project-${n}`,
  webUrl: LINK(name),
  snippet,
})

export const scenario: ConversationScenario = {
  id: '49-org-projects-office-source',
  title: 'Projects live in the organisation’s own sources: graph first, then its files',
  priority: 'should',
  baseline: false,
  p4: false,
  messages: ['What projects are active at Lantern?'],
  expectedTools: ['read_neo4j_cypher', 'graph_files_search'],
  expectedArgs: {
    read_neo4j_cypher: (a) => /project/i.test(String(a.query ?? '')),
    graph_files_search: (a) => /project/i.test(String(a.query ?? '')),
  },
  expectedRoutes: ['info-retrieval', 'office-data'],
  answerIncludes: ['Lantern Portal', 'Lantern Field Ops'],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  toolData: {
    // The release graph's shape for a projects query: no Project node exists
    // (the org-knowledge hook is the only Project writer and it is off).
    read_neo4j_cypher: [],
    graph_files_search: {
      total: 2,
      results: [
        hit(
          1,
          'lantern-portal-status.docx',
          '/Projects/Portal',
          'The Lantern Portal project is active: platform workstream, status green, next review in December.',
        ),
        hit(
          2,
          'lantern-field-ops-plan.xlsx',
          '/Projects/Field Ops',
          'The Lantern Field Ops project is active: pilot with the North team running to March.',
        ),
      ],
    },
  },
  scriptedArgs: {
    read_neo4j_cypher: { query: 'MATCH (p:Project) RETURN p.name AS name' },
    graph_files_search: { query: 'project' },
  },
  answerFromPrompt: true,
  // A live answer that defers the user to "internal documentation" fails the
  // catalogue's answerNotMatches, and one that never reaches the office route's
  // results fails answerContains (the scripted writer names a fact only when its
  // prompt carries it).
  ...catalogueChecks('49-org-projects-office-source'),
}
