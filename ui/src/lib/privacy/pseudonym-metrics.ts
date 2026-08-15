/**
 * Placeholder-fidelity metrics — pure, no I/O, no model.
 *
 * `pseudonymise.ts` assumes a language model echoes `PERSON_1` back verbatim, so
 * that `reverse` can put the real name in front of the user. Open question 4 of
 * `docs/plan/graph-pseudonymisation.md` asks whether that assumption holds. This
 * module is the measuring instrument: given a model's answer, the table that was
 * applied to its input, and the set of placeholders that input actually
 * contained, it classifies what came back.
 *
 * ## The five outcomes
 *
 * | Outcome | Meaning | Does `reverse` recover it? |
 * |---|---|---|
 * | **exact** | the placeholder came back byte-for-byte | yes, today |
 * | **recoverable** | it came back mangled in one of the tolerated ways below | no today; yes if `reverse` grew a lenient pass |
 * | **residue** | a `PERSON`-shaped token that neither pass resolves | no — the user would see it raw |
 * | **dropped** | an input placeholder that came back in no form at all | nothing to recover; the person simply left the answer |
 * | **hallucinatedOutOfRange** | a `PERSON_<n>` whose `n` the table never minted | no — and reversing it would attribute the wrong person |
 *
 * `exact` and `recoverable` are the survival side; `residue` and
 * `hallucinatedOutOfRange` are the damage side; `dropped` is neither — a
 * synthesiser summarising ten people into three sentences legitimately omits
 * seven of them, so a drop is only interesting in bulk.
 *
 * ## The lenient family (what "recoverable" tolerates)
 *
 * Deliberately small, and every member is a mangle a *model* produces rather
 * than a mangle a *parser* invents:
 *
 * - **case** — `person_1`, `Person_1_Email`;
 * - **escaped underscore** — `PERSON\_1`, which is what a model emitting
 *   Markdown writes so the underscore is not read as emphasis;
 * - **separator swap** — `PERSON 1`, `PERSON-1`, `PERSON 1 EMAIL`;
 * - **trailing Dutch genitive** — `PERSON_1s`, the inflection that limitation 2
 *   of the plan doc already names on the input side. Note that the apostrophe
 *   form `PERSON_1's` is scored **exact**, not recoverable: `reverse` fences on
 *   `[A-Za-z0-9_]` and an apostrophe is none of those, so that spelling already
 *   round-trips today. Only the glued `s` is a genuine mangle.
 *
 * Crucially the lenient pass resolves **only ids the table actually minted**: it
 * is an alternation built from the table, not a generic pattern. `PERSON_9` in a
 * three-person table cannot be leniently "recovered" into anything — it is a
 * hallucination, and counting it as a near-miss would hide exactly the failure
 * that matters.
 *
 * ## Why not just diff against `reverse` output
 *
 * `reverse` tells you what it managed to resolve. It cannot tell you what it
 * *missed*, because a missed placeholder passes through untouched and looks
 * identical to text that never held one. Classification has to happen against
 * the input placeholder set, which is why that set is a required argument.
 */
import type { PseudonymTable } from './pseudonymise'

/** One placeholder occurrence that survived only in mangled form. */
export interface Mangle {
  /** The literal token as the model wrote it, e.g. `PERSON\_1` or `PERSON 2`. */
  found: string
  /** The minted placeholder it resolves to, e.g. `PERSON_1`. */
  resolved: string
}

/** The classification of one model answer against one table. */
export interface FidelityReport {
  /** Distinct placeholders present in the text handed to the model. */
  inputIds: string[]
  /** Input placeholders that came back byte-for-byte at least once. */
  exactIds: string[]
  /** Input placeholders that came back in a lenient form at least once
   *  (an id can be in both lists when the answer mentions it twice). */
  recoveredIds: string[]
  /** Input placeholders absent from the answer in any form. */
  droppedIds: string[]
  /** `PERSON`-shaped tokens neither pass resolved, verbatim as written. */
  residueTokens: string[]
  /** Residue tokens that parse as `PERSON_<n>` for an `n` the table never
   *  minted — a subset of `residueTokens`, reported separately because it is
   *  the only outcome that could put the WRONG name in front of a user. */
  hallucinatedTokens: string[]
  /** Every lenient match, for qualitative reporting. */
  mangles: Mangle[]
  /** Occurrence counts (not distinct ids) — `exact` + `recoverable` + `residue`
   *  is the total number of `PERSON`-shaped tokens found in the answer. */
  exact: number
  recoverable: number
  residue: number
  /** Distinct-id count: `droppedIds.length`. */
  dropped: number
  /** Occurrence count of `hallucinatedTokens`. */
  hallucinatedOutOfRange: number
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Every placeholder the table can mint, longest first.
 *
 * Includes each entry's bare `PERSON_n` even when no *form* owns it: a person
 * known only by address has forms on `PERSON_n_EMAIL` alone, yet a model that
 * saw that token routinely writes `PERSON_n` in its answer, and `reverse`
 * already resolves it. Treating it as un-minted would score a correct echo as a
 * hallucination.
 */
export function mintedPlaceholders(table: PseudonymTable): string[] {
  const out = new Set<string>()
  for (const entry of table.entries) {
    out.add(entry.placeholder)
    for (const form of entry.forms) out.add(form.placeholder)
  }
  return [...out].sort((a, b) => b.length - a.length || a.localeCompare(b))
}

/** The numeric ids the table minted — `PERSON_3` is in range iff 3 is here. */
function mintedIds(table: PseudonymTable): Set<number> {
  return new Set(table.entries.map((e) => e.id))
}

/** Same fence `reverse` uses, so "verbatim" here means exactly what `reverse`
 *  would have resolved. */
function strictMatcher(placeholders: string[]): RegExp | null {
  if (placeholders.length === 0) return null
  const alternation = placeholders.map(escapeRegExp).join('|')
  return new RegExp(`(?<![A-Za-z0-9_])(?:${alternation})(?![A-Za-z0-9_])`, 'g')
}

/** The separators a model substitutes for `_`: a Markdown-escaped underscore,
 *  a plain one, a hyphen, or a single space. */
const SEP = String.raw`(?:\\_|_|-| )`

/** A trailing Dutch genitive, with either apostrophe the keyboard offers. */
const GENITIVE = String.raw`(?:['’]?s)?`

/**
 * One alternation that matches each minted placeholder through the lenient
 * family. Built from the table, longest-first, so `PERSON_1_EMAIL` claims a
 * position before `PERSON_1` can.
 *
 * The trailing fence refuses `\p{L}\p{N}_`, so leniently matching `PERSON_1`
 * cannot eat the head of an unminted `PERSON_1_NICKNAME` — that token stays
 * whole and is reported as residue, which is the honest reading.
 */
function lenientMatcher(placeholders: string[]): RegExp | null {
  if (placeholders.length === 0) return null
  const branches = placeholders.map((p) => p.split('_').map(escapeRegExp).join(SEP))
  return new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${branches.join('|')})${GENITIVE}(?![\\p{L}\\p{N}_])`,
    'giu',
  )
}

/** The stem, spelled out rather than flagged `i`, so the rest of the pattern
 *  can still tell upper case from lower (rule 2 below depends on that, and an
 *  `i` flag would defeat `\p{Lu}`). Trailing `S` catches the `PERSONS_1` a
 *  model occasionally pluralises into. */
const STEM = String.raw`[Pp][Ee][Rr][Ss][Oo][Nn][Ss]?`

/** Separators that GLUE — an underscore, its Markdown-escaped form, a hyphen.
 *  Whatever follows one of these is part of the same token by construction. */
const GLUE = String.raw`(?:\\_|_|-)`

/**
 * `PERSON`-shaped leftovers. Three rules, each of which a naive pattern gets
 * wrong on this corpus:
 *
 * 1. The stem must be JOINED to something, which keeps "the person who sent it"
 *    and "la personne qui a envoyé" out.
 * 2. The FIRST segment must start with a digit or a capital, whatever the
 *    separator. That is what admits `PERSON 3` (a real mangle) while rejecting
 *    English `persons-in-charge`.
 * 3. Later segments may be any word only after a GLUE. After a bare space they
 *    must again be digit-or-capital — otherwise `PERSON_9 was ook aanwezig`
 *    reads as one five-segment token and the residue is reported as a sentence.
 */
const RESIDUE_RE = new RegExp(
  `(?<![\\p{L}\\p{N}_])${STEM}${SEP}[\\p{N}\\p{Lu}][\\p{L}\\p{N}]*` +
    `(?:${GLUE}[\\p{L}\\p{N}]+| [\\p{N}\\p{Lu}][\\p{L}\\p{N}]*)*` +
    `${GENITIVE}(?![\\p{L}\\p{N}_])`,
  'gu',
)

/** `PERSON`-shaped token → the number right after the stem, or null. */
function numericIdOf(token: string): number | null {
  const m = /^persons?(?:\\_|[_\- ])(\d+)/i.exec(token)
  return m ? Number(m[1]) : null
}

/** Blank a matched span without moving any other character: NUL is neither a
 *  letter nor a digit, so every remaining fence still reads the same. */
const blank = (n: number): string => ' '.repeat(n)

/**
 * Distinct minted placeholders appearing verbatim in `text`.
 *
 * This is how a caller builds the `inputIds` argument to {@link scoreFidelity}:
 * run it over the pseudonymised text that was actually sent to the model, so the
 * denominator is what the model saw rather than everything the table could mint.
 */
export function placeholdersIn(text: string, table: PseudonymTable): string[] {
  const re = strictMatcher(mintedPlaceholders(table))
  if (!re) return []
  return [...new Set(text.match(re) ?? [])]
}

/**
 * Classify one model answer.
 *
 * @param output      the model's answer, as returned.
 * @param table       the table that was applied to its input.
 * @param inputIds    placeholders the input contained — see {@link placeholdersIn}.
 *
 * Passes run in order and consume what they match, so each `PERSON`-shaped
 * token is counted exactly once: verbatim first, then lenient over the leftovers,
 * then residue over what is still standing.
 */
export function scoreFidelity(
  output: string,
  table: PseudonymTable,
  inputIds: readonly string[],
): FidelityReport {
  const minted = mintedPlaceholders(table)
  const inputSet = [...new Set(inputIds)]

  const exactSeen = new Set<string>()
  const recoveredSeen = new Set<string>()
  const mangles: Mangle[] = []
  let exact = 0
  let recoverable = 0

  let rest = output

  const strict = strictMatcher(minted)
  if (strict) {
    rest = rest.replace(strict, (match) => {
      exact += 1
      exactSeen.add(match)
      return blank(match.length)
    })
  }

  const lenient = lenientMatcher(minted)
  if (lenient) {
    // The alternation is case-insensitive and separator-tolerant, so recovering
    // the canonical id means normalising the match back through the table.
    const canonical = new Map(minted.map((p) => [p.replace(/_/g, '').toLowerCase(), p]))
    const key = (s: string): string =>
      s
        .replace(/\\_/g, '')
        .replace(/[_\- ]/g, '')
        .toLowerCase()
    rest = rest.replace(lenient, (match) => {
      // A placeholder that genuinely ends in `s` must win over the genitive
      // reading of the same token, so the unstripped key is tried first.
      const resolved =
        canonical.get(key(match)) ?? canonical.get(key(match.replace(/['’]?s$/i, '')))
      if (!resolved) return match // leave it standing; residue will pick it up
      recoverable += 1
      recoveredSeen.add(resolved)
      mangles.push({ found: match, resolved })
      return blank(match.length)
    })
  }

  const residueTokens: string[] = []
  const hallucinatedTokens: string[] = []
  const ids = mintedIds(table)
  for (const m of rest.matchAll(RESIDUE_RE)) {
    const token = m[0]
    residueTokens.push(token)
    const n = numericIdOf(token)
    if (n !== null && !ids.has(n)) hallucinatedTokens.push(token)
  }

  const droppedIds = inputSet.filter((id) => !exactSeen.has(id) && !recoveredSeen.has(id))

  return {
    inputIds: inputSet,
    exactIds: inputSet.filter((id) => exactSeen.has(id)),
    recoveredIds: inputSet.filter((id) => recoveredSeen.has(id)),
    droppedIds,
    residueTokens,
    hallucinatedTokens,
    mangles,
    exact,
    recoverable,
    residue: residueTokens.length,
    dropped: droppedIds.length,
    hallucinatedOutOfRange: hallucinatedTokens.length,
  }
}

/** Sum of a set of reports — the shape a bench cell aggregates into. */
export interface FidelityTotals {
  samples: number
  inputIds: number
  exactIds: number
  recoveredIds: number
  droppedIds: number
  exact: number
  recoverable: number
  residue: number
  hallucinatedOutOfRange: number
}

/**
 * Aggregate reports into one cell of a bench table. Id counts are summed across
 * samples rather than deduplicated: two samples that each echo `PERSON_1`
 * exactly are two successes, not one.
 */
export function totalFidelity(reports: readonly FidelityReport[]): FidelityTotals {
  const sum = (pick: (r: FidelityReport) => number): number =>
    reports.reduce((acc, r) => acc + pick(r), 0)
  return {
    samples: reports.length,
    inputIds: sum((r) => r.inputIds.length),
    exactIds: sum((r) => r.exactIds.length),
    recoveredIds: sum((r) => r.recoveredIds.length),
    droppedIds: sum((r) => r.droppedIds.length),
    exact: sum((r) => r.exact),
    recoverable: sum((r) => r.recoverable),
    residue: sum((r) => r.residue),
    hallucinatedOutOfRange: sum((r) => r.hallucinatedOutOfRange),
  }
}
