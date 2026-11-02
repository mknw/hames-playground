/**
 * Static snapshot backing the `/use-cases` page: what the assistant could be
 * asked, and how each question fared in the latest live eval round.
 *
 * Source (data, verbatim fields): `app/evals/general-next/scenarios.catalogue.json`,
 * the scenarios with status "existing" that made up eval run 10 — only fields
 * already public in that file are carried here (id, title, priority, user turns).
 * Results: run 10, 2026-10-30 — pass 01–07, 09–13, 17; fail 08, 14; gated
 * (not runnable yet) 15, 16. Nothing else from that run is recorded here.
 * Every name, address, document and figure in the questions is synthetic.
 *
 * A static snapshot by design: this page is a guide for people, not a live
 * eval report — update this module when a new round lands.
 */

/** How a question did in the last tested round. */
export type UseCaseResult = 'works' | 'not-yet' | 'coming'

export interface UseCaseQuestion {
  /** The catalogue id — kept for traceability, never shown on the page. */
  id: string
  /** Plain-language title, from the catalogue. */
  title: string
  /** The user turns as asked; the first is the question the page offers. */
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

/** When the recorded round ran — shown once on the page. */
export const USE_CASES_TESTED_ON = '30 October 2026'

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
      q('01-greeting', 'A short answer without tools', 'works', ['Hi! What can you help me with?']),
      q('02-graph-count', 'Read the knowledge graph', 'works', [
        'How many Project nodes are in the knowledge graph?',
      ]),
      q('03-web-read', 'Search, then read a source', 'works', [
        'Find the Next.js release notes and read the page. What changed in version 15.5?',
      ]),
      q('06-read-only', 'Explain a missing write capability', 'works', [
        'Create a Project node named Lantern in the knowledge graph.',
      ]),
      q('09-upload-summary', 'Read an uploaded document and produce a summary', 'works', [
        'I uploaded lantern-notes.md. Write a short Word summary called lantern-summary.docx and give me the download link.',
      ]),
      q('10-csv-analysis', 'Compute from an uploaded CSV', 'works', [
        'Use the uploaded lantern-sales.csv to total revenue by region. Save lantern-totals.csv and tell me the grand total.',
      ]),
      q('11-mail-to-file', 'Find synthetic mail, then create a document', 'works', [
        'Find the Lantern launch email in my inbox. Turn its checklist into lantern-launch.md and give me the file.',
      ]),
      q('12-retrieve-citation', 'Answer from an uploaded document with a locator', 'works', [
        'According to the uploaded lantern-notes.md, what is the release date? Please cite the document.',
      ]),
      q('13-two-sources', 'Combine the knowledge graph and uploaded notes', 'works', [
        'Compare the Project count in the knowledge graph with the target count in lantern-notes.md. How far apart are they? Cite the notes.',
      ]),
      q(
        '17-mail-analysis-follow-up',
        'Mail lookup, uploaded notes, analysis, indexing and cited follow-up',
        'works',
        [
          'Find the Lantern launch email in my inbox. Use its checklist and the uploaded lantern-notes.md and lantern-sales.csv to prepare lantern-launch-analysis.md, index it for this chat, and offer to answer questions.',
          'From that indexed analysis, which region sold more and by how much? Cite the report and include both regional revenues.',
        ],
      ),
    ],
  },
  {
    priority: 'should',
    questions: [
      q('04-library-docs', 'Resolve a library before reading its docs', 'works', [
        'Find the SolidJS createSignal docs and show me a tiny counter example.',
      ]),
      q('05-memory-lookup', 'Recall a confirmed per-user memory in a later turn', 'works', [
        'What do you remember about me?',
        'And which release tag do you have noted for it?',
      ]),
      q('07-follow-up-success', 'Refer back to a successful turn', 'works', [
        'How many Project nodes are in the knowledge graph?',
        'Who is involved in the three projects with the most people working on them?',
      ]),
      q('08-follow-up-failure', 'Retry after an explicitly failed turn', 'not-yet', [
        'Count the Project nodes in the knowledge graph.',
        'That failed earlier. Please try the same count again now.',
      ]),
      q(
        '14-analysis-index-follow-up',
        'Compute, convert to markdown, then retrieve in a later turn',
        'not-yet',
        [
          'I uploaded lantern-notes.md and lantern-sales.csv. Analyse sales against the notes, save lantern-analysis.md, index it for this chat, and offer to answer questions about it.',
          'I have indexed lantern-analysis.md from the Data Stash. Which region sold more and by how much? Cite that analysis.',
        ],
      ),
      q('15-graph-file-summary', 'Graph file to sandbox summary', 'coming', [
        'Find lantern-brief.docx in my OneDrive, read it, and write lantern-brief-summary.docx.',
      ]),
    ],
  },
  {
    priority: 'nice',
    questions: [
      q(
        '16-graph-files-analysis',
        'Graph files, analysis, markdown indexing and retrieval',
        'coming',
        [
          'Find the Lantern budget and actuals spreadsheets in my OneDrive. Compare them, create lantern-variance.md, index it, and let me ask questions about it.',
          'Which item has the largest overspend in that report? Cite it.',
        ],
      ),
    ],
  },
]
