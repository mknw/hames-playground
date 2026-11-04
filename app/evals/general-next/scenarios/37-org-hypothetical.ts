import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// Hermetic: a pass proves the plumbing that stops the hook here, never the gate.
export const scenario: ConversationScenario = {
  id: '37-org-hypothetical',
  title: 'A hypothetical proposes nothing',
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
                    ref: 'c',
                    label: 'Partner',
                    properties: { name: 'Calder & Vos Ltd' },
                    evidence: 'Calder & Vos Ltd',
                  },
                  {
                    ref: 'o',
                    label: 'Project',
                    properties: { name: 'Osprey' },
                    evidence: 'the Osprey deadline',
                  },
                ],
                edges: [
                  {
                    type: 'PARTNERS_ON',
                    from: 'c',
                    to: 'o',
                    evidence: 'partnered with Calder & Vos Ltd',
                  },
                ],
              },
            ],
          }),
        },
      },
    ],
  },
  messages: ['If we partnered with Calder & Vos Ltd, the Osprey deadline could move to March.'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  ...catalogueChecks('37-org-hypothetical'),
}
