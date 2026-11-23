import type { ConversationScenario } from '../types'
import { catalogueChecks } from '../catalogue-checks'

// Entirely invented: the initials collide with a public namesake. Only the
// organisation's own file has its invoicing instructions. The scripted decider
// takes the namesake path if its state lacks the actual identity block; the
// scripted writer can only repeat facts present in its evidence.
export const identity = {
  displayName: 'Lumen Orchard Works',
  abbreviations: ['LOW'],
  domains: ['lumen-orchard.example.org'],
}

export const scenario: ConversationScenario = {
  id: '52-own-organisation-invoicing',
  title: 'Our organisation’s abbreviation selects its own invoicing sources',
  priority: 'should',
  baseline: false,
  p4: false,
  organisation: { identity, question: 'own' },
  messages: ['What are LOW’s VAT number and invoicing details?'],
  expectedRoutes: ['think', 'info-retrieval', 'office-data'],
  expectedTools: ['read_neo4j_cypher', 'graph_files_search'],
  expectedArgs: {
    graph_files_search: (a) => /invoic|vat/i.test(String(a.query)),
  },
  answerIncludes: ['SYNTHETIC-LOW-VAT-314', 'billing@lumen-orchard.example.org'],
  answerFromPrompt: true,
  artifacts: [],
  forbiddenTools: [],
  maxIterations: 6,
  scriptedArgs: {
    search: { query: 'LOW VAT invoicing' },
    read_neo4j_cypher: { query: 'MATCH (o:Organization) RETURN o' },
    graph_files_search: { query: 'VAT invoicing' },
  },
  toolData: {
    read_neo4j_cypher: [],
    graph_files_search: {
      total: 1,
      results: [
        {
          name: 'invoicing-instructions.txt',
          item_id: 'synthetic-low-invoicing',
          drive_id: 'synthetic-low-drive',
          webUrl: 'https://lumen-orchard.example.org/invoicing-instructions',
          snippet:
            'Lumen Orchard Works (LOW). VAT: SYNTHETIC-LOW-VAT-314. Send invoices to billing@lumen-orchard.example.org.',
        },
      ],
    },
    search: {
      results: [
        {
          title: 'League of Windmills (LOW)',
          url: 'https://league-of-windmills.example.org/invoices',
          content: 'VAT SYNTHETIC-NAMESAKE-VAT-999; pay@league-of-windmills.example.org',
        },
      ],
    },
  },
  ...catalogueChecks('52-own-organisation-invoicing'),
}
