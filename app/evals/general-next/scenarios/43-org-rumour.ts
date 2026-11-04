import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// Hermetic: a pass proves the plumbing that stops the hook here, never the gate.
export const scenario: ConversationScenario = {
  id: '43-org-rumour',
  title: 'A rumour proposes nothing',
  priority: 'should',
  baseline: false,
  p4: false,
  org: {
    seed: ['osprey'],
    turns: [
      {
        model: {
          gate: 'no_organizational_knowledge',
          draft: JSON.stringify({
            assertions: [
              {
                nodes: [
                  {
                    ref: 'f',
                    label: 'Fact',
                    properties: { text: 'Project Osprey might be cancelled', kind: 'status' },
                    evidence: 'Project Osprey might be cancelled',
                  },
                  {
                    ref: 'o',
                    label: 'Project',
                    properties: { name: 'Osprey' },
                    evidence: 'Project Osprey',
                  },
                ],
                edges: [
                  {
                    type: 'ABOUT',
                    from: 'f',
                    to: 'o',
                    evidence: 'Project Osprey might be cancelled',
                  },
                ],
              },
            ],
          }),
        },
      },
    ],
  },
  messages: ['I heard Project Osprey might be cancelled, not confirmed though.'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  ...catalogueChecks('43-org-rumour'),
}
