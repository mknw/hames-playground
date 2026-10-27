/**
 * Ruling B's fixture rows, offline (boundary guards; the screen-on-the-tier eval
 * grades them live). What a later corpus edit or row edit must not change
 * silently: the `k1` column is what the corpus reports, every `cover` is in the
 * text the screen is given, and the gate's rows reach it K1-clean.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))

import { FENCE, neutralizeFenceMarkers } from '@hames-ai/harness-patterns/injection-guard'
import {
  flooredPTrue,
  k1Of,
  NOUL_FLOOR,
  RULING_B_FIXTURES,
  stage1Inputs,
} from '../../../lib/eval-support/ruling-b-fixtures.server'

const stage1 = RULING_B_FIXTURES.filter((row) => row.stages.includes(1))

describe("ruling B's fixture rows", () => {
  it('33 rows, 16 positive and 17 negative, with unique ids', () => {
    expect(RULING_B_FIXTURES).toHaveLength(33)
    expect(RULING_B_FIXTURES.filter((row) => row.expect)).toHaveLength(16)
    expect(new Set(RULING_B_FIXTURES.map((row) => row.id)).size).toBe(33)
  })

  it.each(RULING_B_FIXTURES.map((row) => [row.id, row] as const))(
    "%s: the k1 column is the corpus's verdict on the raw text",
    (_, row) => {
      expect(k1Of(row.text)).toBe(row.k1)
    },
  )

  it('every stage-2 row reaches the gate K1-clean (a finding forces the screen instead)', () => {
    const fired = RULING_B_FIXTURES.filter((row) => row.stages.includes(2) && row.k1 !== 'clean')
    expect(fired.map((row) => row.id)).toEqual([])
  })

  // The stage-2 loop must re-assert this at run time, per row, before the gate
  // call — the offline pins above hold for the committed rows, but a later
  // edit that drifts a row K1-dirty must fail the live run, not be graded by
  // the gate on the forced path. `src/` may not import `evals/`, so pin the
  // call site by source, like the other live-scenario wiring pins.
  //
  // MUTATION: delete the stage-2 K1-clean assertion from the scenario's loop
  // (`app/evals/scenarios/screen.ts`): this pin reddens, and a drifted row is
  // then graded by the gate instead of failing the run.
  it("the scenario's stage-2 loop asserts each row K1-clean before the gate call", () => {
    const src = readFileSync(resolve(process.cwd(), 'evals/scenarios/screen.ts'), 'utf8')
    const loop = src.slice(src.indexOf('for (const row of stage2)'))
    const k1 = loop.indexOf('k1Of(row.text)')
    const gate = loop.indexOf('await gate({')
    expect(k1).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(k1)
    expect(loop).toContain("fired === 'clean'")
  })

  // MUTATION: change one row's `cover` (e.g. `own3-resume-ranking`'s to
  // 'best candidate for the role'): it is in no text the screen is given.
  it.each(stage1.filter((row) => row.expect).map((row) => [row.id, row] as const))(
    '%s: a stage-1 positive has a cover, and it is in every text the screen is given',
    (_, row) => {
      expect(row.cover).toBeTruthy()
      for (const { input, text } of stage1Inputs(row)) {
        expect(text, input).toContain(row.cover)
      }
      expect(row.text).toContain(row.cover)
    },
  )

  // MUTATION: drop the fence from the projection (`spotlight: 'off'` in
  // `stage1Inputs`), or the neutraliser from either input.
  it('a K1-firing row is screened twice: raw, and the fenced projection, both through the neutraliser', () => {
    for (const row of stage1.filter((r) => r.k1 !== 'clean')) {
      const inputs = stage1Inputs(row)
      expect(inputs.map((i) => i.input)).toEqual(['raw', 'K1 projection'])
      const projection = inputs[1].text
      expect(
        projection.startsWith(
          `${FENCE.open}web/fetch${FENCE.itemSeparator}call-1${FENCE.headerEnd}\n`,
        ),
      ).toBe(true)
      expect(projection).toContain('⟦neutralized:')
      for (const { text } of inputs) expect(neutralizeFenceMarkers(text)).toBe(text)
    }
    for (const row of stage1.filter((r) => r.k1 === 'clean')) {
      expect(stage1Inputs(row).map((i) => i.input)).toEqual(['raw'])
    }
  })

  it("every stage-1 input fits the screen's 20 000-character head, so no row is cut", () => {
    for (const row of stage1) {
      for (const { text } of stage1Inputs(row)) expect(text.length).toBeLessThanOrEqual(20_000)
    }
  })

  // MUTATION: restore the `[^\n]{0,40}` tail on the shared neutraliser's regex
  // (`injection-guard.ts`): the instruction after the forged marker is cut again.
  it('marker-tail-hide: the instruction after a forged marker reaches both judges (slice 4)', () => {
    const row = RULING_B_FIXTURES.find((r) => r.id === 'marker-tail-hide')!
    expect(row).toMatchObject({ stages: [1, 2], expect: true, k1: 'clean' })
    const judged = neutralizeFenceMarkers(row.text)
    expect(judged).toContain(`[fence] ${row.cover}`)
  })

  // MUTATION: compare with the literal 0.199 inside `flooredPTrue` (the exact
  // wording review finding F4 forbids on PR #741): the second assertion turns
  // red, because 1 − 0.801 is 0.19899999999999995 and `=== 0.199` is false.
  it('flags floored gate pTrue values by the two exact float64 endpoints, never by 0.199 (F4)', () => {
    expect(flooredPTrue(NOUL_FLOOR)).toBe(true)
    expect(flooredPTrue(1 - NOUL_FLOOR)).toBe(true)
    expect(flooredPTrue(0.199)).toBe(false)
    expect(flooredPTrue(0.5)).toBe(false)
    expect(flooredPTrue(null)).toBe(false)
    expect(flooredPTrue(undefined)).toBe(false)
  })
})
