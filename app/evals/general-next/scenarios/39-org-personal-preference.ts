import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// Hermetic: a pass proves the plumbing that stops the hook here, never the gate.
export const scenario: ConversationScenario = {
  id: '39-org-personal-preference',
  title: 'A personal preference proposes nothing for the graph',
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
                    properties: { name: 'bullet points', kind: 'document' },
                    evidence: 'summaries as bullet points',
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
  messages: ['I prefer my summaries as bullet points.'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  ...catalogueChecks('39-org-personal-preference'),
}
