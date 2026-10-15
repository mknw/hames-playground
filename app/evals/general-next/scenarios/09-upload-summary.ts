import type { ConversationScenario } from '../types'

export const scenario: ConversationScenario = {
  id: '09-upload-summary',
  title: 'Read an uploaded document and produce a summary',
  priority: 'must',
  baseline: false,
  p4: false,
  messages: [
    'I uploaded lantern-notes.md. Write a short Word summary called lantern-summary.docx and give me the download link.',
  ],
  expectedTools: ['sandbox_bash'],
  expectedRoutes: ['office-data'],
  answerIncludes: ['lantern-summary.docx'],
  artifacts: ['lantern-summary.docx'],
  forbiddenTools: [],
  maxIterations: 6,
}
