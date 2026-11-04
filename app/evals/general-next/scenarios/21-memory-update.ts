import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// The remembered preference changes; the merge question calls it a newer version, and the
// saved item replaces that memory's text in place.
export const scenario: ConversationScenario = {
  id: '21-memory-update',
  title: 'A changed preference updates the memory it replaces',
  priority: 'should',
  baseline: false,
  p4: false,
  memory: {
    enabled: true,
    seed: ['notes'],
    turns: [
      {
        answer: 'save',
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
  messages: ['Change of plan: I now want my meeting notes as short numbered points.'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  ...catalogueChecks('21-memory-update'),
}
