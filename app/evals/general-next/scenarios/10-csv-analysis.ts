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
  expectedArgs: { sandbox_bash: sandboxArgs('lantern-totals.csv', 'lantern-sales.csv') },
  expectedRoutes: ['office-data'],
  answerIncludes: ['North', '47', 'South', '19', '66'],
  artifacts: ['lantern-totals.csv'],
  // What a real run of this task prints, and the file it leaves.
  sandboxRun: {
    stdout: 'North,47\nSouth,19\nTotal,66',
    files: { 'lantern-totals.csv': 'region,revenue\nNorth,47\nSouth,19\nTotal,66\n' },
  },
  forbiddenTools: [],
  maxIterations: 6,
}
