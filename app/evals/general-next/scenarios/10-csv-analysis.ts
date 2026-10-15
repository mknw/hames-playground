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
  expectedRoutes: ['office-data'],
  answerIncludes: ['60'],
  artifacts: ['lantern-totals.csv'],
  forbiddenTools: [],
  maxIterations: 6,
}
