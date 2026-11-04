import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// The preference is already remembered; restating it counts another sighting of the same
// memory instead of adding a second one.
export const scenario: ConversationScenario = {
  id: '20-memory-reinforce',
  title: 'A restated preference reinforces the memory it repeats',
  priority: 'should',
  baseline: false,
  p4: false,
  memory: {
    enabled: true,
    seed: ['notes'],
    turns: [
      {
        answer: 'save',
        model: {
          gate: {
            target: 'personal_memory',
            confirm: 'ask',
            kind: 'preference',
            sensitive: 'ordinary',
          },
          extract: [
            {
              kind: 'preference',
              content: 'The user likes meeting notes as short bullet points.',
              evidence: 'I like my meeting notes as short bullet points',
            },
          ],
        },
      },
    ],
  },
  messages: ['Just so you know, I like my meeting notes as short bullet points.'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  ...catalogueChecks('20-memory-reinforce'),
}
