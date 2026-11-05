import type { ConversationScenario } from '../types'

// #1006 — one resolved intent per turn, shaped like the owner's recorded real
// failure: turn 1 looks for documents with the office route; turn 2 is the
// back-reference ("try again with the sandbox route, this time …") that names
// the two kinds it now wants. The graders assert that turn 2's decision
// dispatches `office-data` (not `read-documents`), and that the resolved
// intent — the compact-intent brief, the decide state's heading, the actor's
// task and the critic's judgement target — names both kinds. Invented fixtures
// only; no company data.
export const scenario: ConversationScenario = {
  id: '46-retry-different-target',
  title: 'A follow-up that re-points the same search at two new targets',
  priority: 'should',
  baseline: false,
  p4: false,
  messages: [
    'Look through my documents for the quarterly numbers.',
    'Try again with the sandbox route, this time to find which documents are the budget summaries and which are the budget forecasts.',
  ],
  expectedTools: ['graph_files_search'],
  // The fixture actor searches with plain words over the two kinds.
  expectedArgs: { graph_files_search: (args) => /budget/i.test(String(args.query ?? '')) },
  expectedRoutes: ['office-data'],
  answerIncludes: ['budget summaries', 'budget forecasts'],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  intentExpect: {
    turn: 2,
    brief:
      'Search the conversation documents again with the office sandbox route, this time to find which documents are the budget summaries and which are the budget forecasts.',
    includes: ['budget summaries', 'budget forecasts'],
    route: 'office-data',
  },
}
