import type { ConversationScenario } from '../types'

// #1006, the retriever leg: turn 1 reads an uploaded document; turn 2 is a
// back-reference ("that same document") that only the earlier turn resolves.
// The graders assert that turn 2's decision dispatches `read-documents` and that
// the retriever's recorded query IS the turn's resolved intent (the recorded
// compact-intent brief), not the raw follow-up. Invented fixtures only.
export const scenario: ConversationScenario = {
  id: '47-follow-up-documents-query',
  title: 'A follow-up that searches the same uploaded document for another fact',
  priority: 'should',
  baseline: false,
  p4: false,
  messages: [
    'According to the uploaded lantern-notes.md, what is the release date?',
    'And what does that same document say about the hosting overspend?',
  ],
  expectedTools: [],
  expectedRoutes: ['read-documents'],
  answerIncludes: ['hosting overspend', '5'],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  intentExpect: {
    turn: 2,
    brief: 'Find what the uploaded lantern-notes.md says about the hosting overspend.',
    includes: ['lantern-notes.md', 'hosting overspend'],
    route: 'read-documents',
    retriever: true,
  },
}
