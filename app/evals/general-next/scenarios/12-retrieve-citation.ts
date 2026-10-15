import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '12-retrieve-citation',
  title: 'Answer from an uploaded document with a locator',
  priority: 'must',
  baseline: false,
  p4: false,
  messages: [
    'According to the uploaded lantern-notes.md, what is the release date? Please cite the document.',
  ],
  expectedTools: [],
  expectedRoutes: ['read-documents'],
  answerIncludes: ['2030-04-12'],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  citation: 'lantern-notes.md',
}
