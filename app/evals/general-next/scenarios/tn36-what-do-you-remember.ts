import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// Memory is wired, a memory is stored, and the switch is OFF: recall reads nothing, so the
// answer has nothing to list.
export const scenario: ConversationScenario = {
  id: 'tn36-what-do-you-remember',
  title: 'Do not invent memories',
  priority: 'should',
  baseline: false,
  p4: false,
  memory: { enabled: false, seed: ['lantern', 'kestrel'], turns: [{}] },
  messages: ['What do you remember about me?'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: [],
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  ...catalogueChecks('tn36-what-do-you-remember'),
}
