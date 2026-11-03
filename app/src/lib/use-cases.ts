/* @unocss-include — the per-question icon classes below are string literals in
 * a plain `.ts` file, which UnoCSS's default pipeline does not scan. This
 * marker plus the `src/lib/use-cases.ts` entry in `uno.config.ts`'s
 * `content.filesystem` are BOTH required; dropping either emits no icon CSS
 * and every glyph renders as an empty span. */
/**
 * Static snapshot backing the `/use-cases` page: what the assistant could be
 * asked, and how each question fared in the latest live eval round.
 *
 * Source (data, verbatim fields): `app/evals/general-next/scenarios.catalogue.json`,
 * the scenarios with status "existing" that made up eval run 10 — the ids,
 * priorities and results here are that file's and that round's. Results: run
 * 10, 2026-10-30 — pass 01–02, 04–07, 09–13, 17; fail 14; gated (not runnable
 * yet) 15, 16. Nothing else from that run is recorded here.
 *
 * TWO texts ride on every question, deliberately (owner decision, #937 round
 * 3): the page may rephrase for its audience, and "Try this" must send what
 * the eval round actually measured.
 *
 * - `turns` — the catalogue's questions VERBATIM; the data test pins them to
 *   the catalogue file. This is what "Try this" fills the composer with.
 * - `pageTurns` — the page's own wording of the same question, written for
 *   product managers. The catalogue names the knowledge graph and Project
 *   nodes; the page says what that means to a reader — the projects and
 *   people in the organization. The write-shaped question keeps the owner's
 *   org-graph phrasing, and each carries a short title so the instruction has
 *   context. Nothing here is invented: every rewritten sentence still asks
 *   what its catalogue scenario asks. Every name, address, document and
 *   figure in the questions is synthetic.
 *
 * One question has NO catalogue entry: the web-search question was rewritten
 * for the page's audience (owner, round 4 — the Next.js release-notes question
 * meant nothing to a project manager), and the rewritten question has not been
 * through an eval round yet. It carries result `untested` and offers no
 * "Try this"; when a round runs it, it gains its result here.
 *
 * `rank` orders the cards within a section, most relevant to a project
 * manager first (owner, round 4) — an explicit field, not array order by
 * accident; the data test pins array order to it.
 *
 * Developer terms that would otherwise reach the page are mapped to plain
 * words at render time (`PLAIN_WORDS` below): the data stays verbatim, the
 * rendered page does not show the term.
 *
 * A static snapshot by design: this page is a guide for people, not a live
 * eval report — update this module when a new round lands.
 */

/** How a question did in the last tested round. `untested` is a question the
 *  page carries that no round has run yet — it offers no "Try this". */
export type UseCaseResult = 'works' | 'not-yet' | 'coming' | 'untested'

export interface UseCaseQuestion {
  /** The catalogue id — kept for traceability, never shown on the page. A
   *  question with no catalogue entry (the `untested` one) carries a
   *  non-catalogue id instead. */
  id: string
  /** Short title shown above the question, giving the instruction context. */
  title: string
  /** The catalogue's turns, verbatim — what "Try this" sends. */
  turns: string[]
  /** The question as the page words it for PMs — what the page shows. Same
   *  shape as `turns`, turn for turn. */
  pageTurns: string[]
  result: UseCaseResult
  /** Card order within its section, 1 = first shown — most relevant to a
   *  project manager first (owner, round 4). */
  rank: number
  /** The material-symbols icon class the card renders beside its title.
   *  Decorative (`aria-hidden`); the class literal must stay in this file —
   *  see the `@unocss-include` note at the top. */
  icon: string
}

export interface UseCaseSection {
  /** Catalogue priority: `must` | `should` | `nice`. */
  priority: 'must' | 'should' | 'nice'
  questions: UseCaseQuestion[]
}

/** Query parameter the "Try this" buttons ride on: `/?q=<first turn>`. The
 *  chat route reads it once to prefill the composer and strips it from the
 *  URL, so a reload does not re-prefill. */
export const QUESTION_DRAFT_PARAM = 'q'

/** Upper bound on a `?q=` draft. 2,000 characters is ample for every question
 *  this page offers (the longest is ~250); the cap is enforced where the chat
 *  route reads the parameter, so an abuse-shaped link cannot stuff the
 *  composer with megabytes of URL. */
export const QUESTION_DRAFT_MAX_CHARS = 2_000

/** When the recorded round ran — shown once on the page. */
export const USE_CASES_TESTED_ON = '30 October 2026'

/** Time of day the round's results were recorded at, when the round records
 *  one. Run 10 recorded only a date, so this is unset and the page shows the
 *  date alone; a later round that records a time sets it here (24h, as the
 *  page renders it — "Data updated: <date>, <time>"). */
export const USE_CASES_TESTED_AT: string | undefined = undefined

/** Developer terms the page would otherwise show, each with its plain-words
 *  counterpart (owner decision, #937 round 3). The catalogue's section
 *  priorities and infrastructure names mean nothing to a product manager;
 *  every rendered string on the page goes through `plainWords`, so the term
 *  survives only in this file's data. Keys carry the article where the
 *  catalogue's sentence has one, so the replacement reads naturally —
 *  "from the Data Stash" becomes "from your uploaded files". */
export const PLAIN_WORDS: Record<string, string> = {
  Must: 'Works today',
  Should: 'Nearly there',
  'Nice to have': 'On the way',
  'the Data Stash': 'your uploaded files',
}

/** Replace every developer term with its plain-words counterpart. Longest
 *  keys first, so 'Nice to have' is replaced whole rather than piecemeal. */
export const plainWords = (text: string): string => {
  let out = text
  for (const term of Object.keys(PLAIN_WORDS).sort((a, b) => b.length - a.length)) {
    out = out.split(term).join(PLAIN_WORDS[term]!)
  }
  return out
}

/** `pageTurns` defaults to `turns`: most questions are worded the same for the
 *  page and the catalogue, and only the rephrased ones carry both. */
const q = (
  id: string,
  title: string,
  result: UseCaseResult,
  icon: string,
  rank: number,
  turns: string[],
  pageTurns: string[] = turns,
): UseCaseQuestion => ({ id, title, turns, pageTurns, result, rank, icon })

export const USE_CASE_SECTIONS: UseCaseSection[] = [
  {
    priority: 'must',
    questions: [
      q(
        '02-graph-count',
        'Count active projects',
        'works',
        'i-material-symbols-analytics',
        1,
        ['How many Project nodes are in the knowledge graph?'],
        ['How many projects are currently active in the organization?'],
      ),
      q('09-upload-summary', 'Summarize a document', 'works', 'i-material-symbols-summarize', 2, [
        'I uploaded lantern-notes.md. Write a short Word summary called lantern-summary.docx and give me the download link.',
      ]),
      q('10-csv-analysis', 'Analyze a spreadsheet', 'works', 'i-material-symbols-table-chart', 3, [
        'Use the uploaded lantern-sales.csv to total revenue by region. Save lantern-totals.csv and tell me the grand total.',
      ]),
      q('11-mail-to-file', 'Turn an email into a document', 'works', 'i-material-symbols-mail', 4, [
        'Find the Lantern launch email in my inbox. Turn its checklist into lantern-launch.md and give me the file.',
      ]),
      q(
        '13-two-sources',
        'Cross-check two sources',
        'works',
        'i-material-symbols-compare',
        5,
        [
          'Compare the Project count in the knowledge graph with the target count in lantern-notes.md. How far apart are they? Cite the notes.',
        ],
        [
          'Compare the number of projects in the organization with the target count in lantern-notes.md. How far apart are they? Cite the notes.',
        ],
      ),
      q(
        '12-retrieve-citation',
        'Answer with a citation',
        'works',
        'i-material-symbols-format-quote',
        6,
        [
          'According to the uploaded lantern-notes.md, what is the release date? Please cite the document.',
        ],
      ),
      q(
        '17-mail-analysis-follow-up',
        'A multi-step analysis',
        'works',
        'i-material-symbols-timeline',
        7,
        [
          'Find the Lantern launch email in my inbox. Use its checklist and the uploaded lantern-notes.md and lantern-sales.csv to prepare lantern-launch-analysis.md, index it for this chat, and offer to answer questions.',
          'From that indexed analysis, which region sold more and by how much? Cite the report and include both regional revenues.',
        ],
      ),
      q(
        '06-read-only',
        'Edit the org graph',
        'works',
        'i-material-symbols-edit-note',
        8,
        ['Create a Project node named Lantern in the knowledge graph.'],
        ['Add a project called Lantern to the org graph.'],
      ),
      // The web-search question was rewritten for this page's audience (owner,
      // round 4): a project manager asks for public guidance on their own
      // work, not a framework's release notes. No eval round has run it yet,
      // so it is `untested` and offers no "Try this".
      q('pm-web-guidance', 'Search the web', 'untested', 'i-material-symbols-search', 9, [
        'Search the web for recent public guidance on project status reporting and summarize the three most common recommendations.',
      ]),
      q('01-greeting', 'A quick hello', 'works', 'i-material-symbols-waving-hand', 10, [
        'Hi! What can you help me with?',
      ]),
    ],
  },
  {
    priority: 'should',
    questions: [
      q(
        '05-memory-lookup',
        'Recall what you told it',
        'works',
        'i-material-symbols-psychology',
        1,
        ['What do you remember about me?', 'And which release tag do you have noted for it?'],
      ),
      q(
        '07-follow-up-success',
        'Build on a previous answer',
        'works',
        'i-material-symbols-forum',
        2,
        [
          'How many Project nodes are in the knowledge graph?',
          'Who is involved in the three projects with the most people working on them?',
        ],
        [
          'How many projects are currently active in the organization?',
          'Who is involved in the three projects with the most people working on them?',
        ],
      ),
      q('04-library-docs', 'Look up developer docs', 'works', 'i-material-symbols-menu-book', 3, [
        'Find the SolidJS createSignal docs and show me a tiny counter example.',
      ]),
      q(
        '14-analysis-index-follow-up',
        'Analyze, save, then ask again',
        'not-yet',
        'i-material-symbols-save',
        4,
        [
          'I uploaded lantern-notes.md and lantern-sales.csv. Analyse sales against the notes, save lantern-analysis.md, index it for this chat, and offer to answer questions about it.',
          'I have indexed lantern-analysis.md from the Data Stash. Which region sold more and by how much? Cite that analysis.',
        ],
      ),
      q(
        '15-graph-file-summary',
        'From OneDrive to a summary',
        'coming',
        'i-material-symbols-cloud',
        5,
        ['Find lantern-brief.docx in my OneDrive, read it, and write lantern-brief-summary.docx.'],
      ),
    ],
  },
  {
    priority: 'nice',
    questions: [
      q(
        '16-graph-files-analysis',
        'From OneDrive files to analysis',
        'coming',
        'i-material-symbols-folder-open',
        1,
        [
          'Find the Lantern budget and actuals spreadsheets in my OneDrive. Compare them, create lantern-variance.md, index it, and let me ask questions about it.',
          'Which item has the largest overspend in that report? Cite it.',
        ],
      ),
    ],
  },
]
