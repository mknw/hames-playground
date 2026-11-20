import { catalogueChecks } from '../catalogue-checks'
import type { ConversationScenario } from '../types'

// #1058 r2 (review): the projects rule is scoped to the user's OWN organisation
// (the decide question and the info controller both say so), so a PUBLIC
// organisation's projects — "What projects does Mozilla run?" — are a web
// question: info-retrieval and the public web, never the office route's files
// before them. r3 (review): "never the office route's files first" is graded,
// not only claimed — the row's toolsNotBefore (read below from the catalogue
// row) fails a live run that reaches graph_files_search/list/recent before the
// web search, the mirror of 49's web-last rule; orderedTools alone could not
// grade it (a subsequence check passes either order). The row rides the P4 gate
// like 15/16 (the catalogue's one listed-but-never-run mechanism) because its
// graded facts are live web content: reported GATED, never as passing, until a
// coordinated live run flips it.
export const scenario: ConversationScenario = {
  id: '51-org-projects-public-org',
  title: 'Another organisation’s projects are a web question',
  priority: 'should',
  baseline: false,
  p4: true,
  messages: ['What projects does Mozilla run?'],
  expectedTools: ['search'],
  expectedArgs: {
    search: (a) => /mozilla/i.test(String(a.query ?? '')),
  },
  expectedRoutes: ['info-retrieval'],
  answerIncludes: ['Firefox'],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  // r3: the catalogue row's toolsNotBefore — no office files tool before the web
  // search — so a live run proves the scoping the row exists for.
  ...catalogueChecks('51-org-projects-public-org'),
}
