import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// Hermetic: a pass proves the plumbing that stops the hook here, never the gate.
export const scenario: ConversationScenario = {
  id: '40-org-office-trivia',
  title: 'Office trivia proposes nothing',
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
                    ref: 'r',
                    label: 'Resource',
                    properties: { name: 'coffee machine', kind: 'tool' },
                    evidence: 'The coffee machine',
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
  messages: ['The coffee machine on the third floor is broken again.'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  ...catalogueChecks('40-org-office-trivia'),
}
