import { catalogueChecks } from '../catalogue-checks'
import type { ConversationScenario } from '../types'

// #1032, redesigned on the coordinator's scenario ruling: the real task is "find a
// person, then the documents that person shared with me, and give me the links".
// The person exists only in the graph; what they shared exists only behind the
// office route (`graph_files_shared`, each item with its link, in the real tool's
// shape). The answer must name the right files with their links and must not name a
// file someone else shared — one of those has a near-identical title. The shared
// list is the unfiltered "shared with me" list a real tenant returns, newest first:
// read without the sharer filter, the person's files sit past the first 2 000
// characters, where the route's compact record stops. Invented people, files and
// links only.
const LINK = (file: string) => `https://lantern.sharepoint.example.org/sites/lantern/${file}`
const item = (name: string, sharedBy: string, sharedWhen: string, n: number) => ({
  name,
  kind: 'file',
  shared_by: sharedBy,
  shared_when: sharedWhen,
  how: 'Link',
  via: 'link',
  drive_id: 'b!synthetic-lantern-drive',
  item_id: `synthetic-item-${n}`,
  webUrl: LINK(name),
})

export const scenario: ConversationScenario = {
  id: '48-person-files-document',
  title: 'A person from the graph, then the files that person shared with me, with links',
  priority: 'should',
  baseline: false,
  p4: false,
  messages: [
    'Who leads the Lantern rollout according to the knowledge graph? Find the documents that person shared with me and give me their links.',
  ],
  expectedTools: ['graph_files_shared'],
  expectedArgs: {
    // Unfiltered, or filtered to the person the graph returned: never someone else.
    graph_files_shared: (a) => a.shared_by === undefined || /varga/i.test(String(a.shared_by)),
  },
  expectedRoutes: ['info-retrieval', 'office-data'],
  answerIncludes: [
    'Ines Varga',
    'lantern-rollout-plan.docx',
    'https://lantern.sharepoint.example.org/sites/lantern/lantern-rollout-plan.docx',
    'lantern-wave-schedule.xlsx',
    'https://lantern.sharepoint.example.org/sites/lantern/lantern-wave-schedule.xlsx',
  ],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  toolData: {
    read_neo4j_cypher: [
      {
        name: 'Ines Varga',
        email: 'ines.varga@example.org',
        role: 'Rollout lead',
        project: 'Lantern',
      },
    ],
    graph_files_shared: {
      items: [
        item('q4-hiring-plan.xlsx', 'Mira Cedar', '2030-11-07T16:02:00Z', 1),
        item('lantern-rollout-plan-draft.docx', 'Oren Vale', '2030-11-07T09:40:00Z', 2),
        item('team-offsite-agenda.docx', 'Tamsin Orrin', '2030-11-06T14:15:00Z', 3),
        item('vendor-shortlist.xlsx', 'Oren Vale', '2030-11-06T08:30:00Z', 4),
        item('lantern-risk-register.xlsx', 'Mira Cedar', '2030-11-05T17:20:00Z', 5),
        item('brand-guidelines.pdf', 'Tamsin Orrin', '2030-11-05T11:05:00Z', 6),
        item('support-rota.xlsx', 'Oren Vale', '2030-11-04T15:45:00Z', 7),
        item('lantern-wave-schedule.xlsx', 'Ines Varga', '2030-11-04T10:12:00Z', 8),
        item('quarterly-review.pptx', 'Mira Cedar', '2030-11-03T13:30:00Z', 9),
        item('lantern-rollout-plan.docx', 'Ines Varga', '2030-11-02T09:00:00Z', 10),
        item('security-checklist.docx', 'Tamsin Orrin', '2030-11-01T16:40:00Z', 11),
      ],
    },
  },
  scriptedArgs: {
    read_neo4j_cypher: {
      query:
        "MATCH (p:Person)-[:WORKS_ON]->(:Project {name: 'Lantern'}) RETURN p.name AS name, p.email AS email, p.role AS role",
    },
    graph_files_shared: { shared_by: 'Ines Varga' },
  },
  answerFromPrompt: true,
  // Not one file someone else shared, near-identical titles included.
  ...catalogueChecks('48-person-files-document'),
}
