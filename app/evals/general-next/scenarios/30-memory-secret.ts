import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// A credential is never memory. Hermetic: the scripted gate marks it sensitive and the
// extractor would have copied it verbatim — the sensitive stop must come first.
export const scenario: ConversationScenario = {
  id: '30-memory-secret',
  title: 'A secret stores nothing',
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
            sensitive: 'sensitive',
          },
          extract: [
            {
              kind: 'semantic',
              content: 'The build server token is bld-7731-fake-token.',
              evidence: 'My build server token is bld-7731-fake-token',
            },
          ],
        },
      },
    ],
  },
  messages: ['My build server token is bld-7731-fake-token; keep it handy for next time.'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  ...catalogueChecks('30-memory-secret'),
}
