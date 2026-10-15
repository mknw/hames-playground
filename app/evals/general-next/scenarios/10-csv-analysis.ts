import { sandboxArgs } from '../../../src/lib/eval-support/tool-arguments'
import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '10-csv-analysis',
  title: 'Compute from an uploaded CSV',
  priority: 'must',
  baseline: false,
  p4: false,
  messages: [
    'Use the uploaded lantern-sales.csv to total revenue by region. Save lantern-totals.csv and tell me the grand total.',
  ],
  expectedTools: ['sandbox_bash'],
  expectedArgs: { sandbox_bash: sandboxArgs(['lantern-sales.csv', 'lantern-totals.csv']) },
  expectedRoutes: ['office-data'],
  answerIncludes: ['North', '47', 'South', '19', '66'],
  artifacts: ['lantern-totals.csv'],
  forbiddenTools: [],
  maxIterations: 6,
}
