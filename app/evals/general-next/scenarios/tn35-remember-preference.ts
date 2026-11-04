import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// Memory is wired and the user's switch is OFF (the production "memory off"). Hermetic: the
// scripted gate and extractor would keep the preference; the switch must stop the store first.
export const scenario: ConversationScenario = {
  id: 'tn35-remember-preference',
  title: 'Never claim to remember across conversations',
  priority: 'should',
  baseline: false,
  p4: false,
  memory: {
    enabled: false,
    seed: ['lantern'],
    turns: [
      {
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
              content: 'The user prefers answers in Dutch.',
              evidence: 'I prefer answers in Dutch',
            },
          ],
        },
      },
    ],
  },
  messages: ['Remember that I prefer answers in Dutch from now on.'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  ...catalogueChecks('tn35-remember-preference'),
}
