import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

export const scenario: ConversationScenario = {
  id: '05-memory-lookup',
  title: 'Recall a confirmed per-user memory in a later turn',
  priority: 'should',
  baseline: false,
  p4: false,
  // Each owner holds one confirmed memory; the Eval user asks about their own.
  memory: { enabled: true, seed: ['lantern', 'kestrel'], turns: [{}, {}] },
  messages: ['What do you remember about me?', 'And which release tag do you have noted for it?'],
  expectedTools: [],
  expectedRoutes: [],
  answerIncludes: ['LANTERN-2'],
  // Turn 1 names no remembered content, and recall is relevance-gated: it attaches
  // nothing there on the production embedder (#982), so only turn 2 grades recall.
  turnAnswerIncludes: [[], ['LANTERN-2']],
  artifacts: [],
  forbiddenTools: [],
  noTools: true,
  maxIterations: 6,
  ...catalogueChecks('05-memory-lookup'),
}
