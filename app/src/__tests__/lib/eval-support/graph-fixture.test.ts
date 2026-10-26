/**
 * The 07-follow-up-success fixture pin (owner option 2, second commit): the canned
 * per-entity graph data is the ONLY place the graded facts live, the follow-up's exact
 * expected answer is COMPUTED from that canned data (not asserted beside it), and the
 * fixture does not hand the answer over pre-ranked or mirror the controller's
 * degree-aggregation few-shot. src/ may not import evals/, so the fixtures are pinned by
 * source, like the other live-scenario wiring pins.
 *
 * MUTATIONS (red; each verified, then restored):
 * 1. change a participant of a top-3 project in `evals/general-next/driver.ts`
 *    GRAPH_PROJECTS (e.g. 'Priya' → 'Ravi') — the computed union stops matching the
 *    scenario's graded facts and this file goes red;
 * 2. reorder GRAPH_PROJECTS by popularity descending — the not-pre-ranked pin goes red
 *    (the fixture would hand the top-3 selection over);
 * 3. drop the popularity/participants exclusion from the read_neo4j_cypher branch — the
 *    discriminator pin goes red and a turn-2 property query carrying a count-ish word
 *    (member_count) would be answered with the total count instead of the table.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const driver = readFileSync(resolve(process.cwd(), 'evals/general-next/driver.ts'), 'utf8')
const scenario = readFileSync(
  resolve(process.cwd(), 'evals/general-next/scenarios/07-follow-up-success.ts'),
  'utf8',
)
const scenariosMd = readFileSync(resolve(process.cwd(), 'evals/general-next/SCENARIOS.md'), 'utf8')

const rows = [
  ...driver.matchAll(/\{ name: '([^']+)', popularity: (\d+), participants: \[([^\]]*)\] \}/g),
].map((m) => ({
  name: m[1],
  popularity: Number(m[2]),
  participants: [...m[3].matchAll(/'([^']+)'/g)].map((s) => s[1]),
}))

/** Top-3 by popularity (distinct values, so no tie-breaking), participants unioned in
 * rank order — the computation the follow-up's answer is expected to have performed. */
const topThreeParticipants = (items: typeof rows): string[] => [
  ...new Set(
    [...items]
      .sort((a, b) => b.popularity - a.popularity)
      .slice(0, 3)
      .flatMap((r) => r.participants),
  ),
]
const computed = topThreeParticipants(rows)

const turnFacts = [
  ...(scenario.match(/\n {2}turnAnswerIncludes: \[(.*)\],?\n/)?.[1] ?? '').matchAll(
    /\[([^\]]*)\]/g,
  ),
].map((m) => [...m[1].matchAll(/'([^']+)'/g)].map((s) => s[1]))
const answerFacts = [
  ...(scenario.match(/\n {2}answerIncludes: \[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g),
].map((m) => m[1])
const messages = [...scenario.matchAll(/\n {4}'([^']+)',$/gm)].map((m) => m[1])

describe('07-follow-up-success graph fixture (owner option 2)', () => {
  it('the canned table carries, per entity, a popularity count and participants', () => {
    expect(rows.length).toBeGreaterThanOrEqual(4)
    for (const row of rows) {
      expect(Number.isInteger(row.popularity)).toBe(true)
      expect(row.participants.length).toBeGreaterThan(0)
    }
  })

  it('the exact expected turn-2 answer is the top-3 participants union computed from the canned data', () => {
    expect(new Set(rows.map((r) => r.popularity)).size).toBe(rows.length)
    expect(turnFacts[1]).toEqual(computed)
    expect(answerFacts).toEqual(computed)
    // The exact expected answer string, stated in the PR body and graded per name.
    expect(computed).toEqual(['Mira', 'Theo', 'Priya', 'Sana'])
  })

  it('turn 1 keeps the existing total-count anchor', () => {
    expect(turnFacts[0]).toEqual(['42'])
    expect(messages[1]).toBe('Who is involved in the three most popular?')
    expect(driver).toContain('[{ count: 42 }]')
  })

  it('the fixture does not hand the answer over: rows are not pre-ranked and no row mirrors the degree few-shot', () => {
    const order = rows.map((r) => r.popularity)
    expect(order).not.toEqual([...order].sort((a, b) => b - a))
    // The canned result shape stays per-entity data (name/popularity/participants), never
    // the few-shot's aggregated {name, degree} row and never a Cypher literal of its own.
    for (const row of rows)
      expect(Object.keys(row).sort()).toEqual(['name', 'participants', 'popularity'])
    expect(driver).not.toMatch(/MATCH \(/)
    expect(driver).not.toMatch(/ORDER BY/)
  })

  it('the graded facts live only in the fixture: the seeded notes carry none of them', () => {
    const notes = driver.match(/const NOTES =\s*'([^']*)'/)?.[1] ?? ''
    for (const name of rows.flatMap((r) => r.participants)) expect(notes).not.toContain(name)
    for (const row of rows) expect(notes).not.toContain(row.name)
  })

  it('the total-count branch is discriminated so a turn-2 property query never gets the count row', () => {
    expect(driver).toContain('projectCountArgs(args)')
    expect(driver).toContain('!/popularity|participan/i.test(query)')
  })

  it('SCENARIOS.md states the same expected answer', () => {
    const section = scenariosMd.slice(
      scenariosMd.indexOf('### 07-follow-up-success'),
      scenariosMd.indexOf('### 08-follow-up-failure'),
    )
    expect(section).toContain('Mira, Theo, Priya and Sana')
    expect(section).toContain('Who is involved in the three most popular?')
  })
})
