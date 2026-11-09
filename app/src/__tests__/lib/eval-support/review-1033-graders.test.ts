/** rv-1033 review evidence (proposed test edits for #1032's eval rows): the
 * scenario 48 and 45 graders must refuse the wrong answers their rulings name.
 * Red at e4e17bfc. Reads the catalogue as text, like scenario-catalogue.test.ts,
 * so nothing under src/ imports the eval suite. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  answerExcludesCheck,
  answerMatchesCheck,
} from '../../../lib/eval-support/conversation-checks'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

const APP = join(__dirname, '../../../..')
type Row = { id: string; grader: Array<Record<string, unknown>> }
const rows = (): Row[] => {
  const json = JSON.parse(
    readFileSync(join(APP, 'evals/general-next/scenarios.catalogue.json'), 'utf8'),
  ) as { scenarios?: Row[] } | Row[]
  return Array.isArray(json) ? json : (json.scenarios ?? [])
}
const grader = (id: string, check: string) =>
  rows()
    .find((r) => r.id === id)!
    .grader.find((g) => g.check === check)!

describe('scenario 48: no file someone else shared is named (reply 7 item 1)', () => {
  it('fails an answer that names her two files plus another sharer’s file', () => {
    const facts = grader('48-person-files-document', 'answerExcludes').facts as string[]
    const answer =
      'Ines Varga leads the rollout. She shared lantern-rollout-plan.docx and ' +
      'lantern-wave-schedule.xlsx with you; vendor-shortlist.xlsx is also in your shares.'
    expect(answerExcludesCheck(answer, facts).pass).toBe(false)
  })
})

describe('scenario 45: the local date in words means the 5th, not the 15th or 25th', () => {
  it('does not accept 15 or 25 November', () => {
    const pattern = grader('45-today-calendar-afternoon', 'answerMatches').pattern as string
    for (const wrong of ['Thursday, 15 November 2026', 'Thursday, the 25th of November, 2026'])
      expect(answerMatchesCheck(wrong, pattern).pass, wrong).toBe(false)
  })
})
