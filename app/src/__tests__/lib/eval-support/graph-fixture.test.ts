/**
 * The 07-follow-up-success fixture pin (owner option 2, rebuilt per the owner's
 * shape-probe directive; the people fixture is TASK Q, #808): the canned per-entity
 * relationship data is the ONLY place the graded facts live, the follow-up's exact
 * expected answer is COMPUTED from that canned data (not asserted beside it), the
 * structure mirrors the probed dev-graph shape, and the fixture does not hand the answer
 * over pre-ranked or mirror the controller's degree-aggregation few-shot.
 * src/ may not import evals/, so the fixtures are pinned by source, like the other
 * live-scenario wiring pins.
 *
 * MUTATIONS (red; each verified, then restored):
 * 1. rename a person endpoint in `evals/general-next/driver.ts` GRAPH_RELATIONSHIPS
 *    WORKS_ON data (e.g. 'Zenith' → 'Kelp') — the computed union stops matching the
 *    scenario's graded facts and this file goes red;
 * 2. drop the traversal-pattern exclusion from the read_neo4j_cypher branch — the
 *    discriminator pin goes red, and a degree/participant query carrying a traversal
 *    pattern would then be answered with the total count instead of the triples;
 * 3. delete one direction of a reciprocal project pair (e.g. `{ from: 'Dune',
 *    type: 'RUNS_ON', to: 'Alder' }`) — the reciprocity pin goes red and the projects'
 *    structure would depend on whether the model reads the edges directed or undirected;
 * 4. change the count row's anchor (`data: totalCount ? [{ count: 42 }]`, 42 → 43) — the
 *    turn-1 anchor pin goes red (the pin names the branch expression, because the
 *    driver's comment also quotes `[{ count: 42 }]`);
 * 5. change any per-type `count` in the canned schema (e.g. WORKS_ON 8 → 99) — the
 *    per-type count pin goes red, since it derives every count from the triples;
 * 6. drop the nodeQuery arm from the read_neo4j_cypher branch (or rename 'Alder' in the
 *    GRAPH_NODES list, breaking participant coverage) — the node-query pin goes red, and
 *    a `RETURN p.name, p.observations` query would be answered with the relationship
 *    triples again (R6DIAG row 07: the controller read "the same relationship data
 *    regardless of what I ask"); the personQuery arm is pinned the same way;
 * 7. delete one filler name from the GRAPH_NODES list (e.g. 'Maple'), leaving 41 node
 *    rows against the 42 count anchor — the consistency pin goes red (R7DIAG row 07: the
 *    run-7 child flagged the 10-vs-42 mismatch and declined the follow-up);
 * 8. move one of Cedar's people to Birch in the WORKS_ON data (Cedar 2 → 1, Birch 2 → 3)
 *    — the rank-boundary pin goes red: the computed top three stop matching the graded
 *    answer (Cedar no longer carries two people) and the boundary the reworded question
 *    ranks across is no longer where the scenario says;
 * 9. point a WORKS_ON edge at a filler project (e.g. 'Maple') — the isolation pin goes
 *    red: a filler carries a person, so the "isolated fillers cannot be among the three"
 *    argument the expected answer rests on breaks.
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

/** The ONE deliberate addition to the probed vocabulary (TASK Q, #808): the involvement
 * relationship the reworded follow-up ranks by. The dev graph's people are org-governed,
 * so the shape probe read no person-bearing type; the miniature adds this one, directed
 * person → project. */
const INVOLVEMENT_TYPE = 'WORKS_ON'

const triples = [
  ...driver.matchAll(/\{ from: '([^']+)', type: '([A-Z_]+)', to: '([^']+)' \}/g),
].map((m) => ({ from: m[1], type: m[2], to: m[3] }))
const involvement = triples.filter((t) => t.type === INVOLVEMENT_TYPE)
const projectTriples = triples.filter((t) => t.type !== INVOLVEMENT_TYPE)
const peopleOn = (project: string) => involvement.filter((t) => t.to === project).map((t) => t.from)
const neighbors = (name: string, direction: 'in' | 'out' | 'both') =>
  projectTriples
    .filter((t) =>
      direction === 'out'
        ? t.from === name
        : direction === 'in'
          ? t.to === name
          : t.from === name || t.to === name,
    )
    .map((t) => (t.from === name ? t.to : t.from))

/** The ranking the reworded follow-up performs: projects by WORKS_ON people count, most
 * first (stable sort, so a tie keeps first-appearance order). People and unworked
 * projects sort at 0 and can never reach the top three. */
const ranked = [...new Set(triples.flatMap((t) => [t.from, t.to]))]
  .map((name) => ({ name, people: peopleOn(name).length }))
  .sort((a, b) => b.people - a.people)
const topThree = ranked.slice(0, 3).map((r) => r.name)

/** The node rows and the count anchor, extracted by source like the triples above. The
 * slice stops at `.map` so only the names array is read, never the observations strings. */
const nodesBlock = driver.slice(
  driver.indexOf('const GRAPH_NODES'),
  driver.indexOf('const FIXTURES'),
)
const nodeList = nodesBlock.slice(nodesBlock.indexOf('['), nodesBlock.indexOf('].map'))
const nodeNames = [...nodeList.matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1])
const peopleBlock = driver.slice(
  driver.indexOf('const GRAPH_PEOPLE'),
  driver.indexOf('const FIXTURES'),
)
const personNames = [
  ...peopleBlock
    .slice(peopleBlock.indexOf('['), peopleBlock.indexOf('].map'))
    .matchAll(/'([A-Za-z]+)'/g),
].map((m) => m[1])
const projectEndpoints = new Set([
  ...projectTriples.flatMap((t) => [t.from, t.to]),
  ...involvement.map((t) => t.to),
])
/** The participants the PROBED project-to-project structure names: the anchor the
 * isolation argument and the involvement targets are both held to (an involvement edge
 * pointing at a filler must not redefine the filler as a participant). */
const projectParticipants = new Set(projectTriples.flatMap((t) => [t.from, t.to]))
const involvementPeople = [...new Set(involvement.map((t) => t.from))]
const countAnchor = Number(driver.match(/data: totalCount\s*\?\s*\[\{ count: (\d+) \}\]/)?.[1])

/** The computation the follow-up's answer is expected to have performed: rank projects by
 * WORKS_ON people, take the top three, union their people. */
const computed = [...new Set(topThree.flatMap((name) => peopleOn(name)))]

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
  it('the canned data is raw relationship triples over the probed vocabulary plus the involvement type', () => {
    expect(triples.length).toBeGreaterThanOrEqual(20)
    for (const triple of triples)
      expect([...PROBED_RELATIONSHIP_TYPES, INVOLVEMENT_TYPE]).toContain(triple.type)
    // WORKS_ON is the ONLY non-probed type: every other triple stays on the probed
    // vocabulary, so the probe-derived structure is widened by exactly one relationship.
    for (const triple of projectTriples) expect(PROBED_RELATIONSHIP_TYPES).toContain(triple.type)
    // The probed schema has no popularity or participants property: people are
    // relationship endpoints and the ranking is WORKS_ON degree. The pin reads the
    // schema block, not the file, so the fixture's own comment naming the probe stays.
    const schema = driver.match(/get_neo4j_schema: \{([\s\S]*?)\n {2}\},/)?.[1] ?? ''
    expect(schema).not.toMatch(/popularity/)
    expect(schema).not.toMatch(/participants/)
    expect(schema).toMatch(/type: 'node'/)
    // The involvement relationship is declared on both labels it connects, in the
    // directions the triples run.
    expect(schema).toMatch(/WORKS_ON: \{ direction: 'in', labels: \['Person'\] \}/)
    expect(schema).toMatch(/WORKS_ON: \{ direction: 'out', labels: \['Project'\] \}/)
    expect(schema).toMatch(/Person: \{/)
  })

  it('every per-type relationship count in the canned schema is derived from the triples', () => {
    const schema = driver.match(/get_neo4j_schema: \{([\s\S]*?)\n {2}\},/)?.[1] ?? ''
    const declared = Object.fromEntries(
      [...schema.matchAll(/(\w+): \{ type: 'relationship', count: (\d+) \}/g)].map((m) => [
        m[1],
        Number(m[2]),
      ]),
    )
    const derived: Record<string, number> = {}
    for (const { type } of triples) derived[type] = (derived[type] ?? 0) + 1
    expect(declared).toEqual(derived)
  })

  it('the exact expected turn-2 answer is the top-3 people union computed from the canned data', () => {
    // The top three must be unambiguous: no tie may straddle the rank-3 boundary.
    expect(ranked[2].people).toBeGreaterThan(ranked[3].people)
    // Every top project's non-involvement relationships are reciprocal, so their
    // structure is the same whether the model reads the edges directed or undirected.
    for (const name of topThree) {
      expect([...new Set(neighbors(name, 'in'))].sort()).toEqual(
        [...new Set(neighbors(name, 'out'))].sort(),
      )
    }
    // The involvement edges run ONE way: person → project, one project per person, so
    // "who is involved" is the WORKS_ON in-neighbours and a project is never its own
    // involvement endpoint.
    for (const triple of involvement) {
      expect(personNames).toContain(triple.from)
      expect(nodeNames).toContain(triple.to)
    }
    expect(involvementPeople.length).toBe(involvement.length)
    // No involvement edge reaches outside the probed project structure: a person works
    // on one of the ten participants, never on an isolated filler.
    for (const triple of involvement) expect(projectParticipants).toContain(triple.to)
    expect(turnFacts[1]).toEqual(computed)
    expect(answerFacts).toEqual(computed)
    // The exact expected answer string, stated in the PR body and graded per name.
    expect(computed).toEqual([
      'Zenith',
      'Nadir',
      'Apogee',
      'Perigee',
      'Azimuth',
      'Meridian',
      'Solstice',
    ])
  })

  it('turn 1 keeps the existing total-count anchor', () => {
    expect(turnFacts[0]).toEqual(['42'])
    expect(messages[1]).toBe(
      'Who is involved in the three projects with the most people working on them?',
    )
    expect(driver).toMatch(/data: totalCount\s*\?\s*\[\{ count: 42 \}\]/)
  })

  it('the fixture does not hand the answer over: no pre-aggregated rows and no top-project self-inclusion', () => {
    // The canned rows are triples, never the degree few-shot's aggregated {name, degree}.
    expect(driver).not.toMatch(/degree:/)
    // The top projects are not their own answer: the expected answer names only the
    // people working ON the top three, never the projects themselves.
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

  it('node-property queries read the miniature graph, not the relationship triples', () => {
    const branch = driver.slice(
      driver.indexOf("name === 'read_neo4j_cypher'"),
      driver.indexOf('return { success: true, data: FIXTURES[name] }'),
    )
    // The discriminator: property access without a traversal pattern — a relationship
    // query that projects properties keeps its triples.
    expect(branch).toMatch(/\\w\+\\.\\w\+/)
    expect(branch).toMatch(/personQuery\s*\?\s*GRAPH_PEOPLE/)
    expect(branch).toMatch(/nodeQuery\s*\?\s*GRAPH_NODES\s*:\s*GRAPH_RELATIONSHIPS/)
    // A Project node read covers every project-side relationship endpoint: the run-7
    // child was handed ten rows against a 42 anchor and read its own data as unreliable
    // before declining (R7DIAG row 07). The rows' COUNT consistency with the anchor is
    // the next pin.
    for (const endpoint of projectEndpoints) expect(nodeNames).toContain(endpoint)
    // The Person rows and the involvement triples agree in both directions: every
    // person named in a WORKS_ON triple has a row, and every row is that triple's person.
    expect(new Set(personNames)).toEqual(new Set(involvementPeople))
    // The two noun families never collide: a person name is never a project name.
    for (const person of personNames) expect(nodeNames).not.toContain(person)
    // The rows are raw node data shaped like the schema's labels (name STRING,
    // observations LIST), and the observations carry no graded fact: the expected answer
    // stays derivable from GRAPH_RELATIONSHIPS alone.
    expect(nodesBlock).toMatch(/observations: \[/)
    const observations = nodesBlock.match(/observations: \[([^\]]*)\]/)?.[1] ?? ''
    for (const name of computed) expect(observations).not.toContain(name)
    expect(observations).not.toMatch(/degree|popularity|USES|CONNECTS_TO|WORKS_ON/)
  })

  it('the Project node rows and the count anchor agree (R7DIAG row 07: the 10-vs-42 defect)', () => {
    // The anchor is the branch literal, not a standalone 42: a count elsewhere in the
    // driver must not satisfy this pin.
    expect(countAnchor).toBe(42)
    // The Project node rows total the anchor: 42 nodes, of which the endpoints are the
    // participants and the rest are isolated.
    expect(new Set(nodeNames).size).toBe(countAnchor)
    // The rows beyond the endpoints are ISOLATED — no triple of any type touches them,
    // so their degree is 0, no person works on one, and neither the top-3 ranking nor
    // the expected answer is changed by them.
    for (const name of new Set(nodeNames)) {
      if (!projectParticipants.has(name)) {
        expect(triples.filter((t) => t.from === name || t.to === name)).toEqual([])
      }
    }
  })

  it('SCENARIOS.md states the same expected answer', () => {
    const section = scenariosMd.slice(
      scenariosMd.indexOf('### 07-follow-up-success'),
      scenariosMd.indexOf('### 08-follow-up-failure'),
    )
    expect(section).toContain(
      'Zenith, Nadir and Apogee on Dune, Perigee and Azimuth on Birch, Meridian and Solstice on Cedar',
    )
    expect(section).toContain(
      'Who is involved in the three projects with the most people working on them?',
    )
  })
})
