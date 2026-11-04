import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// The person states a preference; the store step proposes it with verbatim evidence; the
// person saves it; a new conversation recalls it.
export const scenario: ConversationScenario = {
  id: '19-memory-save-recall',
  title: 'Save a stated preference on confirm, recall it in a new conversation',
  priority: 'should',
  baseline: false,
  p4: false,
  memory: {
    enabled: true,
    seed: [],
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
      { newConversation: { owner: 'eval-user' } },
    ],
  },
  messages: [
    'For future reference: I like my meeting notes as short bullet points.',
    'How should you format meeting notes for me?',
  ],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: ['bullet points'],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  ...catalogueChecks('19-memory-save-recall'),
}
