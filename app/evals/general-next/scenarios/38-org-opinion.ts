import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// Hermetic: a pass proves the plumbing that stops the hook here, never the gate.
export const scenario: ConversationScenario = {
  id: '38-org-opinion',
  title: 'An opinion proposes nothing',
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
                    properties: {
                      text: 'Project Osprey is the best thing we’ve shipped this year',
                      kind: 'status',
                    },
                    evidence: 'Project Osprey is the best thing we’ve shipped this year',
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
                    evidence: 'Project Osprey is the best thing we’ve shipped this year',
                  },
                ],
              },
            ],
          }),
        },
      },
    ],
  },
  messages: ['Honestly, I think Project Osprey is the best thing we’ve shipped this year.'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  ...catalogueChecks('38-org-opinion'),
}
