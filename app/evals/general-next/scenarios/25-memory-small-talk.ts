import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// Hermetic: the scripted gate says there is nothing to keep, and the extractor would have
// produced a candidate — the gate's `none` must stop the store before it is asked.
export const scenario: ConversationScenario = {
  id: '25-memory-small-talk',
  title: 'Small talk stores nothing',
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
              content: 'The user had a helpful conversation.',
              evidence: 'that was really helpful',
            },
          ],
        },
      },
    ],
  },
  messages: ['Thanks, that was really helpful — have a good evening!'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  ...catalogueChecks('25-memory-small-talk'),
}
