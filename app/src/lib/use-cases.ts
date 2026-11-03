/**
 * Static snapshot backing the `/use-cases` page: what the assistant could be
 * asked, and how each question fared in the latest live eval round.
 *
 * Source (data, verbatim fields): `app/evals/general-next/scenarios.catalogue.json`,
 * the scenarios with status "existing" that made up eval run 10 — the ids,
 * priorities and results here are that file's and that round's. Results: run
 * 10, 2026-10-30 — pass 01–07, 09–13, 17; fail 08, 14; gated (not runnable
 * yet) 15, 16. Nothing else from that run is recorded here.
 *
 * The WORDING is the page's own, not the catalogue's, deliberately: the
 * audience is product managers, not the eval harness. The catalogue's turns
 * name the knowledge graph; the questions here say what that means to a
 * reader — the projects and people in the organization. Write-shaped
 * questions may name the org graph itself, and each carries a short title
 * ("Edit the org graph") so the instruction has context. Nothing here is
 * invented: every rewritten sentence still asks what its catalogue scenario
 * asks. Every name, address, document and figure in the questions is
 * synthetic.
 *
 * A static snapshot by design: this page is a guide for people, not a live
 * eval report — update this module when a new round lands.
 */

/** How a question did in the last tested round. */
export type UseCaseResult = 'works' | 'not-yet' | 'coming'

export interface UseCaseQuestion {
  /** The catalogue id — kept for traceability, never shown on the page. */
  id: string
  /** Short title shown above the question, giving the instruction context. */
  title: string
  /** The question as the page words it; the first is what "Try this" fills. */
  turns: string[]
  result: UseCaseResult
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

const q = (id: string, title: string, result: UseCaseResult, turns: string[]): UseCaseQuestion => ({
  id,
  title,
  result,
  turns,
})

export const USE_CASE_SECTIONS: UseCaseSection[] = [
  {
    priority: 'must',
    questions: [
      q('01-greeting', 'A quick hello', 'works', ['Hi! What can you help me with?']),
      q('02-graph-count', 'Count active projects', 'works', [
        'How many projects are currently active in the organization?',
      ]),
      q('03-web-read', 'Search the web', 'works', [
        'Find the Next.js release notes and read the page. What changed in version 15.5?',
      ]),
      q('06-read-only', 'Edit the org graph', 'works', [
        'Add a project called Lantern to the org graph.',
      ]),
      q('09-upload-summary', 'Summarize a document', 'works', [
        'I uploaded lantern-notes.md. Write a short Word summary called lantern-summary.docx and give me the download link.',
      ]),
      q('10-csv-analysis', 'Analyze a spreadsheet', 'works', [
        'Use the uploaded lantern-sales.csv to total revenue by region. Save lantern-totals.csv and tell me the grand total.',
      ]),
      q('11-mail-to-file', 'Turn an email into a document', 'works', [
        'Find the Lantern launch email in my inbox. Turn its checklist into lantern-launch.md and give me the file.',
      ]),
      q('12-retrieve-citation', 'Answer with a citation', 'works', [
        'According to the uploaded lantern-notes.md, what is the release date? Please cite the document.',
      ]),
      q('13-two-sources', 'Cross-check two sources', 'works', [
        'Compare the number of projects in the organization with the target count in lantern-notes.md. How far apart are they? Cite the notes.',
      ]),
      q('17-mail-analysis-follow-up', 'A multi-step analysis', 'works', [
        'Find the Lantern launch email in my inbox. Use its checklist and the uploaded lantern-notes.md and lantern-sales.csv to prepare lantern-launch-analysis.md, index it for this chat, and offer to answer questions.',
        'From that indexed analysis, which region sold more and by how much? Cite the report and include both regional revenues.',
      ]),
    ],
  },
  {
    priority: 'should',
    questions: [
      q('04-library-docs', 'Look up developer docs', 'works', [
        'Find the SolidJS createSignal docs and show me a tiny counter example.',
      ]),
      q('05-memory-lookup', 'Recall what you told it', 'works', [
        'What do you remember about me?',
        'And which release tag do you have noted for it?',
      ]),
      q('07-follow-up-success', 'Build on a previous answer', 'works', [
        'How many projects are currently active in the organization?',
        'Who is involved in the three projects with the most people working on them?',
      ]),
      q('08-follow-up-failure', 'Retry a failed question', 'not-yet', [
        'How many projects are currently active in the organization?',
        'That failed earlier. Please try the same count again now.',
      ]),
      q('14-analysis-index-follow-up', 'Analyze, save, then ask again', 'not-yet', [
        'I uploaded lantern-notes.md and lantern-sales.csv. Analyse sales against the notes, save lantern-analysis.md, index it for this chat, and offer to answer questions about it.',
        'I have indexed lantern-analysis.md from the Data Stash. Which region sold more and by how much? Cite that analysis.',
      ]),
      q('15-graph-file-summary', 'From OneDrive to a summary', 'coming', [
        'Find lantern-brief.docx in my OneDrive, read it, and write lantern-brief-summary.docx.',
      ]),
    ],
  },
  {
    priority: 'nice',
    questions: [
      q('16-graph-files-analysis', 'From OneDrive files to analysis', 'coming', [
        'Find the Lantern budget and actuals spreadsheets in my OneDrive. Compare them, create lantern-variance.md, index it, and let me ask questions about it.',
        'Which item has the largest overspend in that report? Cite it.',
      ]),
    ],
  },
]
