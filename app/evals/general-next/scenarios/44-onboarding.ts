import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

export const scenario: ConversationScenario = {
  id: '44-onboarding',
  title: 'Say what it can do and where to start',
  priority: 'should',
  baseline: false,
  p4: false,
  messages: [
    'What can you do?',
    'help',
    'How do I start?',
    'Wat kun je allemaal voor me doen?',
    'Comment est-ce que je commence ?',
  ],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  noTools: true,
  // Hermetic: the scripted synthesis answers from the guide the prompt carried.
  guideAnswer: true,
  ...catalogueChecks('44-onboarding'),
}
