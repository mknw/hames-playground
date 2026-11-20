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
 * - drop the `toolsNotBefore` case (r2) → "the #1058 web-last grader" goes red.
 * - remove the `toolsNotBefore` wiring from grade() (r3) → "grade() runs the
 *   #1058 toolsNotBefore graders" goes red.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  catalogueGraders,
  resolveShared,
  type GraderCatalogue,
} from '../../../lib/eval-support/catalogue-graders'
import type {
  ConversationScenario,
  ConversationTrace,
} from '../../../lib/eval-support/conversation'
// conversation-checks reads a server-only extractor; the repo's usual mock.
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({ assertServerOnImport: vi.fn() }))
import {
  answerNotMatchesCheck,
  grade,
  toolsNotBeforeCheck,
} from '../../../lib/eval-support/conversation-checks'

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

  // #1058: the two projects rows' answerNotMatches graders exist for the release
  // turn's actual deflections ("no dedicated Project node… consult internal
  // documentation"). r2 (review): the release reply is "consult internal DTSC
  // documentation" — the org name between the words — so the pattern tolerates a
  // few words there and spells organi[sz]ation both ways. r3 (review): the prefix
  // is consult(?:ing)?\b, not consult\w* — \w* also matched "consulted", so a
  // CORRECT answer reporting what it did failed the row on the pattern alone
  // ("I consulted your internal SharePoint documentation: …", a wording the
  // prompt itself invites), and it was quadratic on a consult-repeat. MUTATION
  // (red): reword either pattern so any phrasing below slips through, or drop
  // its negate.
  it('the #1058 deflection graders fail the release answers they exist for', () => {
    const replies = [
      'There is no dedicated Project node; please consult internal documentation for the organisation’s projects.',
      'No dedicated Project node was found, so I cannot answer; please consult internal documentation.',
      // The release reply verbatim, org name included.
      'I could not find a dedicated Project node; please consult internal DTSC documentation.',
      'I found nothing in the graph; please consult internal Lantern documentation.',
      'Try consulting your internal documentation for the projects.',
      'The answer requires someone who consults internal documentation.',
      'Please arrange a consultation of internal documentation for the projects.',
      "I cannot find your company's projects; please consult your company's internal project documentation.",
      'Please contact the organization for its projects.',
      'Please contact the organisation.',
      'There is no project information here; you may want to ask your colleagues.',
    ]
    const correct = [
      'I searched the knowledge graph and your SharePoint files; the active projects are Lantern Portal and Lantern Field Ops.',
      'The active projects are Lantern Portal, Lantern Field Ops and Lantern Beacon.',
      // r3 must-pass: the past tense reports a search that happened and answers
      // from it — not a deferral. The old consult\w* prefix failed this sentence.
      'I consulted your internal SharePoint documentation: the active projects are Lantern Portal and Lantern Field Ops.',
    ]
    for (const id of ['49-org-projects-office-source', '50-org-projects-in-graph']) {
      const negated = (catalogueGraders(catalogue, id).answerPatterns ?? []).filter((p) => p.negate)
      expect(negated.length, id).toBeGreaterThan(0)
      for (const p of negated) {
        for (const reply of replies)
          expect(answerNotMatchesCheck(reply, p.pattern).pass, `${id}: ${p.says}: ${reply}`).toBe(
            false,
          )
        // The answers the rows grade as correct still pass.
        for (const reply of correct)
          expect(answerNotMatchesCheck(reply, p.pattern).pass, `${id}: ${p.says}`).toBe(true)
      }
    }
  })

  // #1058 r2 (review): "web last" is graded, not only claimed. orderedTools checks
  // the tools as a SUBSEQUENCE and forbiddenTools is empty (its read-only refusal
  // wording does not fit this row), so a live run that goes graph → web → files
  // passed both before. The row's toolsNotBefore grader fails it. MUTATION (red):
  // drop the `toolsNotBefore` case from catalogueGraders. The grade() WIRING is not
  // this test's to catch — nothing here calls grade() (the r3 review dropped that
  // line from grade() and every repo test stayed green); the grade()-level test
  // below owns that mutation.
  it('the #1058 web-last grader fails a web-before-office trace and passes the office-first one', () => {
    const spec = catalogueGraders(catalogue, '49-org-projects-office-source').toolsNotBefore
    expect(spec).toMatchObject({
      says: expect.any(String),
      tools: ['search', 'fetch', 'fetch_content', 'web_search_exa', 'web_fetch_exa'],
      before: 'graph_files_search',
    })
    const call = (name: string) => ({ name, success: true })
    // graph → web → files: the exact trace the review caught passing.
    expect(
      toolsNotBeforeCheck(
        [call('read_neo4j_cypher'), call('search'), call('graph_files_search')],
        spec!,
      ).pass,
    ).toBe(false)
    // graph → files: the row's own order.
    expect(
      toolsNotBeforeCheck([call('read_neo4j_cypher'), call('graph_files_search')], spec!).pass,
    ).toBe(true)
    // graph → files → web: the web after the office search is not this check's failure.
    expect(
      toolsNotBeforeCheck(
        [call('read_neo4j_cypher'), call('graph_files_search'), call('fetch')],
        spec!,
      ).pass,
    ).toBe(true)
    // web only: the office source was never reached, so every web call fails it.
    expect(toolsNotBeforeCheck([call('search')], spec!).pass).toBe(false)
    // nothing ran: orderedTools' failure, never a vacuous pass here.
    expect(toolsNotBeforeCheck([], spec!).pass).toBe(true)
  })

  // #1058 r3 (review): the old consult\w* prefix was quadratic on a long word
  // that repeats "consult" ('consult'.repeat(8000) + ' internal' graded in 38 s);
  // the \b prefix fails each position without the \w* backtrack, so both
  // consult-repeat bombs grade in bounded time — a grader that slow would time
  // out the live row it belongs to.
  it('the #1058 deflection pattern grades the consult-repeat bombs in bounded time', () => {
    const bombs = [
      'consult'.repeat(8000) + ' internal',
      'consult' + 'a'.repeat(50000) + ' internal',
    ]
    for (const id of ['49-org-projects-office-source', '50-org-projects-in-graph']) {
      const pattern = (catalogueGraders(catalogue, id).answerPatterns ?? []).find(
        (p) => p.negate && /consult/.test(p.pattern),
      )!
      for (const bomb of bombs) {
        const start = performance.now()
        const graded = answerNotMatchesCheck(bomb, pattern.pattern)
        expect(performance.now() - start, `${id}: ${bomb.length} chars`).toBeLessThan(200)
        // Neither bomb defers to documentation, so the check completes and passes.
        expect(graded.pass, id).toBe(true)
      }
    }
  })

  // #1058 r3 (review): row 51's expected says "never to the office route's files
  // first", but nothing graded it — orderedTools is a subsequence check, so it
  // passes a files-before-web run. The row's toolsNotBefore is the mirror of 49's
  // web-last rule: the public web, not the organisation's own files first.
  it('the #1058 public-org row grades the web before the office files', () => {
    const spec = catalogueGraders(catalogue, '51-org-projects-public-org').toolsNotBefore
    expect(spec).toMatchObject({
      says: expect.any(String),
      tools: ['graph_files_search', 'graph_files_list', 'graph_files_recent', 'graph_files_shared'],
      before: 'search',
    })
    const call = (name: string) => ({ name, success: true })
    // files → search: the office route first, exactly the misroute the row forbids.
    expect(toolsNotBeforeCheck([call('graph_files_search'), call('search')], spec!).pass).toBe(
      false,
    )
    // search → files: the web first; the office route after it is not this check's failure.
    expect(toolsNotBeforeCheck([call('search'), call('graph_files_recent')], spec!).pass).toBe(true)
    // search only: nothing preceded it, and orderedTools grades that the search ran.
    expect(toolsNotBeforeCheck([call('search')], spec!).pass).toBe(true)
  })

  // #1058 r3 (review): the toolsNotBefore graders must reach the trace through
  // grade() itself. The mapping test and the check-level tests above cannot see
  // that wiring — the r3 review removed the grade() line and every repo test
  // stayed green, so only an ad-hoc grade() call caught it. MUTATION (red):
  // remove the `if (s.toolsNotBefore)` line from grade() and the checks this
  // test looks up by their says text are gone.
  it('grade() runs the #1058 toolsNotBefore graders (49 web-last, 51 files-last)', () => {
    const bare = (id: string): ConversationScenario => ({
      id: 'grade-level',
      title: 'Grade',
      priority: 'must',
      baseline: false,
      p4: false,
      messages: ['What projects are active?'],
      expectedTools: [],
      expectedRoutes: [],
      answerIncludes: [],
      artifacts: [],
      forbiddenTools: [],
      maxIterations: 6,
      ...catalogueGraders(catalogue, id),
    })
    const trace = (...names: string[]): ConversationTrace => ({
      turns: [
        {
          response: 'The active projects are Lantern Portal and Lantern Field Ops.',
          status: 'running',
          events: [],
        },
      ],
      tools: names.map((name) => ({ name, args: {}, success: true, turn: 0 })),
      artifacts: [],
      indexed: [],
      retrievals: [],
    })
    const graded = (id: string, ...names: string[]) => {
      const s = bare(id)
      const found = grade(s, trace(...names), false).find((c) => c.name === s.toolsNotBefore!.says)
      expect(
        found,
        `${id}: the ${s.toolsNotBefore!.says} check is missing from grade()`,
      ).toBeDefined()
      return found!
    }
    // 49: a web call before the office files search fails; graph → files passes.
    expect(
      graded('49-org-projects-office-source', 'read_neo4j_cypher', 'search', 'graph_files_search')
        .pass,
    ).toBe(false)
    expect(
      graded('49-org-projects-office-source', 'read_neo4j_cypher', 'graph_files_search').pass,
    ).toBe(true)
    // 51: an office files call before the web search fails; the web first passes.
    expect(graded('51-org-projects-public-org', 'graph_files_search', 'search').pass).toBe(false)
    expect(graded('51-org-projects-public-org', 'search', 'graph_files_search').pass).toBe(true)
    expect(graded('51-org-projects-public-org', 'graph_files_shared', 'search').pass).toBe(false)
    expect(graded('51-org-projects-public-org', 'search', 'graph_files_shared').pass).toBe(true)
  })

  it('an unknown row throws at module load', () => {
    expect(() => catalogueGraders(catalogue, 'p99-nothing')).toThrow(/No catalogue row/)
  })

  // #989 review: tn35's "no remember claim" is a memory-OFF grader. With memory on and a
  // real write (the store step inserts, reinforces or updates), a reply that says the
  // preference is saved is true, and no catalogue grader may fail it.
  // MUTATION (red): add tn35's "no remember claim" answerNotMatches to 19-memory-save-recall.
  it('memory-on rows that write never grade a "saved" reply as a false claim', () => {
    const writes = rows.filter((r) =>
      (catalogueGraders(catalogue, r.id).memoryExpect?.answered ?? []).some(
        (a) => a.outcome === 'written',
      ),
    )
    expect(writes.map((r) => r.id)).toContain('19-memory-save-recall')
    for (const r of writes)
      for (const p of catalogueGraders(catalogue, r.id).answerPatterns ?? [])
        if (p.negate)
          for (const reply of ['I have saved your preference.', 'Ik heb je voorkeur opgeslagen.'])
            expect(answerNotMatchesCheck(reply, p.pattern).pass, `${r.id}: ${p.says}`).toBe(true)
    // The same reply is exactly what tn35 (memory off) must fail.
    const tn35 = catalogueGraders(catalogue, 'tn35-remember-preference').answerPatterns ?? []
    expect(
      tn35.some(
        (p) => p.negate && !answerNotMatchesCheck('Ik heb je voorkeur opgeslagen.', p.pattern).pass,
      ),
    ).toBe(true)
  })
})
