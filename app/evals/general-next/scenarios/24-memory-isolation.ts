import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// The Eval user saves a fact; in a new conversation the other user asks for "my" release
// tag and gets only their own memory.
export const scenario: ConversationScenario = {
  id: '24-memory-isolation',
  title: 'Another user never sees what this user saved',
  priority: 'should',
  baseline: false,
  p4: false,
  memory: {
    enabled: true,
    seed: ['kestrel'],
    turns: [
      {
        answer: 'save',
        model: {
          gate: {
            target: 'personal_memory',
            confirm: 'ask',
            kind: 'semantic',
            sensitive: 'ordinary',
          },
          extract: [
            {
              kind: 'semantic',
              content: 'The user works on the Heron project; its release tag is HERON-7.',
              evidence: 'I work on the Heron project and its release tag is HERON-7',
            },
          ],
        },
      },
      { newConversation: { owner: 'eval-other-user' } },
    ],
  },
  messages: [
    'For future reference, I work on the Heron project and its release tag is HERON-7.',
    'Which release tag do you have noted for me?',
  ],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  ...catalogueChecks('24-memory-isolation'),
}
