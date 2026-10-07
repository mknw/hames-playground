/**
 * Memory acceptance — the deterministic half of the store step (#419 M2)
 *
 * The extractor is a model, and a model can be talked into anything by text it
 * was handed. Nothing it returns is trusted: every candidate passes through the
 * rules below, in this order, and the FIRST failure drops the candidate and
 * names the rule. No model is consulted here and nothing is repaired — a
 * candidate that does not pass is a candidate the user did not say.
 *
 *   kind               the closed set, nothing else
 *   shape              one line, non-empty, at most 280 characters
 *   evidence-length    the evidence is at least 8 characters
 *   evidence-verbatim  the evidence is a verbatim span of the CURRENT user
 *                      message, after NFKC (D9). Assistant text — which is
 *                      composed from tool results — is never a source, so a
 *                      poisoned page cannot reach memory through the reply
 *   identifier-closure every URL, email, @handle, 3+-digit number and
 *                      capitalised name in `content` occurs in a user message
 *                      of the window — the model may not invent an identifier
 *   sanitizer          the injection sanitizer reports ZERO findings on
 *                      `content`: a memory is replayed into a later prompt, so
 *                      text the guard would neutralize in a tool result must not
 *                      be stored
 *
 * Pure and free of I/O, so `acceptance-rules` can assert every rule without a
 * store, an embedder or a gate.
 */

import { assertServerOnImport } from './assert.server'
import { sanitizeUntrusted } from './injection-guard'
import type { MemoryExtractedCandidate, MemoryKind } from './types'

assertServerOnImport()

/** The closed set of kinds a memory may have. */
export const MEMORY_KINDS: readonly MemoryKind[] = ['episodic', 'semantic', 'preference', 'trait']

/** Longest memory text, in characters. */
export const MAX_MEMORY_CHARS = 280

/** Shortest evidence span, in characters (after NFKC). */
export const MIN_EVIDENCE_CHARS = 8

/** The rule ids a dropped candidate is logged under. */
export type AcceptanceRule =
  'kind' | 'shape' | 'evidence-length' | 'evidence-verbatim' | 'identifier-closure' | 'sanitizer'

export type Acceptance =
  | {
      readonly ok: true
      readonly kind: MemoryKind
      readonly content: string
      readonly evidence: string
    }
  | { readonly ok: false; readonly rule: AcceptanceRule }

const nfkc = (s: string): string => s.normalize('NFKC')
const chars = (s: string): number => Array.from(s).length

const isKind = (k: string): k is MemoryKind => (MEMORY_KINDS as readonly string[]).includes(k)

const LINE_BREAK = /[\r\n\u2028\u2029\u0085]/u

// --- identifiers -----------------------------------------------------------

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/giu
const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)*\.\p{L}{2,}/gu
const HANDLE_RE = /(?<![\p{L}\p{N}_@.])@[\p{L}\p{N}_]{2,}/gu
const NUMBER_RE = /\p{Nd}{3,}/gu
/** A capitalised word of two or more letters (acronyms included). */
const NAME_RE = /\p{Lu}[\p{L}\p{N}'’-]+/gu

/** The generic subject the extractor is told to write ("The user …"), which is
 *  not a name the user supplied. */
const GENERIC_SUBJECT = new Set(['user'])

const TRAILING_PUNCT = /[.,;:!?)\]}'’"]+$/u

/** Identifier-like substrings of `content` that must appear in the user's own
 *  words. A capitalised word at the start of a sentence is just grammar and is
 *  exempt; everywhere else a capital marks a name the user must have said. */
export function identifiersIn(content: string): string[] {
  const text = nfkc(content)
  const out = new Set<string>()
  let rest = text
  for (const re of [URL_RE, EMAIL_RE]) {
    for (const m of rest.matchAll(re)) out.add(m[0].replace(TRAILING_PUNCT, ''))
    // Blank what was taken, so an email's local part is not read again as a
    // name and a URL's path is not read again as a number.
    rest = rest.replace(re, ' ')
  }
  for (const m of rest.matchAll(HANDLE_RE)) out.add(m[0])
  for (const m of rest.matchAll(NUMBER_RE)) out.add(m[0])
  for (const m of rest.matchAll(NAME_RE)) {
    const before = rest.slice(0, m.index)
    const sentenceStart = before.trim() === '' || /[.!?]\s+$/u.test(before)
    if (sentenceStart) continue
    if (GENERIC_SUBJECT.has(m[0].toLowerCase())) continue
    out.add(m[0])
  }
  return [...out].filter((t) => t.length > 0)
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `needle` occurs in `haystack` as a whole token (not inside a longer word or
 *  number), case-insensitively — NFKC both sides. */
function occursAsToken(needle: string, haystack: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(needle)}(?![\\p{L}\\p{N}])`, 'iu').test(haystack)
}

// --- the rules ---------------------------------------------------------------

/**
 * Run one candidate through every rule.
 *
 * @param latestUser    the CURRENT user message — the only text evidence may
 *                      be a span of
 * @param userMessages  every user message of the window (including the current
 *                      one) — the only text an identifier may be found in
 */
export function acceptCandidate(
  candidate: MemoryExtractedCandidate,
  ctx: { readonly latestUser: string; readonly userMessages: readonly string[] },
): Acceptance {
  const kind = typeof candidate.kind === 'string' ? candidate.kind.trim() : ''
  if (!isKind(kind)) return { ok: false, rule: 'kind' }

  const content = typeof candidate.content === 'string' ? nfkc(candidate.content).trim() : ''
  if (content === '' || LINE_BREAK.test(content) || chars(content) > MAX_MEMORY_CHARS) {
    return { ok: false, rule: 'shape' }
  }

  const evidence = typeof candidate.evidence === 'string' ? nfkc(candidate.evidence).trim() : ''
  if (chars(evidence) < MIN_EVIDENCE_CHARS) return { ok: false, rule: 'evidence-length' }
  if (!nfkc(ctx.latestUser).includes(evidence)) return { ok: false, rule: 'evidence-verbatim' }

  const corpus = ctx.userMessages.map(nfkc).join('\n')
  for (const id of identifiersIn(content)) {
    if (!occursAsToken(id, corpus)) return { ok: false, rule: 'identifier-closure' }
  }

  const { report } = sanitizeUntrusted(
    content,
    { tool: 'memory', namespace: 'memory' },
    { spotlight: 'off' },
  )
  if (report.findings.length > 0) return { ok: false, rule: 'sanitizer' }

  return { ok: true, kind, content, evidence }
}
