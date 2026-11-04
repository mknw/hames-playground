import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// A "what if" is not a fact about the person, though its words are verbatim in the message.
export const scenario: ConversationScenario = {
  id: '27-memory-hypothetical',
  title: 'A hypothetical stores nothing',
  priority: 'should',
  baseline: false,
  p4: false,
  memory: {
    enabled: true,
    seed: ['lantern'],
    turns: [
      {
        model: {
          extract: [
            {
              kind: 'episodic',
              content: 'The user switched to a four-day week.',
              evidence: 'I switched to a four-day week',
            },
          ],
        },
      },
    ],
  },
  messages: [
    'Hypothetically, if I switched to a four-day week, how would you split 32 hours from Monday to Thursday?',
  ],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  ...catalogueChecks('27-memory-hypothetical'),
}
