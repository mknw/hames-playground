/**
 * The 07-follow-up-success fixture pin (owner option 2, rebuilt per the owner's
 * shape-probe directive): the canned per-entity relationship data is the ONLY place the
 * graded facts live, the follow-up's exact expected answer is COMPUTED from that canned
 * data (not asserted beside it), the structure mirrors the probed dev-graph shape, and
 * the fixture does not hand the answer over pre-ranked or mirror the controller's
 * degree-aggregation few-shot. src/ may not import evals/, so the fixtures are pinned by
 * source, like the other live-scenario wiring pins.
 *
 * MUTATIONS (red; each verified, then restored):
 * 1. rename a participant endpoint in `evals/general-next/driver.ts`
 *    GRAPH_RELATIONSHIPS (e.g. 'Dune' → 'Kelp') — the computed union stops matching the
 *    scenario's graded facts and this file goes red;
 * 2. drop the traversal-pattern exclusion from the read_neo4j_cypher branch — the
 *    discriminator pin goes red, and a degree/participant query carrying a traversal
 *    pattern would then be answered with the total count instead of the triples;
 * 3. delete one direction of a reciprocal pair (e.g. `{ from: 'Dune', type: 'RUNS_ON',
 *    to: 'Alder' }`) — the reciprocity pin goes red and the expected answer would
 *    depend on whether the model reads the edges directed or undirected.
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

/** The probed dev-graph relationship vocabulary (read-only shape probe; the six types). */
const PROBED_RELATIONSHIP_TYPES = [
  'USES',
  'CONNECTS_TO',
  'FALLS_BACK_TO',
  'RUNS_ON',
  'IMPLEMENTS',
  'EXPOSES',
]

const triples = [
  ...driver.matchAll(/\{ from: '([^']+)', type: '([A-Z_]+)', to: '([^']+)' \}/g),
].map((m) => ({ from: m[1], type: m[2], to: m[3] }))
const degreeOf = (name: string) => triples.filter((t) => t.from === name || t.to === name).length
const neighbors = (name: string, direction: 'in' | 'out' | 'both') =>
  triples
    .filter((t) =>
      direction === 'out'
        ? t.from === name
        : direction === 'in'
          ? t.to === name
          : t.from === name || t.to === name,
    )
    .map((t) => (t.from === name ? t.to : t.from))

const ranked = [...new Set(triples.flatMap((t) => [t.from, t.to]))]
  .map((name) => ({ name, degree: degreeOf(name) }))
  .sort((a, b) => b.degree - a.degree)
const topThree = ranked.slice(0, 3).map((r) => r.name)

/** The computation the follow-up's answer is expected to have performed: rank by
 * relationship degree, take the top three, union their participants. */
const computed = [...new Set(topThree.flatMap((name) => neighbors(name, 'both')))]

// Tolerant of prettier's one-line or multi-line rendering of the outer array: everything
// from the key to the scenario object's closing brace.
const turnBlock = scenario.slice(
  scenario.indexOf('turnAnswerIncludes: ['),
  scenario.indexOf('\n}', scenario.indexOf('turnAnswerIncludes: [')),
)
const turnFacts = [...turnBlock.matchAll(/\[([^\]]*)\]/g)].map((m) =>
  [...m[1].matchAll(/'([^']+)'/g)].map((s) => s[1]),
)
const answerFacts = [
  ...(scenario.match(/\n {2}answerIncludes: \[([^\]]*)\]/)?.[1] ?? '').matchAll(/'([^']+)'/g),
].map((m) => m[1])
const messages = [...scenario.matchAll(/\n {4}'([^']+)',$/gm)].map((m) => m[1])

describe('07-follow-up-success graph fixture (owner option 2, probe-derived)', () => {
  it('the canned data is raw relationship triples over the probed vocabulary', () => {
    expect(triples.length).toBeGreaterThanOrEqual(12)
    for (const triple of triples) expect(PROBED_RELATIONSHIP_TYPES).toContain(triple.type)
    // The probed schema has no popularity or participants property: popularity is
    // relationship degree and participants are relationship endpoints. The pin reads the
    // schema block, not the file, so the fixture's own comment naming the probe stays.
    const schema = driver.match(/get_neo4j_schema: \{([\s\S]*?)\n {2}\},/)?.[1] ?? ''
    expect(schema).not.toMatch(/popularity/)
    expect(schema).not.toMatch(/participants/)
    expect(schema).toMatch(/type: 'node'/)
  })

  it('the exact expected turn-2 answer is the top-3 participants union computed from the canned data', () => {
    // The top three must be unambiguous: no tie may straddle the rank-3 boundary.
    expect(ranked[2].degree).toBeGreaterThan(ranked[3].degree)
    // Every top-tier entity's relationships are reciprocal, so the answer is the same
    // whether the model reads the edges directed or undirected.
    for (const name of topThree) {
      expect([...new Set(neighbors(name, 'in'))].sort()).toEqual(
        [...new Set(neighbors(name, 'out'))].sort(),
      )
    }
    expect(turnFacts[1]).toEqual(computed)
    expect(answerFacts).toEqual(computed)
    // The exact expected answer string, stated in the PR body and graded per name.
    expect(computed).toEqual(['Dune', 'Ember', 'Fern', 'Gulf', 'Haven', 'Iris', 'Juniper'])
  })

  it('turn 1 keeps the existing total-count anchor', () => {
    expect(turnFacts[0]).toEqual(['42'])
    expect(messages[1]).toBe('Who is involved in the three most popular?')
    expect(driver).toContain('[{ count: 42 }]')
  })

  it('the fixture does not hand the answer over: no pre-aggregated rows and no hub self-inclusion', () => {
    // The canned rows are triples, never the degree few-shot's aggregated {name, degree}.
    expect(driver).not.toMatch(/degree:/)
    // The top-tier entities are not their own participants: the expected answer names
    // only the entities connected TO the top three, never the top three themselves.
    for (const name of topThree) expect(computed).not.toContain(name)
  })

  it('the graded facts live only in the fixture: the seeded notes carry none of them', () => {
    const notes = driver.match(/const NOTES =\s*'([^']*)'/)?.[1] ?? ''
    for (const name of computed) expect(notes).not.toContain(name)
  })

  it('the total-count branch is discriminated so a degree or participant query never gets the count row', () => {
    expect(driver).toContain('projectCountArgs(args)')
    expect(driver).toContain('!/-\\[|\\]-|--/')
  })

  it('SCENARIOS.md states the same expected answer', () => {
    const section = scenariosMd.slice(
      scenariosMd.indexOf('### 07-follow-up-success'),
      scenariosMd.indexOf('### 08-follow-up-failure'),
    )
    expect(section).toContain('Dune, Ember, Fern, Gulf, Haven, Iris and Juniper')
    expect(section).toContain('Who is involved in the three most popular?')
  })
})
