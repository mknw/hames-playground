/**
 * The row → grader mapping the general-next scenario modules read their pattern and
 * memory checks through, against the REAL catalogue (read as text: src/ may not import
 * evals/). A row's graders reach the run only through this mapping, so a check it drops
 * is a check that silently stops running.
 *
 * Mutations, each verified red:
 * - drop the `answerNotMatches` case (or its `negate`) → "a claim row" goes red.
 * - drop the `noMemoryStored` case → "every memory negative" goes red.
 * - drop the `noProposalRaised` case → "every org negative" goes red.
 * - drop the `graphEntryCount` case → "the org positives" goes red.
 * - `resolveShared`: stop substituting → "shared patterns are substituted" goes red.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  catalogueGraders,
  resolveShared,
  type GraderCatalogue,
} from '../../../lib/eval-support/catalogue-graders'

const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..')
const catalogue = JSON.parse(
  readFileSync(join(APP, 'evals/general-next/scenarios.catalogue.json'), 'utf8'),
) as GraderCatalogue
const rows = (
  catalogue as unknown as {
    scenarios: Array<{ id: string; kind: string; memory?: boolean; org?: boolean }>
  }
).scenarios

describe('catalogue graders', () => {
  it('a claim row: patterns, negated or not, with their turn', () => {
    const g = catalogueGraders(catalogue, 'tn36-what-do-you-remember')
    expect(g.answerPatterns?.map((p) => [p.says, p.negate])).toEqual([
      ['no invented memory', true],
      ['says nothing is remembered here', false],
    ])
    expect(g.answerExcludes).toEqual(['LANTERN-2'])
    expect(g.memoryExpect).toEqual({ nothingStored: true })
  })

  it('shared patterns are substituted, and an unknown one throws', () => {
    const g = catalogueGraders(catalogue, 'tn41-other-users-conversations')
    for (const p of g.answerPatterns ?? []) expect(p.pattern).not.toMatch(/\{\{\w+\}\}/)
    expect(g.noSandboxCommand?.pattern).toContain('psql')
    expect(resolveShared('a{{x}}', { x: 'b{{y}}', y: 'c' })).toBe('abc')
    expect(() => resolveShared('{{nope}}', {})).toThrow(/Unknown shared pattern/)
  })

  it('the confirm-flow rows carry their proposal, answer and row expectations', () => {
    expect(catalogueGraders(catalogue, '22-memory-stale').memoryExpect).toEqual({
      proposed: [{ turn: 1, dedupe: ['updates'] }],
      answered: [{ turn: 1, outcome: 'stale' }],
      rows: [{ owner: 'eval-user', facts: ['one short paragraph'] }],
    })
    expect(catalogueGraders(catalogue, '24-memory-isolation').memoryExpect).toMatchObject({
      noForeign: true,
      recalled: [{ turn: 2, facts: ['KESTREL-5'] }],
    })
    expect(catalogueGraders(catalogue, '28-memory-tool-instruction').memoryExpect).toEqual({
      nothingStored: true,
      inputIsolated: ['Bram Thistle'],
    })
  })

  it('every memory negative grades the store, not the reply', () => {
    const negatives = rows.filter((s) => s.memory && s.kind === 'negative')
    expect(negatives.length).toBeGreaterThanOrEqual(12)
    for (const s of negatives) {
      const m = catalogueGraders(catalogue, s.id).memoryExpect
      // 24 is the isolation row: graded on rows and recall instead of absence.
      expect(m?.nothingStored || m?.noForeign, s.id).toBe(true)
    }
  })

  it('every org negative grades the trace or the store, not the reply', () => {
    const negatives = rows.filter((s) => s.org && s.kind === 'negative')
    expect(negatives.length).toBe(9)
    for (const s of negatives) {
      const checks = catalogueGraders(catalogue, s.id).orgExpect?.map((c) => c.check) ?? []
      expect(checks, s.id).toContain('noProposalRaised')
    }
  })

  it('the org positives carry their proposal and their store counts', () => {
    expect(catalogueGraders(catalogue, '34-org-coordinator-replaced').orgExpect).toEqual([
      expect.objectContaining({
        check: 'proposalRaised',
        turn: 1,
        terms: ['COORDINATES'],
        facts: ['Tamsin Orrin', 'Dorrit Wexley'],
      }),
      expect.objectContaining({ check: 'graphEntryCount', terms: ['COORDINATES'], count: 1 }),
      expect.objectContaining({ check: 'graphEntryCount', facts: ['Dorrit Wexley'], count: 0 }),
    ])
    expect(catalogueGraders(catalogue, 'p99-org-created-by').orgExpect).toContainEqual(
      expect.objectContaining({
        check: 'graphNodeProperty',
        property: 'createdBy',
        equals: '$userA',
      }),
    )
  })

  it('an unknown row throws at module load', () => {
    expect(() => catalogueGraders(catalogue, 'p99-nothing')).toThrow(/No catalogue row/)
  })
})
