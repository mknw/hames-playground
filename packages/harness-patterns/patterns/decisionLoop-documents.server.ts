/**
 * The conversation's documents, as the decisions model of `decisionLoop` is told
 * about them (#507; design: docs/plan/decide-document-context.md).
 *
 * Core never reads a tier and never reads a stash. The HOST's source hands it a
 * `DecisionDocuments`: the visible total always, and a name list only when the
 * host decided this run may reveal one. Core renders what it was handed, and
 * everything here is deterministic (no model call, so there is no role for a
 * tier rule to route and nothing for an outage policy to cover).
 *
 * File names are UNTRUSTED text whatever their provenance (a browser upload, a
 * file copied from a third party, a sandbox output, a triggered run's recording).
 * A name reaches the state as one JSON-quoted string, after it was cut to a code
 * point cap, compatibility-normalised (NFKC, so a fullwidth form meets the same
 * rule as its ASCII twin), had every line separator and control character
 * replaced and every invisible, format or bidi character removed, and was checked
 * against the injection rule corpus. Visually confusable letters (a Cyrillic
 * lookalike for a Latin one) are NOT mapped: the check is deterministic and
 * does not claim to be a confusables filter, so such a name is shown. A name that trips a rule is WITHHELD, never neutralised in place:
 * a half-neutralised string still steers a small classifier, and unlike a
 * citation this label has no need to stay readable.
 */

import { assertServerOnImport } from '../assert.server'
import { INJECTION_RULES, sanitizeText } from '../injection-guard'

assertServerOnImport()

/** The heading of the block in the decide state. */
export const DECISION_DOCUMENTS_HEADING = 'Uploaded documents in this conversation:'

/** At most this many names are listed. Set values, not measurements. */
export const DECISION_DOCUMENTS_MAX_NAMES = 10

/** Each name is cut to this many code points BEFORE any rule runs. */
export const DECISION_DOCUMENT_NAME_CODE_POINTS = 80

/** The whole block, in characters. Names are dropped from the tail until it fits. */
export const DECISION_DOCUMENTS_MAX_CHARS = 1000

/** What a name that tripped a rule is shown as. */
export const WITHHELD_DOCUMENT_NAME = '[name withheld]'

/** One visible document, as the host describes it to the loop. */
export interface DecisionDocument {
  /** Stable id; breaks ties between documents uploaded in the same millisecond. */
  readonly id: string
  readonly name: string
  /** The stored MIME string. Never printed: it is mapped through an allowlist. */
  readonly mimeType: string
  /** Original size in bytes. */
  readonly size: number
  /** Epoch ms. */
  readonly uploadedAt: number
  /** Indexed for search (`read-documents` can quote it). */
  readonly searchable: boolean
}

/** What the host's source returns, once per run. */
export interface DecisionDocuments {
  /** Every VISIBLE document (hidden and archived ones are not counted). */
  readonly total: number
  /** The names the run may reveal. Absent means this run may not reveal any. */
  readonly names?: readonly DecisionDocument[]
}

/** Resolved before iteration 1: the host's value, or `'unknown'` when the read
 *  failed or timed out. Never `'none'` — that would read as a claim. */
export type ResolvedDecisionDocuments = DecisionDocuments | 'unknown'

/** The host's per-run read. It should stop when `signal` aborts (the timeout). */
export type DecisionDocumentsSource = (signal: AbortSignal) => Promise<DecisionDocuments>

/** True when `value` has the shape the renderer relies on. A source that returns
 *  anything else is treated as a failed read, not rendered. */
export function isDecisionDocuments(value: unknown): value is DecisionDocuments {
  if (value === null || typeof value !== 'object') return false
  const { total, names } = value as { total?: unknown; names?: unknown }
  if (typeof total !== 'number' || !Number.isInteger(total) || total < 0) return false
  if (names === undefined) return true
  if (!Array.isArray(names)) return false
  return names.every((d) => {
    if (d === null || typeof d !== 'object') return false
    const x = d as Record<string, unknown>
    return (
      typeof x.id === 'string' &&
      typeof x.name === 'string' &&
      typeof x.mimeType === 'string' &&
      typeof x.size === 'number' &&
      Number.isFinite(x.size) &&
      typeof x.uploadedAt === 'number' &&
      Number.isFinite(x.uploadedAt) &&
      typeof x.searchable === 'boolean'
    )
  })
}

// ----------------------------------------------------------------------------
// Names
// ----------------------------------------------------------------------------

/** First `max` code points of `text`, without materialising the rest: a name
 *  has no length cap upstream, and a 200 kB one must not reach a rule. */
function codePointPrefix(text: string, max: number): string {
  let out = ''
  let n = 0
  for (const ch of text) {
    if (n++ === max) break
    out += ch
  }
  return out
}

/** Every line and paragraph separator (U+0085, U+2028, U+2029, \r, \n) and every
 *  other control character. Replaced, not removed: "a\nb" must not become "ab". */
const SEPARATORS_AND_CONTROLS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g

/** The state's own section headers. A name containing one is withheld: quoting
 *  keeps it off a line of its own, but nothing here needs such a name readable. */
const STATE_HEADER =
  /(?:This turn so far|Conversation \(recent turns\)|Latest results(?: \(most recent last\))?|Uploaded documents in this conversation)\s*:/i

/** Every default-ignorable and format code point: soft hyphen, combining grapheme
 *  joiner, Hangul fillers, ZW*, bidi controls, invisible operators, variation
 *  selectors (including the supplement), interlinear annotation, tag characters
 *  and the unassigned slots reserved as ignorable. The corpus's `hidden-text`
 *  class is narrower on purpose (it must not mangle emoji in a page); a file name
 *  is a label with no need of any of them. */
const INVISIBLE_OR_FORMAT = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu

const HIDDEN_TEXT_RULES = INJECTION_RULES.filter((r) => r.layer === 'hidden-text')

/**
 * The text a name is shown as, JSON-quoted on one line, or `undefined` when it
 * must be withheld. Order matters: cap first (nothing past the cap reaches a
 * rule, SD-2), then NFKC (and the cap again, since a compatibility form can
 * expand), then separators, then invisible/format characters (so a keyword split
 * by a soft hyphen is whole again for the rule that looks for it), then the whole
 * rule corpus. The LLM screen is never involved: a name is not a
 * route output, and a screen call per name per turn would give names an outage
 * policy nobody chose.
 */
export function safeDocumentName(name: string): string | undefined {
  const capped = codePointPrefix(
    codePointPrefix(name, DECISION_DOCUMENT_NAME_CODE_POINTS).normalize('NFKC'),
    DECISION_DOCUMENT_NAME_CODE_POINTS,
  )
  const flat = capped.replace(SEPARATORS_AND_CONTROLS, ' ')
  const visible = sanitizeText(flat.replace(INVISIBLE_OR_FORMAT, ''), HIDDEN_TEXT_RULES).text
  if (STATE_HEADER.test(visible)) return undefined
  if (sanitizeText(visible, INJECTION_RULES).findings.length > 0) return undefined
  return JSON.stringify(visible)
}

// ----------------------------------------------------------------------------
// Type and size
// ----------------------------------------------------------------------------

const TYPE_BY_MIME: Readonly<Record<string, string>> = {
  'text/markdown': 'Markdown',
  'text/x-markdown': 'Markdown',
  'text/plain': 'text',
  'text/csv': 'CSV',
  'application/csv': 'CSV',
  'application/pdf': 'PDF',
  'application/msword': 'Word',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'Word',
  'application/vnd.ms-excel': 'Excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'Excel',
}

/** A fixed label, never the raw string: `mimeType` is the browser's, stored as sent. */
export function documentTypeLabel(mimeType: string): string {
  const base = mimeType.split(';')[0].trim().toLowerCase()
  if (Object.hasOwn(TYPE_BY_MIME, base)) return TYPE_BY_MIME[base]
  return base.startsWith('image/') ? 'image' : 'other'
}

function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function line(d: DecisionDocument): string {
  const name = safeDocumentName(d.name) ?? WITHHELD_DOCUMENT_NAME
  const facts = `${documentTypeLabel(d.mimeType)}, ${sizeLabel(d.size)}, ${d.searchable ? 'searchable' : 'not searchable'}`
  return `- ${name} (${facts})`
}

// ----------------------------------------------------------------------------
// The block
// ----------------------------------------------------------------------------

/**
 * The block for the decide state, or `undefined` when there is nothing to say
 * (no visible documents), so such a state is byte-identical to one built
 * without a source.
 *
 * With names: newest first, ties by id (the list functions sort on `uploadedAt`
 * alone and the index set's order is unspecified), one line per distinct name
 * (the newer wins, as sandbox hydration does), at most
 * {@link DECISION_DOCUMENTS_MAX_NAMES} of them, and the block at most
 * {@link DECISION_DOCUMENTS_MAX_CHARS} characters, shed from the tail. The last
 * line counts every visible document not shown by name.
 */
export function renderDocumentsBlock(docs: ResolvedDecisionDocuments): string | undefined {
  if (docs === 'unknown') return `${DECISION_DOCUMENTS_HEADING} unknown (could not be read)`
  if (docs.total === 0) return undefined
  if (docs.names === undefined)
    return `${DECISION_DOCUMENTS_HEADING} ${docs.total} (names not shown)`

  const newestFirst = [...docs.names].sort(
    (a, b) => b.uploadedAt - a.uploadedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  )
  const seen = new Set<string>()
  const distinct = newestFirst.filter((d) => !seen.has(d.name) && !!seen.add(d.name))
  const lines = distinct.slice(0, DECISION_DOCUMENTS_MAX_NAMES).map(line)

  const build = (): string => {
    const hidden = Math.max(0, docs.total - lines.length)
    return [
      DECISION_DOCUMENTS_HEADING,
      ...lines,
      ...(hidden > 0 ? [`- (+${hidden} more documents, names not shown)`] : []),
    ].join('\n')
  }
  let block = build()
  while (block.length > DECISION_DOCUMENTS_MAX_CHARS && lines.length > 0) {
    lines.pop()
    block = build()
  }
  return block
}
