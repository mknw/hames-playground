import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'
import { identity } from './52-own-organisation-invoicing'

export const scenario: ConversationScenario = {
  id: '53-other-organisation-web',
  title: 'An explicitly different organisation is still searched on the public web',
  priority: 'should',
  baseline: false,
  p4: false,
  organisation: { identity, question: 'other' },
  messages: ['What is the VAT number of the League of Windmills?'],
  expectedTools: ['search'],
  expectedArgs: { search: (a) => /League of Windmills/i.test(String(a.query)) },
  expectedRoutes: ['info-retrieval'],
  scriptedArgs: { search: { query: 'League of Windmills VAT' } },
  answerIncludes: ['SYNTHETIC-NAMESAKE-VAT-999'],
  answerFromPrompt: true,
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  toolData: {
    search: {
      results: [
        {
          title: 'League of Windmills',
          url: 'https://league-of-windmills.example.org/invoices',
          content: 'VAT SYNTHETIC-NAMESAKE-VAT-999',
        },
      ],
    },
  },
  ...catalogueChecks('53-other-organisation-web'),
}
