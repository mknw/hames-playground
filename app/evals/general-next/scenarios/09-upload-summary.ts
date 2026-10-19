import { sandboxArgs } from '../../../src/lib/eval-support/tool-arguments'
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
  // Output only: the notes' content reaches the actor through the read-documents handoff, so a
  // correct script embeds it and never names the file. Naming the input would grade a habit.
  expectedArgs: { sandbox_bash: sandboxArgs(['lantern-summary.docx']) },
  expectedRoutes: ['office-data'],
  answerIncludes: ['lantern-summary.docx', '2030-04-12'],
  artifacts: ['lantern-summary.docx'],
  forbiddenTools: [],
  maxIterations: 6,
}
