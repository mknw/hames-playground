import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// Hermetic: a pass proves the plumbing that stops the hook here, never the gate.
export const scenario: ConversationScenario = {
  id: '36-org-question',
  title: 'A question proposes nothing',
  priority: 'should',
  baseline: false,
  p4: false,
  org: {
    seed: ['osprey', 'pillars', 'osprey-in-pillar-a'],
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
                    properties: { text: 'Project Osprey still under Pillar A', kind: 'status' },
                    evidence: 'Project Osprey still under Pillar A',
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
                    evidence: 'Project Osprey still under Pillar A',
                  },
                ],
              },
            ],
          }),
        },
      },
    ],
  },
  messages: ['Is Project Osprey still under Pillar A?'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  ...catalogueChecks('36-org-question'),
}
