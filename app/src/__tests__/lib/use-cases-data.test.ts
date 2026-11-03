/**
 * The use-cases snapshot (`lib/use-cases.ts`) against its own source.
 *
 * The page renders this module, never the catalogue, so the pins here are the
 * only thing keeping the two honest with each other. Two texts ride on every
 * question (owner decision, #937 round 3), and each is pinned separately:
 *
 * - `turns` — the catalogue's questions VERBATIM, against
 *   `evals/general-next/scenarios.catalogue.json`: this is what "Try this"
 *   sends, the wording the eval round actually measured. The `untested`
 *   question is exempt — it has no catalogue entry, because no round has run
 *   it yet.
 * - `pageTurns` — the page's own wording, pinned sentence by sentence in this
 *   file: it is hand-written for PMs, so an accidental edit to a title or a
 *   sentence fails here before it ships. Nothing is invented: each rewritten
 *   sentence still asks what its catalogue scenario asks.
 *
 * The card order is pinned twice over (owner, round 4): `rank` is an explicit
 * field on every question, and the section arrays must already be in rank
 * order — array order is what renders, so rank that disagrees with it would be
 * decoration.
 *
 * The results are the recorded outcomes of eval run 10 (2026-10-30) for the
 * questions the page still carries from that round — the dispatch's
 * enumeration, held here as data so a hand edit to one side fails loudly
 * rather than quietly disagreeing.
 *
 * Like `scenario-catalogue.test.ts`, the catalogue is read as text: src/ may
 * not import evals/.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PLAIN_WORDS,
  QUESTION_DRAFT_PARAM,
  USE_CASES_TESTED_AT,
  USE_CASES_TESTED_ON,
  USE_CASE_SECTIONS,
} from '../../lib/use-cases'

type Json = Record<string, unknown>
const APP = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const catalogue: { scenarios: Json[] } = JSON.parse(
  readFileSync(join(APP, 'evals/general-next/scenarios.catalogue.json'), 'utf8'),
)

const flat = USE_CASE_SECTIONS.flatMap((s) => s.questions)
const catalogueById = new Map(catalogue.scenarios.map((s) => [s.id as string, s]))

/** Run 10 (2026-10-30), exactly as recorded for the questions still on the
 *  page from that round: pass / fail / gated. The rewritten web-search
 *  question is not in the round (pinned separately below), and the
 *  retry-a-failed-question scenario was removed from the page entirely. */
const RUN_10 = {
  works: ['01', '02', '04', '05', '06', '07', '09', '10', '11', '12', '13', '17'],
  'not-yet': ['14'],
  coming: ['15', '16'],
}

/** The page's own wording, pinned sentence by sentence IN SECTION ORDER: the
 *  PM text is hand-written, so an accidental edit to a title or a sentence
 *  fails here before it ships (the catalogue turns have their own verbatim
 *  pin above). */
const PAGE_TEXT: Array<{ id: string; title: string; pageTurns: string[] }> = [
  {
    id: '02-graph-count',
    title: 'Count active projects',
    pageTurns: ['How many projects are currently active in the organization?'],
  },
  {
    id: '09-upload-summary',
    title: 'Summarize a document',
    pageTurns: [
      'I uploaded lantern-notes.md. Write a short Word summary called lantern-summary.docx and give me the download link.',
    ],
  },
  {
    id: '10-csv-analysis',
    title: 'Analyze a spreadsheet',
    pageTurns: [
      'Use the uploaded lantern-sales.csv to total revenue by region. Save lantern-totals.csv and tell me the grand total.',
    ],
  },
  {
    id: '11-mail-to-file',
    title: 'Turn an email into a document',
    pageTurns: [
      'Find the Lantern launch email in my inbox. Turn its checklist into lantern-launch.md and give me the file.',
    ],
  },
  {
    id: '13-two-sources',
    title: 'Cross-check two sources',
    pageTurns: [
      'Compare the number of projects in the organization with the target count in lantern-notes.md. How far apart are they? Cite the notes.',
    ],
  },
  {
    id: '12-retrieve-citation',
    title: 'Answer with a citation',
    pageTurns: [
      'According to the uploaded lantern-notes.md, what is the release date? Please cite the document.',
    ],
  },
  {
    id: '17-mail-analysis-follow-up',
    title: 'A multi-step analysis',
    pageTurns: [
      'Find the Lantern launch email in my inbox. Use its checklist and the uploaded lantern-notes.md and lantern-sales.csv to prepare lantern-launch-analysis.md, index it for this chat, and offer to answer questions.',
      'From that indexed analysis, which region sold more and by how much? Cite the report and include both regional revenues.',
    ],
  },
  {
    id: '06-read-only',
    title: 'Edit the org graph',
    pageTurns: ['Add a project called Lantern to the org graph.'],
  },
  {
    id: 'pm-web-guidance',
    title: 'Search the web',
    pageTurns: [
      'Search the web for recent public guidance on project status reporting and summarize the three most common recommendations.',
    ],
  },
  {
    id: '01-greeting',
    title: 'A quick hello',
    pageTurns: ['Hi! What can you help me with?'],
  },
  {
    id: '05-memory-lookup',
    title: 'Recall what you told it',
    pageTurns: [
      'What do you remember about me?',
      'And which release tag do you have noted for it?',
    ],
  },
  {
    id: '07-follow-up-success',
    title: 'Build on a previous answer',
    pageTurns: [
      'How many projects are currently active in the organization?',
      'Who is involved in the three projects with the most people working on them?',
    ],
  },
  {
    id: '04-library-docs',
    title: 'Look up developer docs',
    pageTurns: ['Find the SolidJS createSignal docs and show me a tiny counter example.'],
  },
  {
    id: '14-analysis-index-follow-up',
    title: 'Analyze, save, then ask again',
    pageTurns: [
      'I uploaded lantern-notes.md and lantern-sales.csv. Analyse sales against the notes, save lantern-analysis.md, index it for this chat, and offer to answer questions about it.',
      // The catalogue's own word rides the page text here — `plainWords`
      // replaces it at render, and the page test fails if it leaks through.
      'I have indexed lantern-analysis.md from the Data Stash. Which region sold more and by how much? Cite that analysis.',
    ],
  },
  {
    id: '15-graph-file-summary',
    title: 'From OneDrive to a summary',
    pageTurns: [
      'Find lantern-brief.docx in my OneDrive, read it, and write lantern-brief-summary.docx.',
    ],
  },
  {
    id: '16-graph-files-analysis',
    title: 'From OneDrive files to analysis',
    pageTurns: [
      'Find the Lantern budget and actuals spreadsheets in my OneDrive. Compare them, create lantern-variance.md, index it, and let me ask questions about it.',
      'Which item has the largest overspend in that report? Cite it.',
    ],
  },
]

/** The card order within each section, most relevant to a project manager
 *  first (owner, round 4). The `rank` field and the section arrays must agree
 *  with this — array order is what renders. */
const EXPECTED_ORDER: Record<'must' | 'should' | 'nice', string[]> = {
  must: [
    '02-graph-count',
    '09-upload-summary',
    '10-csv-analysis',
    '11-mail-to-file',
    '13-two-sources',
    '12-retrieve-citation',
    '17-mail-analysis-follow-up',
    '06-read-only',
    'pm-web-guidance',
    '01-greeting',
  ],
  should: [
    '05-memory-lookup',
    '07-follow-up-success',
    '04-library-docs',
    '14-analysis-index-follow-up',
    '15-graph-file-summary',
  ],
  nice: ['16-graph-files-analysis'],
}

describe('use-cases data', () => {
  it('carries exactly the 16 page questions, each unique', () => {
    expect(flat).toHaveLength(16)
    expect(new Set(flat.map((q) => q.id)).size).toBe(16)
  })

  it('every tested question exists in the catalogue with status "existing"', () => {
    for (const q of flat.filter((q) => q.result !== 'untested')) {
      const row = catalogueById.get(q.id)
      expect(row, `catalogue is missing ${q.id}`).toBeDefined()
      expect(row!.status).toBe('existing')
    }
  })

  it('the untested question has no catalogue entry — no round has run it', () => {
    const untested = flat.filter((q) => q.result === 'untested')
    expect(untested.map((q) => q.id)).toEqual(['pm-web-guidance'])
    expect(catalogueById.get('pm-web-guidance')).toBeUndefined()
  })

  it('carries the catalogue turns verbatim for tested questions — "Try this" sends the catalogue question', () => {
    for (const q of flat.filter((q) => q.result !== 'untested')) {
      expect(q.turns, q.id).toEqual(catalogueById.get(q.id)!.turns)
    }
  })

  it('carries the page text exactly as written for PMs, in section order', () => {
    expect(flat.map((q) => ({ id: q.id, title: q.title, pageTurns: q.pageTurns }))).toEqual(
      PAGE_TEXT,
    )
  })

  it('orders each section by rank, most relevant to a project manager first', () => {
    // Owner, round 4: the order is an explicit `rank` field, not array order
    // by accident. Both halves pinned: the ids in array order, and the ranks
    // sequential from 1 — so reordering the array without renumbering rank
    // (or renumbering without reordering) fails here.
    for (const section of USE_CASE_SECTIONS) {
      const ids = section.questions.map((q) => q.id)
      expect(ids, section.priority).toEqual(EXPECTED_ORDER[section.priority])
      const ranks = section.questions.map((q) => q.rank)
      expect(ranks, section.priority).toEqual(ranks.map((_, i) => i + 1))
    }
  })

  it('gives every question one material-symbols icon literal', () => {
    for (const q of flat) {
      expect(q.icon, q.id).toMatch(/^i-material-symbols(-light)?-[a-z0-9-]+$/)
    }
  })

  it('carries a short title for every question', () => {
    for (const q of flat) {
      expect(q.title.length, `${q.id} title`).toBeGreaterThan(0)
      expect(q.title.length, `${q.id} title`).toBeLessThanOrEqual(40)
    }
  })

  it('words the questions for PMs: the graph is never named except the owned org-graph write', () => {
    for (const q of flat) {
      for (const t of [q.title, ...q.pageTurns]) {
        expect(t).not.toMatch(/neo4j/i)
        expect(t).not.toMatch(/knowledge graph/i)
        // 'graph' survives only inside the owned phrase 'org graph'.
        for (const m of t.matchAll(/graph/g)) {
          expect(t.slice(Math.max(0, (m.index ?? 0) - 4), m.index), `${q.id}: ${t}`).toMatch(
            /org $/i,
          )
        }
      }
    }
    // The write-shaped question is the one place the owner allows the org
    // graph to be named, and its title is the context that makes it clear.
    const orgGraph = flat.filter((q) => q.pageTurns.some((t) => t.includes('org graph')))
    expect(orgGraph.map((q) => q.id)).toEqual(['06-read-only'])
    expect(orgGraph[0]!.title).toBe('Edit the org graph')
    expect(orgGraph[0]!.pageTurns[0]).toBe('Add a project called Lantern to the org graph.')
  })

  it('keeps the count questions in the audience’s own words', () => {
    expect(flat.find((q) => q.id === '02-graph-count')!.pageTurns[0]).toBe(
      'How many projects are currently active in the organization?',
    )
  })

  it('names the day the round ran, and no time it never recorded', () => {
    expect(USE_CASES_TESTED_ON).toBe('30 October 2026')
    // Run 10 recorded only a date. A time appears here only when a round
    // actually records one — never invented.
    expect(USE_CASES_TESTED_AT).toBeUndefined()
  })

  it('the section grouping matches each catalogue priority', () => {
    for (const section of USE_CASE_SECTIONS) {
      for (const q of section.questions) {
        if (q.result === 'untested') continue // no catalogue entry yet
        expect(catalogueById.get(q.id)!.priority).toBe(section.priority)
      }
    }
  })

  it('results are exactly run 10 for the questions that round measured', () => {
    for (const [result, prefixes] of Object.entries(RUN_10)) {
      for (const prefix of prefixes) {
        const q = flat.find((candidate) => candidate.id.startsWith(prefix))
        expect(q, `no question with id prefix ${prefix}`).toBeDefined()
        expect(q!.result, `${q!.id}`).toBe(result)
      }
    }
    // The rewritten web-search question is new — the page says so, not a
    // borrowed result from the Next.js question it replaced.
    expect(flat.find((q) => q.id === 'pm-web-guidance')!.result).toBe('untested')
  })

  it('every result is one of the four the page knows how to render', () => {
    for (const q of flat) expect(['works', 'not-yet', 'coming', 'untested']).toContain(q.result)
  })

  it('keeps the two texts the same shape, turn for turn', () => {
    for (const q of flat) {
      expect(q.pageTurns, q.id).toHaveLength(q.turns.length)
    }
    // Five of the sixteen carry follow-ups — the page's "then ask:" cases.
    expect(flat.filter((q) => q.pageTurns.length > 1)).toHaveLength(5)
  })

  it('maps exactly the developer terms the page would otherwise show', () => {
    // Every key of the plain-words map must occur in what the page renders —
    // the section labels the page maps, or the page text. A key that appears
    // nowhere is a stale entry pretending to protect the reader.
    const page = flat
      .flatMap((q) => [q.title, ...q.pageTurns])
      .concat(['Must', 'Should', 'Nice to have'])
      .join('\n')
    for (const term of Object.keys(PLAIN_WORDS)) {
      expect(page, `no page text carries "${term}"`).toContain(term)
    }
  })

  it('hands "Try this" its query parameter', () => {
    expect(QUESTION_DRAFT_PARAM).toBe('q')
  })
})
