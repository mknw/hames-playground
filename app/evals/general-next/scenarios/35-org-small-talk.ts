import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// Hermetic: a pass proves the plumbing that stops the hook here, never the gate.
export const scenario: ConversationScenario = {
  id: '35-org-small-talk',
  title: 'Small talk proposes nothing',
  priority: 'should',
  baseline: false,
  p4: false,
  org: {
    seed: ['members'],
    turns: [
      {
        model: {
          gate: 'no_organizational_knowledge',
          draft: JSON.stringify({
            assertions: [
              {
                nodes: [
                  {
                    ref: 'p',
                    label: 'Project',
                    properties: { name: 'Weekend' },
                    evidence: 'Ready for the weekend',
                  },
                ],
                edges: [],
              },
            ],
          }),
        },
      },
    ],
  },
  messages: ['Morning! Ready for the weekend?'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  ...catalogueChecks('35-org-small-talk'),
}
