import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// As 21, but another writer changes the memory between the proposal and the answer: the
// approval must not overwrite the newer text, and nothing is written.
export const scenario: ConversationScenario = {
  id: '22-memory-stale',
  title: 'A memory changed underneath its preview is refused as stale',
  priority: 'should',
  baseline: false,
  p4: false,
  memory: {
    enabled: true,
    seed: ['notes'],
    turns: [
      {
        answer: 'save',
        changeBeforeAnswer: {
          seed: 'notes',
          content: 'The user likes meeting notes as one short paragraph.',
        },
        model: {
          gate: {
            target: 'personal_memory',
            confirm: 'ask',
            kind: 'preference',
            sensitive: 'ordinary',
          },
          extract: [
            {
              kind: 'preference',
              content: 'The user now likes meeting notes as short numbered points.',
              evidence: 'I now want my meeting notes as short numbered points',
            },
          ],
          merge: 'update',
        },
      },
    ],
  },
  messages: ['Actually, I now want my meeting notes as short numbered points.'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  ...catalogueChecks('22-memory-stale'),
}
