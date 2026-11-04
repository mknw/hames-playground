import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// The reply guesses a fact about the user that the user never stated. Hermetic: the scripted
// gate and extractor take the guess, so the evidence rule (and identifier closure) must stop it.
export const scenario: ConversationScenario = {
  id: '29-memory-assistant-fact',
  title: 'A fact only the assistant said stores nothing',
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
            target: 'personal_memory',
            confirm: 'ask',
            kind: 'semantic',
            sensitive: 'ordinary',
          },
          extract: [
            {
              kind: 'semantic',
              content: 'The user works from Ghent.',
              evidence: 'you work from Ghent',
            },
          ],
          reply: "I'd guess you work from Ghent.",
        },
      },
    ],
  },
  messages: ['Guess which city I work from — just pick one.'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  ...catalogueChecks('29-memory-assistant-fact'),
}
