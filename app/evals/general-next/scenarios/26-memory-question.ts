import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// A request for an explanation says nothing about the person.
export const scenario: ConversationScenario = {
  id: '26-memory-question',
  title: 'A question stores nothing',
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
              kind: 'semantic',
              content: 'The user wants to know what a sprint retrospective is.',
              evidence: 'explain what a sprint retrospective is',
            },
          ],
        },
      },
    ],
  },
  messages: ['Can you explain what a sprint retrospective is?'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  ...catalogueChecks('26-memory-question'),
}
