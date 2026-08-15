/**
 * Pseudonymisation over a Graph-derived roster — pure, no NER, no model, no I/O.
 *
 * `graph-roster.ts` harvests who is in a payload from Graph's own labelled
 * identity fields. This module turns that roster into a per-payload substitution
 * table and applies it: every identity literal (full names, name variants, the
 * given/family parts of a name, email addresses, and the two encodings of an
 * address that appear in URLs) becomes an opaque placeholder, in the structured
 * fields AND inside free text. `reverse` puts the real values back for display.
 *
 * ## What makes this work without a model
 * Exact-match substitution over a roster the payload itself declared. No
 * language model, no NER, no dictionary — so it is deterministic, auditable,
 * costs nothing, and is language-independent (mail here is Dutch, French and
 * English, often in one thread).
 *
 * ## The three matching hazards, and what is done about them
 * - **Substrings.** Replacing "Michael" must not touch "Michaelson", so every
 *   needle is fenced by Unicode-aware boundary lookarounds.
 * - **Unicode names.** JS `\b` is ASCII-only: it fires *inside* "José" and
 *   "Müller". The fences use `(?<![\p{L}\p{N}_])` / `(?![\p{L}\p{N}_])` under
 *   the `u` flag instead.
 * - **Overlap.** "Jan Van Damme" and "Jan" both match at the same index, and
 *   "jan.van.damme@dtsc.be" contains both. One alternation regex is built with
 *   the needles sorted longest-first, so the longest identity wins at every
 *   position and a single left-to-right pass never rewrites its own output.
 *
 * HTML bodies (`body.content` is usually HTML) are split into markup and text
 * before substitution: text nodes and quoted attribute values are rewritten,
 * tag and attribute names never are, so no tag can be broken by a replacement.
 *
 * ## Reverse fidelity
 * Each distinct surface form gets its own placeholder, so `reverse(apply(x))`
 * restores the literal that was replaced rather than a canonical rewrite of it.
 * The one exception is letter case: matching is case-insensitive (a subject line
 * shouting a surname must still be caught), so an occurrence whose case differs
 * from the roster's comes back in the roster's case. Deliberate — catching the
 * identity matters more than preserving its capitalisation.
 *
 * ## Known limitation
 * A person named ONLY in free text, never in a labelled field, is not in the
 * roster and is therefore not replaced. That is inherent to the no-NER design,
 * is asserted by the tests, and is discussed in
 * `docs/plan/graph-pseudonymisation.md`.
 */
import type { RosterEntry } from './graph-roster'

/** One literal that maps to one placeholder. */
export interface PseudonymForm {
  /** The literal as it will be searched for (matching is case-insensitive). */
  value: string
  /** What replaces it, e.g. `PERSON_1_EMAIL`. */
  placeholder: string
  kind: 'name' | 'name-variant' | 'given' | 'family' | 'email' | 'email-local' | 'email-slug'
  /** Name parts are fenced against `-` as well, so replacing the "Jean" of
   *  "Jean Dupont" cannot chew the head off an unrelated "Jean-Pierre". */
  part: boolean
}

/** One person's placeholders and the literals that map to them. */
export interface PseudonymEntry {
  /** 1-based, in roster order. */
  id: number
  /** The person's primary placeholder, e.g. `PERSON_1`. */
  placeholder: string
  name: string | null
  address: string | null
  roles: string[]
  forms: PseudonymForm[]
}

/**
 * A payload-scoped substitution table. Plain JSON — no Maps, no regexes — so it
 * can be serialised as-is. Note that it is itself personal data: it holds the
 * cleartext identities keyed by their placeholders.
 */
export interface PseudonymTable {
  entries: PseudonymEntry[]
}

/** Name particles carry no identifying force on their own and are never used as
 *  a standalone needle: "de", "van", "der" appear in ordinary Dutch/French prose
 *  hundreds of times per mailbox. */
const NAME_PARTICLES = new Set([
  'van',
  'von',
  'de',
  'den',
  'der',
  'des',
  'du',
  'da',
  'das',
  'dos',
  'del',
  'della',
  'di',
  'do',
  'la',
  'le',
  'les',
  'ten',
  'ter',
  'te',
  'op',
  'in',
  'het',
  'al',
  'el',
  'bin',
  'ibn',
  'san',
  'st',
])

/** A local part is treated as name-like when it joins two or more alphabetic
 *  runs with a separator (`michael.accetto`, `jan-van-damme`). A bare
 *  single-token local part is only used when it matches one of the person's own
 *  name variants, because "info" and "jan" are not identities on their own. */
const NAME_LIKE_LOCAL = /^\p{L}[\p{L}\p{N}]*(?:[._-]\p{L}[\p{L}\p{N}]*)+$/u

const MIN_PART_LENGTH = 3

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const isParticle = (word: string): boolean => NAME_PARTICLES.has(word.toLowerCase())

/**
 * The given name and the family name of a display name, or nulls when it is a
 * single word (nothing to take apart, and the whole form already covers it).
 *
 * The family name KEEPS its particles — "Jan Van Damme" yields "Van Damme", not
 * "Damme" — because a document called "Offerte Van Damme 2026.docx" should lose
 * the whole surname, not have a stray "Van" left standing in front of a
 * placeholder.
 */
function nameParts(name: string): { given: string | null; family: string | null } {
  const words = name
    .split(/[\s,]+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean)
  if (words.length < 2) return { given: null, family: null }

  const given = words.find((w) => w.length >= MIN_PART_LENGTH && !isParticle(w)) ?? null

  let start = words.length - 1
  while (start > 0 && isParticle(words[start - 1])) start -= 1
  const family = words.slice(start).join(' ')

  return {
    given,
    family: family.length >= MIN_PART_LENGTH && family !== given ? family : null,
  }
}

/** Local part of an email, or null when it isn't one. */
function localPart(address: string): string | null {
  const at = address.indexOf('@')
  return at > 0 ? address.slice(0, at) : null
}

/**
 * The underscored form of an address that SharePoint/OneDrive personal-site URLs
 * carry — `michael.accetto@dtsc.be` appears in a webUrl as
 * `michael_accetto_dtsc_be`. It is the same identifier in a different encoding,
 * so it belongs in the table.
 */
function addressSlug(address: string): string {
  return address.replace(/[@.]/g, '_')
}

/**
 * Build the substitution table for one payload's roster.
 *
 * Placeholders are positional (`PERSON_1`, `PERSON_2`, …) and therefore
 * meaningful only within this payload — the same person in the next tool result
 * gets whichever number their position there yields. That is the point: a
 * payload-scoped table cannot be joined across conversations into a directory.
 *
 * A literal claimed by an earlier person is not re-claimed by a later one, so
 * two people sharing a first name collapse onto the first one's placeholder
 * rather than being attributed at random. That conflates them, which is the
 * safe direction to fail in.
 */
export function buildTable(roster: RosterEntry[]): PseudonymTable {
  const entries: PseudonymEntry[] = []
  const claimed = new Set<string>()

  roster.forEach((person, index) => {
    const id = index + 1
    const placeholder = `PERSON_${id}`
    const forms: PseudonymForm[] = []

    const add = (
      value: string | null | undefined,
      suffix: string,
      kind: PseudonymForm['kind'],
      part = false,
    ): void => {
      const v = value?.trim()
      if (!v) return
      const key = v.toLowerCase()
      if (claimed.has(key)) return
      claimed.add(key)
      forms.push({
        value: v,
        placeholder: suffix ? `${placeholder}_${suffix}` : placeholder,
        kind,
        part,
      })
    }

    // Full names first: the primary spelling owns the bare placeholder.
    const variants = person.nameVariants.length
      ? person.nameVariants
      : person.name
        ? [person.name]
        : []
    variants.forEach((variant, i) => {
      if (i === 0) add(variant, '', 'name')
      else add(variant, `NAME${i + 1}`, 'name-variant')
    })

    if (person.address) {
      add(person.address, 'EMAIL', 'email')
      add(addressSlug(person.address), 'SLUG', 'email-slug')
      const local = localPart(person.address)
      const variantKeys = new Set(variants.map((v) => v.replace(/\s+/g, '').toLowerCase()))
      if (local && (NAME_LIKE_LOCAL.test(local) || variantKeys.has(local.toLowerCase()))) {
        add(local, 'LOCAL', 'email-local')
      }
    }

    // Name parts last, so a full name is always preferred over its pieces and a
    // part never steals a literal a fuller form would have matched.
    let givenCount = 0
    let familyCount = 0
    for (const variant of variants) {
      const { given, family } = nameParts(variant)
      if (given && !claimed.has(given.toLowerCase())) {
        givenCount += 1
        add(given, givenCount === 1 ? 'GIVEN' : `GIVEN${givenCount}`, 'given', true)
      }
      if (family && !claimed.has(family.toLowerCase())) {
        familyCount += 1
        add(family, familyCount === 1 ? 'FAMILY' : `FAMILY${familyCount}`, 'family', true)
      }
    }

    entries.push({
      id,
      placeholder,
      name: person.name,
      address: person.address,
      roles: [...person.roles],
      forms,
    })
  })

  return { entries }
}

/** Every form in the table, longest literal first — the ordering that makes a
 *  single left-to-right pass prefer the longest identity at each position. */
function orderedForms(table: PseudonymTable): PseudonymForm[] {
  const forms = table.entries.flatMap((e) => e.forms)
  return forms.sort((a, b) => b.value.length - a.value.length || a.value.localeCompare(b.value))
}

interface Matcher {
  regex: RegExp
  byLiteral: Map<string, string>
}

/**
 * One regex with two fenced branches — whole identities, then name parts, which
 * additionally refuse to match next to a hyphen. Branch order settles ties at the
 * same index; leftmost-match settles the rest.
 */
function buildMatcher(table: PseudonymTable): Matcher | null {
  const forms = orderedForms(table)
  if (forms.length === 0) return null

  const byLiteral = new Map<string, string>()
  for (const f of forms) {
    const key = f.value.toLowerCase()
    if (!byLiteral.has(key)) byLiteral.set(key, f.placeholder)
  }

  const whole = forms.filter((f) => !f.part).map((f) => escapeRegExp(f.value))
  const parts = forms.filter((f) => f.part).map((f) => escapeRegExp(f.value))

  const branches: string[] = []
  if (whole.length) branches.push(`(?<![\\p{L}\\p{N}_])(?:${whole.join('|')})(?![\\p{L}\\p{N}_])`)
  if (parts.length) branches.push(`(?<![\\p{L}\\p{N}_-])(?:${parts.join('|')})(?![\\p{L}\\p{N}_-])`)

  return { regex: new RegExp(branches.join('|'), 'giu'), byLiteral }
}

function substitute(text: string, matcher: Matcher): string {
  return text.replace(matcher.regex, (match) => matcher.byLiteral.get(match.toLowerCase()) ?? match)
}

/** Does this string carry markup we must not rewrite through? */
const HTML_LIKE = /<[a-zA-Z!/][^>]*>/

/** Quoted attribute values inside a tag — the only part of markup that can hold
 *  an identity (`href="mailto:…"`, `title="Jan Van Damme"`). */
const ATTR_VALUE = /="([^"]*)"|='([^']*)'/g

function substituteInTag(tag: string, matcher: Matcher): string {
  return tag.replace(
    ATTR_VALUE,
    (whole, double: string | undefined, single: string | undefined) => {
      if (double !== undefined) return `="${substitute(double, matcher)}"`
      if (single !== undefined) return `='${substitute(single, matcher)}'`
      return whole
    },
  )
}

/**
 * Substitute inside an HTML string without touching structure: text between
 * tags is rewritten, and within a tag only quoted attribute values are. Tag
 * names, attribute names and the angle brackets are copied through verbatim, so
 * no replacement can open, close or rename an element.
 */
function substituteHtml(html: string, matcher: Matcher): string {
  const out: string[] = []
  let last = 0
  for (const m of html.matchAll(/<[^>]*>/g)) {
    const start = m.index ?? 0
    out.push(substitute(html.slice(last, start), matcher))
    out.push(substituteInTag(m[0], matcher))
    last = start + m[0].length
  }
  out.push(substitute(html.slice(last), matcher))
  return out.join('')
}

function substituteString(text: string, matcher: Matcher): string {
  return HTML_LIKE.test(text) ? substituteHtml(text, matcher) : substitute(text, matcher)
}

function mapValue(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value)
  if (Array.isArray(value)) return value.map((v) => mapValue(v, fn))
  if (value && typeof value === 'object') {
    if (value instanceof Date) return new Date(value.getTime())
    // Object keys are structural, never personal data — only values are mapped.
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = mapValue(v, fn)
    }
    return out
  }
  return value
}

/**
 * Deep-clone `value`, replacing every identity literal in every string with its
 * placeholder. Structured fields and free text are treated identically — a
 * `from.emailAddress.address` and the same address quoted inside a Dutch body
 * paragraph both become `PERSON_1_EMAIL`.
 *
 * The input is never mutated. With an empty table this is a plain deep clone.
 */
export function apply<T>(value: T, table: PseudonymTable): T {
  const matcher = buildMatcher(table)
  return mapValue(value, matcher ? (s) => substituteString(s, matcher) : (s) => s) as T
}

/**
 * Replace placeholders with the literals they stand for, for display back to
 * the user. Applied to model output, so it must tolerate text that contains no
 * placeholders at all, and placeholders in any order.
 *
 * Longest-first plus a trailing fence keeps `PERSON_1` from eating the head of
 * `PERSON_1_EMAIL` or of `PERSON_10`.
 */
export function reverse(text: string, table: PseudonymTable): string {
  const byPlaceholder = new Map<string, string>()
  for (const entry of table.entries) {
    for (const form of entry.forms) {
      if (!byPlaceholder.has(form.placeholder)) byPlaceholder.set(form.placeholder, form.value)
    }
    // A person known only by address has no form on the bare `PERSON_n`, yet a
    // model that saw `PERSON_n_EMAIL` may well write `PERSON_n` in its answer.
    // Resolve it to whatever identifies them.
    const fallback = entry.name ?? entry.address
    if (fallback && !byPlaceholder.has(entry.placeholder)) {
      byPlaceholder.set(entry.placeholder, fallback)
    }
  }
  if (byPlaceholder.size === 0) return text

  const alternation = [...byPlaceholder.keys()]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map(escapeRegExp)
    .join('|')
  const regex = new RegExp(`(?<![A-Za-z0-9_])(?:${alternation})(?![A-Za-z0-9_])`, 'g')
  return text.replace(regex, (match) => byPlaceholder.get(match) ?? match)
}

/** Look up the entry a placeholder belongs to — the join a UI would need to
 *  show "PERSON_2 is Jan Van Damme (organizer)". */
export function entryForPlaceholder(
  placeholder: string,
  table: PseudonymTable,
): PseudonymEntry | null {
  return table.entries.find((e) => e.forms.some((f) => f.placeholder === placeholder)) ?? null
}
