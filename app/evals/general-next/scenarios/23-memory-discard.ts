import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// The store step proposes the stated preference and the person answers "Don't save".
export const scenario: ConversationScenario = {
  id: '23-memory-discard',
  title: 'A discarded proposal stores nothing',
  priority: 'should',
  baseline: false,
  p4: false,
  memory: {
    enabled: true,
    seed: [],
    turns: [
      {
        answer: 'discard',
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
              content: 'The user likes meeting notes as short bullet points.',
              evidence: 'I like my meeting notes as short bullet points',
            },
          ],
        },
      },
    ],
  },
  messages: ['Note for later: I like my meeting notes as short bullet points.'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  ...catalogueChecks('23-memory-discard'),
}
