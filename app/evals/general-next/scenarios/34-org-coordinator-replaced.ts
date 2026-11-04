import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// Hermetic: the gate and the draft are scripted; a pass proves the plumbing, never the gate.
export const scenario: ConversationScenario = {
  id: '34-org-coordinator-replaced',
  title: 'A new coordinator replaces the old one',
  priority: 'should',
  baseline: false,
  p4: false,
  org: {
    seed: ['members', 'theme-1'],
    turns: [
      {
        answer: 'add',
        model: {
          gate: 'add_to_organizational_kg',
          draft: JSON.stringify({
            assertions: [
              {
                nodes: [
                  {
                    ref: 'm',
                    label: 'Member',
                    properties: { displayName: 'Tamsin Orrin' },
                    evidence: 'Tamsin Orrin',
                  },
                  {
                    ref: 't',
                    label: 'Theme',
                    properties: { name: 'Theme 1' },
                    evidence: 'coordinator of Theme 1',
                  },
                ],
                edges: [
                  {
                    type: 'COORDINATES',
                    from: 'm',
                    to: 't',
                    evidence: 'Tamsin Orrin has taken over as coordinator of Theme 1',
                  },
                ],
              },
            ],
          }),
        },
      },
    ],
  },
  messages: ['Tamsin Orrin has taken over as coordinator of Theme 1.'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  ...catalogueChecks('34-org-coordinator-replaced'),
}
