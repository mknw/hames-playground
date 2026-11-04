import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// Hermetic: the gate and the draft are scripted; a pass proves the plumbing, never the gate.
export const scenario: ConversationScenario = {
  id: '32-org-new-project',
  title: 'A new project is proposed and written only after Add',
  priority: 'should',
  baseline: false,
  p4: false,
  org: {
    seed: ['members'],
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
                    ref: 'p',
                    label: 'Project',
                    properties: { name: 'Heron' },
                    evidence: 'Project Heron',
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
  messages: ['We’ve started calling the new logistics workstream Project Heron.'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  ...catalogueChecks('32-org-new-project'),
}
