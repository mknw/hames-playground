import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// A colleague's preference is not the user's memory. Hermetic: the scripted gate files it
// under the organisation, which has no writer, and the extractor would have kept it.
export const scenario: ConversationScenario = {
  id: '31-memory-third-person',
  title: 'A fact about someone else stores nothing',
  priority: 'should',
  baseline: false,
  p4: false,
  memory: {
    enabled: true,
    seed: ['lantern'],
    turns: [
      {
        model: {
          gate: {
            target: 'organizational_graph',
            confirm: 'ask',
            kind: 'semantic',
            sensitive: 'ordinary',
          },
          extract: [
            {
              kind: 'semantic',
              content: 'Colleague Juno Larkspur likes meeting notes as numbered lists.',
              evidence: 'My colleague Juno Larkspur likes her meeting notes as numbered lists',
            },
          ],
        },
      },
    ],
  },
  messages: ['My colleague Juno Larkspur likes her meeting notes as numbered lists.'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  ...catalogueChecks('31-memory-third-person'),
}
