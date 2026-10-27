/** G14's single production import site for lib/privacy. Builds one ephemeral
 *  roster/table per invocation; nothing is persisted, cached or reversed. Two
 *  factories over one table build: `createWebPseudonymiser` (K5, the info route's
 *  rewritten view) and `createEgressRoster` (the egress gate's roster: the
 *  directory status, the spans an outgoing request names, and its extension
 *  from local results). */
import { assertServerOnImport } from '@hames-ai/harness-patterns/assert.server'
import type {
  EgressDirectoryStatus,
  EgressRosterSource,
  PseudonymiseForWeb,
} from '@hames-ai/harness-patterns'
import { splitAtFenceLines, unspotlight } from '@hames-ai/harness-patterns/guard'
import { extractRoster } from '../privacy/graph-roster'
import { rosterFromDirectory, mergeRosters } from '../privacy/org-roster'
import { buildTable, apply, type PseudonymTable } from '../privacy/pseudonymise'
import { loadDirectoryRoster } from '../org-graph/roster-source.server'

assertServerOnImport()

const isPlaceholder = (name: string | null): boolean => /^PERSON_\d/i.test(name ?? '')

function mapStrings<T>(value: T, fn: (text: string) => string, keys = false): T {
  if (typeof value === 'string') return fn(value) as T
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn, keys)) as T
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        keys ? fn(key) : key,
        mapStrings(item, fn, keys),
      ]),
    ) as T
  }
  return value
}

/** Work only on content bodies and text outside fences, including embedded
 * fences in plan/handoff strings. Provenance is never roster text. The split is
 * the guard's own (`splitAtFenceLines`, built from the header parts `spotlight`
 * writes), so it cannot drift from the writer. It recognises the legacy header
 * too: persisted conversations carry it, and a header it missed would be read
 * as content. */
function mapContent(text: string, fn: (body: string) => string): string {
  return splitAtFenceLines(text)
    .map((part, index) => (index % 2 ? part : fn(part)))
    .join('')
}

/** An accepted actorCritic record is ONE JSON string, so a newline in a leaf
 * arrives as the two characters `\n` and glues itself to the next word
 * (`\nOtto`), where no word boundary matches. Work per parsed leaf, then
 * re-stringify only if something changed. Anything not valid JSON is plain text. */
function mapBody(body: string, fn: (text: string) => string, keys = false): string {
  if (/^\s*[[{]/.test(body)) {
    try {
      const parsed: unknown = JSON.parse(body)
      let changed = false
      const mapped = mapStrings(
        parsed,
        (leaf) => {
          const next = fn(leaf)
          if (next !== leaf) changed = true
          return next
        },
        keys,
      )
      return changed ? JSON.stringify(mapped) : body
    } catch {
      // Not JSON after all.
    }
  }
  // A decision record's model-written text (a plan, a Return, reasoning, a failure)
  // is ONE JSON string literal inside plain text: the same glue, one level down.
  // Decode only a literal JSON.stringify itself writes, so an escape the content
  // spelled (`\u27e6`) never becomes the character the guard escaped. One pass, left
  // to right: a quote with no close on its line is plain text to the line's end, so
  // no scan restarts inside it (SD-2).
  return body.replace(/"(?:[^"\\\n]|\\.)*"|"[^\n]*|[^"]+/g, (part) => {
    if (part[0] === '"') {
      try {
        const leaf: unknown = JSON.parse(part)
        if (typeof leaf === 'string' && JSON.stringify(leaf) === part) {
          const next = fn(leaf)
          return next === leaf ? part : JSON.stringify(next)
        }
      } catch {
        // Unterminated or not JSON: plain text.
      }
    }
    return fn(part)
  })
}

/** Batch every content span so the pure rewriter compiles its matcher once
 * for this value, rather than once per string leaf. */
function applyToContent<T>(value: T, table: PseudonymTable): T {
  const bodies: string[] = []
  const collect = (text: string) => {
    bodies.push(text)
    return text
  }
  mapStrings(value, (text) => mapContent(text, (body) => mapBody(body, collect, true)))
  const rewritten = apply(bodies, table)
  let index = 0
  return mapStrings(value, (text) =>
    mapContent(text, (body) => mapBody(body, () => rewritten[index++], true)),
  )
}

const normalise = (text: string): string =>
  text
    // JSON stringification can put a literal escape immediately before a
    // name/address. Decode Unicode escapes; other JSON escapes are boundaries.
    .replace(/\\(?:u([\da-f]{4})|[nrtfb"\\/])/gi, (_escape, hex: string | undefined) =>
      hex ? String.fromCharCode(parseInt(hex, 16)) : ' ',
    )
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[-_.+/]/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
const squash = (text: string): string => text.replace(/[^\p{L}]/gu, '')
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function stringsIn(value: unknown): string[] {
  const texts: string[] = []
  JSON.stringify(value, (key, item) => {
    texts.push(key)
    if (typeof item === 'string') texts.push(item)
    return item
  })
  return texts
}

/** A single compiled alternation, with invocation-local exemptions. No regex
 * construction per form or per check, even for a large tenant directory. */
function literalCheck(table: PseudonymTable, latestUserMessage: string) {
  const user = normalise(latestUserMessage)
  const exempt = new Set<string>()
  const literals = new Set<string>()
  const squashed = new Set<string>()
  let matcher: RegExp | undefined
  const namedByUser = (literal: string): boolean => {
    for (
      let start = user.indexOf(literal);
      start !== -1;
      start = user.indexOf(literal, start + 1)
    ) {
      if (
        !/[\p{L}\p{N}]$/u.test(user.slice(0, start)) &&
        !/^[\p{L}\p{N}]/u.test(user.slice(start + literal.length))
      )
        return true
    }
    return false
  }
  const extend = (next: PseudonymTable) => {
    for (const form of next.entries.flatMap((entry) => entry.forms)) {
      const literal = normalise(form.value)
      if (!literal || exempt.has(literal)) continue
      if (namedByUser(literal)) {
        exempt.add(literal)
        continue
      }
      literals.add(literal)
      if (form.kind === 'name' || form.kind === 'name-variant') {
        const full = squash(literal)
        if ([...full].length >= 6) squashed.add(full)
      }
    }
    const branches: string[] = []
    if (literals.size)
      branches.push(
        `(?<![\\p{L}\\p{N}])(?:${[...literals]
          .sort((a, b) => b.length - a.length)
          .map(escapeRegExp)
          .join('|')})(?![\\p{L}\\p{N}])`,
      )
    if (squashed.size)
      branches.push(
        `(?<![\\p{L}\\p{N}])(?:${[...squashed].map(escapeRegExp).join('|')})(?![\\p{L}\\p{N}])`,
      )
    // Both forms and input are already lowercased. Unicode ignore-case would
    // make V8 expand thousands of alternatives again on first execution.
    // Global, so one compiled matcher also finds every span; each `test` starts
    // from 0.
    matcher = branches.length ? new RegExp(branches.join('|'), 'gu') : undefined
  }
  extend(table)
  const test = (text: string): boolean => {
    matcher!.lastIndex = 0
    return matcher!.test(text)
  }
  const matches = (text: string): boolean => {
    const normalised = normalise(text)
    return (
      !!matcher &&
      (test(normalised) || normalised.split(/\s+/).some((token) => test(squash(token))))
    )
  }
  return {
    extend,
    matches,
    /** The spans of `text` the matcher finds, as they occur in `text`, in order.
     *  When the normalised text cannot be mapped back character for character,
     *  the whole text is the span: more evidence, never less. */
    spans: (text: string): string[] => {
      if (!matches(text)) return []
      const mapped = normaliseMapped(text)
      if (!mapped) return [text]
      // `exec` on the one compiled matcher: `matchAll` would construct a copy
      // per call, which is the allocation this matcher exists to avoid.
      const found: Array<[number, number]> = []
      const literal: Array<[number, number]> = []
      matcher!.lastIndex = 0
      for (let m = matcher!.exec(mapped.text); m; m = matcher!.exec(mapped.text)) {
        if (m[0].length === 0) {
          matcher!.lastIndex++
          continue
        }
        literal.push([m.index, m.index + m[0].length])
        found.push([mapped.starts[m.index], mapped.ends[m.index + m[0].length - 1]])
      }
      // A compact spelling ("MiraCedar") is found per token; a token inside a
      // span the literal pass already found adds nothing.
      let at = 0
      for (const token of mapped.text.split(' ')) {
        const end = at + token.length
        if (token && !literal.some(([a, b]) => at < b && end > a) && test(squash(token)))
          found.push([mapped.starts[at], mapped.ends[end - 1]])
        at = end + 1
      }
      found.sort((a, b) => a[0] - b[0] || a[1] - b[1])
      const spans: string[] = []
      for (const [start, end] of found) {
        const span = text.slice(start, end)
        if (!spans.includes(span)) spans.push(span)
      }
      return spans
    },
  }
}

const UNICODE_OR_JSON_ESCAPE = /\\(?:u([\da-f]{4})|[nrtfb"\\/])|[\s\S]/giu

/**
 * {@link normalise}, with the span of `text` each output character came from, so
 * a match on the normalised text can be quoted as the request wrote it. Built
 * piece by piece (each escape or code point on its own) and checked against the
 * whole-string `normalise`: where the two differ (a context-sensitive lower
 * case), `undefined`, and the caller quotes the whole text.
 */
function normaliseMapped(
  text: string,
): { text: string; starts: number[]; ends: number[] } | undefined {
  const chars: string[] = []
  const starts: number[] = []
  const ends: number[] = []
  UNICODE_OR_JSON_ESCAPE.lastIndex = 0
  for (
    let token = UNICODE_OR_JSON_ESCAPE.exec(text);
    token;
    token = UNICODE_OR_JSON_ESCAPE.exec(text)
  ) {
    const start = token.index
    const end = start + token[0].length
    const raw =
      token[0].length > 1 && token[0][0] === '\\'
        ? token[1]
          ? String.fromCharCode(parseInt(token[1], 16))
          : ' '
        : token[0]
    const piece = raw
      .normalize('NFKD')
      .replace(/\p{M}/gu, '')
      .replace(/[-_.+/]/g, ' ')
      .toLowerCase()
    for (const unit of piece) {
      const space = /\s/.test(unit)
      // Collapse a whitespace run into one space spanning all of it.
      if (space && chars.length > 0 && chars[chars.length - 1] === ' ') {
        ends[ends.length - 1] = end
        continue
      }
      // One entry per code UNIT (a match's index counts them): a code point
      // outside the BMP is two, both from this token.
      const out = space ? ' ' : unit
      for (let i = 0; i < out.length; i++) {
        chars.push(out[i])
        starts.push(start)
        ends.push(end)
      }
    }
  }
  const mapped = chars.join('')
  return mapped === normalise(text) ? { text: mapped, starts, ends } : undefined
}

// Older guarded payloads may contain nested fences. Harvest identity values,
// never a leftover provenance header, even when those payloads are replayed.
function unfenceRosterValue(text: string): string {
  for (;;) {
    const body = unspotlight(text)
    if (body === text) return text
    text = body
  }
}

/** The screen replaces a quoted span with this marker BEFORE the host sees the
 * result, so a person it names in a labelled field is gone from the data and
 * would silently drop out of the roster (their other spellings then pass). */
const NEUTRALIZED_MARKER = /⟦neutralized:/

const harvest = (payloads: unknown) => {
  // Unfence BEFORE the extractor: a guarded result is fenced, and a fenced
  // string hides every field from it.
  const unfenced = mapStrings(payloads, unfenceRosterValue)
  const found = extractRoster(unfenced)
  const damaged = found.some((entry) =>
    [entry.name, entry.address, ...entry.nameVariants].some(
      (value) => value !== null && NEUTRALIZED_MARKER.test(value),
    ),
  )
  // Fail closed: K5 withholds earlier content; the egress gate refuses egress.
  if (damaged) throw new Error('An identity field was neutralized: the roster is incomplete')
  return found
    .map((entry) => ({
      ...entry,
      name: isPlaceholder(entry.name) ? null : entry.name,
      nameVariants: entry.nameVariants.filter((name) => !isPlaceholder(name)),
    }))
    .filter((entry) => entry.address || entry.nameVariants.length > 0)
}

/** One invocation's roster and outgoing matcher: the directory (unless declared
 *  `none`) first, so colleagues keep their placeholder numbers, then the
 *  identities harvested from `payloads` in first-seen order (E1). Throws when a
 *  labelled identity field was neutralised (`harvest`). */
function buildRoster(payloads: unknown, members: Parameters<typeof rosterFromDirectory>[0]) {
  const directoryRoster = rosterFromDirectory(members)
  // Earlier info expansions can carry placeholders in labelled name fields.
  // They are already rewritten: harvesting them as new identities would map
  // PERSON_2 to another person's number on the next invocation.
  const payloadRoster = harvest(payloads)
  return { directoryRoster, table: buildTable(mergeRosters(directoryRoster, payloadRoster)) }
}

/** `none` is only for a deployment without an org graph. Set it in code at
 *  the composition root, never from an env var. A required empty/unreadable
 *  directory throws: the wrapper withholds earlier content. */
export function createWebPseudonymiser({
  directory = 'required',
}: { directory?: 'required' | 'none' } = {}): PseudonymiseForWeb {
  return async (payloads, latestUserMessage) => {
    const members = directory === 'none' ? [] : await loadDirectoryRoster()
    const { directoryRoster, table } = buildRoster(payloads, members)
    if (directory !== 'none' && directoryRoster.length === 0) {
      throw new Error('Web privacy requires a non-empty directory')
    }
    // Match literals even inside markup: apply intentionally preserves tag
    // names/unquoted attributes and is therefore not an outgoing predicate.
    // Normalise URL slugs too, and exempt forms the user named.
    const outgoingLiterals = literalCheck(table, latestUserMessage)
    return {
      apply: <T>(value: T): T => applyToContent(value, table),
      redact: <T>(value: T): T =>
        mapStrings(
          value,
          (text) =>
            mapContent(text, (body) => {
              const out = mapBody(
                body,
                (leaf) => (outgoingLiterals.matches(leaf) ? '[withheld: private identity]' : leaf),
                true,
              )
              // An unchanged JSON body can still hide text no leaf holds (duplicate keys).
              return out === body && outgoingLiterals.matches(body)
                ? '[withheld: private identity]'
                : out
            }),
          true,
        ),
      checkLiterals: (value) => {
        let found = false
        for (const text of stringsIn(value)) {
          mapContent(text, (body) => {
            if (outgoingLiterals.matches(body)) found = true
            return body
          })
        }
        if (found) return 'The query contained a private identity; rephrase without it.'
      },
    }
  }
}

/**
 * The egress gate's roster (boundary guards, slice 4). Reports the directory as
 * `loaded`, `empty`, `unreadable` or `none` (declared in code, G14 D4) instead
 * of throwing for it: what an empty or unreadable directory means for a call is
 * the gate's directory matrix, not this factory's. Still THROWS when a labelled
 * identity field of `payloads` was neutralised, and so does `observe` for a
 * result: that person's other spellings would no longer match, and the gate
 * refuses egress while the damage is in the context. The matcher is the same
 * literal check the old outgoing check ran (forms the user's latest message
 * names are exempt); it returns the spans it finds as the request wrote them.
 */
export function createEgressRoster({
  directory = 'required',
}: { directory?: 'required' | 'none' } = {}): EgressRosterSource {
  return async (payloads, latestUserMessage) => {
    let status: EgressDirectoryStatus = 'none'
    let members: Awaited<ReturnType<typeof loadDirectoryRoster>> = []
    if (directory !== 'none') {
      try {
        members = await loadDirectoryRoster()
        status = 'loaded'
      } catch {
        // The error can name a person: only the status is kept.
        status = 'unreadable'
      }
    }
    const { directoryRoster, table } = buildRoster(payloads, members)
    if (status === 'loaded' && directoryRoster.length === 0) status = 'empty'
    const outgoing = literalCheck(table, latestUserMessage)
    return {
      directory: status,
      roster: {
        match: (texts) => texts.flatMap((text) => outgoing.spans(text)),
        observe: (data) => outgoing.extend(buildTable(harvest(data))),
      },
    }
  }
}
