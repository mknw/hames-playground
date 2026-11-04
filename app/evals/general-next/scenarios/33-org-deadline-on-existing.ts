import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// Hermetic: the gate and the draft are scripted; a pass proves the plumbing, never the gate.
export const scenario: ConversationScenario = {
  id: '33-org-deadline-on-existing',
  title: 'A deadline attaches to the existing project',
  priority: 'should',
  baseline: false,
  p4: false,
  org: {
    seed: ['members', 'osprey'],
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
                    ref: 'o',
                    label: 'Project',
                    properties: { name: 'Osprey' },
                    evidence: 'The Osprey review',
                  },
                  {
                    ref: 'd',
                    label: 'Deadline',
                    properties: { label: 'Osprey review', date: '2026-12-15' },
                    evidence: 'The Osprey review is due on 15 December',
                  },
                ],
                edges: [
                  {
                    type: 'HAS_DEADLINE',
                    from: 'o',
                    to: 'd',
                    evidence: 'The Osprey review is due on 15 December',
                  },
                ],
              },
            ],
          }),
        },
      },
    ],
  },
  messages: ['The Osprey review is due on 15 December.'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  ...catalogueChecks('33-org-deadline-on-existing'),
}
