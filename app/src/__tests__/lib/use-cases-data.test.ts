/**
 * The use-cases snapshot (`lib/use-cases.ts`) against its own source.
 *
 * The page renders this module, never the catalogue, so the pin here is the
 * only thing keeping the two honest with each other: every question on the
 * page must exist in `evals/general-next/scenarios.catalogue.json` with
 * status "existing", and its title, priority and user turns must be the
 * catalogue's verbatim. The results are the recorded outcomes of eval run 10
 * (2026-10-30) — the dispatch's enumeration, held here as data so a hand edit
 * to one side fails loudly rather than quietly disagreeing.
 *
 * Like `scenario-catalogue.test.ts`, the catalogue is read as text: src/ may
 * not import evals/.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { QUESTION_DRAFT_PARAM, USE_CASES_TESTED_ON, USE_CASE_SECTIONS } from '../../lib/use-cases'

type Json = Record<string, unknown>
const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const catalogue: { scenarios: Json[] } = JSON.parse(
  readFileSync(join(APP, 'evals/general-next/scenarios.catalogue.json'), 'utf8'),
)

const flat = USE_CASE_SECTIONS.flatMap((s) => s.questions)
const catalogueById = new Map(catalogue.scenarios.map((s) => [s.id as string, s]))

/** Run 10 (2026-10-30), exactly as recorded: pass / fail / gated. */
const RUN_10 = {
  works: ['01', '02', '03', '04', '05', '06', '07', '09', '10', '11', '12', '13', '17'],
  'not-yet': ['08', '14'],
  coming: ['15', '16'],
}

describe('use-cases data', () => {
  it('carries exactly the 17 run-10 scenarios, each unique', () => {
    expect(flat).toHaveLength(17)
    expect(new Set(flat.map((q) => q.id)).size).toBe(17)
  })

  it('every question exists in the catalogue with status "existing"', () => {
    for (const q of flat) {
      const row = catalogueById.get(q.id)
      expect(row, `catalogue is missing ${q.id}`).toBeDefined()
      expect(row!.status).toBe('existing')
    }
  })

  it('title, priority and user turns are the catalogue fields verbatim', () => {
    for (const q of flat) {
      const row = catalogueById.get(q.id)!
      expect(q.title).toBe(row.title)
      expect(USE_CASE_SECTIONS.find((s) => s.questions.includes(q))!.priority).toBe(row.priority)
      expect(q.turns).toEqual(row.turns)
    }
  })

  it('the section grouping matches each catalogue priority', () => {
    for (const section of USE_CASE_SECTIONS) {
      for (const q of section.questions) {
        expect(catalogueById.get(q.id)!.priority).toBe(section.priority)
      }
    }
  })

  it('results are exactly run 10: pass, fail and gated where recorded', () => {
    for (const [result, prefixes] of Object.entries(RUN_10)) {
      for (const prefix of prefixes) {
        const q = flat.find((candidate) => candidate.id.startsWith(prefix))
        expect(q, `no question with id prefix ${prefix}`).toBeDefined()
        expect(q!.result, `${q!.id}`).toBe(result)
      }
    }
  })

  it('every result is one of the three the page knows how to render', () => {
    for (const q of flat) expect(['works', 'not-yet', 'coming']).toContain(q.result)
  })

  it('keeps the multi-turn questions multi-turn, in order', () => {
    for (const q of flat.filter((candidate) => candidate.turns.length > 1)) {
      expect(q.turns).toEqual(catalogueById.get(q.id)!.turns)
    }
    // Six of the seventeen carry follow-ups — the page's "then ask:" cases.
    expect(flat.filter((q) => q.turns.length > 1)).toHaveLength(6)
  })

  it('names the day the round ran', () => {
    expect(USE_CASES_TESTED_ON).toBe('30 October 2026')
  })

  it('hands "Try this" its query parameter', () => {
    expect(QUESTION_DRAFT_PARAM).toBe('q')
  })
})
