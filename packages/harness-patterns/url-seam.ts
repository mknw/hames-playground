/**
 * The URL interpretation seam (`docs/plan/url-interpretation-seam.md`, slice 1).
 * One interpretation contract for every guard rule that reads a URL: where an
 * address begins and ends in the ORIGINAL text, and where it resolves.
 *
 * Pure and framework-neutral by design: no server-only import, no Node API
 * beyond the platform `URL` parser, so the ingress sanitizer, the egress gate
 * and a browser-side renderer can all consume it. This is an INTERNAL subpath
 * module (the package's export map is a wildcard), not a documented entry; it
 * carries no stability promise.
 *
 * The two outputs are deliberately separated: `spans` (with `raw`, the original
 * spelling) are for rewriting and exact comparison — a consumer never searches
 * for a canonical `href` in the source text; `destinations` are for decisions
 * and display and are never substituted back into content.
 *
 * ## Bounded work
 *
 * The scan's regexes are terminal (no backtracking into a variable-length run
 * followed by anything; SD-2), no regex is built from input, and nested-URL
 * following recurses at most `nestedLevels` deep (the egress reader passes 2:
 * the seam counts query-follow hops from 0, where the old reader's
 * `NESTED_URL_LEVELS = 3` counted levels from 1), so the whole call is linear
 * in input length plus a bounded number of parsed
 * URLs. Nothing here truncates or refuses on size: the egress reader's own
 * `EGRESS_MAX_BLOCK_CHARS` bound already refused oversized text before this
 * module sees it.
 */

/** A character range in the exact input string passed to the seam. */
export interface UrlSpanRange {
  /** Character offset (UTF-16 code unit) of the span's first character. */
  readonly start: number
  /** Offset one past the span's last character (`text.slice(start, end)`). */
  readonly end: number
}

export interface UrlSpan {
  /** Character offsets (UTF-16 code units) in the exact input string passed
   *  to the seam. */
  start: number
  end: number
  /** The original spelling, never a canonical rewrite. */
  raw: string
  /** `null` when the span is not a URL the platform parser accepts. */
  url: URL | null
}

export interface UrlDestination {
  href: string
  hostname: string
  port: string
  /** 0 for a URL written directly in the input; > 0 for a nested URL. */
  level: number
  /** The containing top-level span, when this destination came from a query
   *  value. */
  sourceSpan: UrlSpan | null
}

export interface UrlInterpretation {
  /** Every URL span the caller's lexical rule selected, in input order. */
  spans: readonly UrlSpan[]
  /** Resolvable outer and nested destinations, in appearance order,
   *  deduplicated by canonical `href` across the whole result — first
   *  appearance wins, and the retained destination's `sourceSpan` is that
   *  first appearance's. */
  destinations: readonly UrlDestination[]
}

// One URL from its scheme to the first character no address carries. Terminal,
// so it cannot backtrack (SD-2); every input is under the egress size bound.
const URL_AT = /https?:\/\/[^\s"'<>\\^`{|}]+/iy
// Every scheme occurrence: each starts a candidate, so a URL inside another
// URL's query is found too.
const SCHEME = /https?:\/\//gi
// A run of percent escapes, decoded as one: a literal percent ("5% growth")
// is left alone. The same decode the egress reader runs on query values.
const PERCENT_RUN = /(?:%[\da-f]{2})+/gi

function decodePercentRun(text: string): string {
  return text.replace(PERCENT_RUN, decodeURIComponent)
}

/**
 * The egress argument scan (slice 1): every http(s) address an argument may
 * carry, as character ranges — each scheme occurrence starts one, nested ones
 * included, and the span runs to the first character no address carries. This
 * is the one production lexical grammar that moved behind the seam; the
 * ingress corpus regexes stay visible corpus rules until a separate, measured
 * lexical change is approved.
 */
export function egressArgumentSpans(text: string): readonly UrlSpanRange[] {
  const ranges: UrlSpanRange[] = []
  for (const at of text.matchAll(SCHEME)) {
    URL_AT.lastIndex = at.index
    const candidate = URL_AT.exec(text)?.[0]
    if (candidate) ranges.push({ start: at.index, end: at.index + candidate.length })
  }
  return ranges
}

/**
 * Interpret the caller-selected spans of `text`: parse each one, keep the
 * original spelling beside the parsed URL, and — when `nestedLevels` asks for
 * it — follow URLs nested in decoded query values for their destinations.
 * A span the platform parser rejects is still a span, with `url: null`: the
 * callers' verbatim comparisons do not canonicalize, so an unparseable
 * candidate must not disappear.
 */
export function interpretUrlSpans(
  text: string,
  spans: readonly UrlSpanRange[],
  options: { readonly nestedLevels?: number } = {},
): UrlInterpretation {
  const nestedLevels = Math.max(0, options.nestedLevels ?? 0)
  const result: UrlSpan[] = []
  const destinations: UrlDestination[] = []
  const seenHref = new Set<string>()

  // Collect one parsed URL's destination, then follow the URLs nested in its
  // decoded query values. The recursion is bounded by `nestedLevels`, and the
  // recursive interpretation runs with no nested following of its own: only
  // its spans are consumed here.
  const collect = (url: URL, level: number, sourceSpan: UrlSpan | null): void => {
    if (!seenHref.has(url.href)) {
      seenHref.add(url.href)
      destinations.push({
        href: url.href,
        hostname: url.hostname,
        port: url.port,
        level,
        sourceSpan: level === 0 ? null : sourceSpan,
      })
    }
    if (level >= nestedLevels) return
    url.searchParams.forEach((value) => {
      // A query value is decoded once by URLSearchParams; decode what is left
      // too, so a doubly-encoded nested URL is followed as well. Broken
      // encoding: follow the value as it is.
      let decoded = value
      try {
        decoded = decodePercentRun(value)
      } catch {
        // follow the value as written
      }
      for (const span of interpretUrlSpans(decoded, egressArgumentSpans(decoded)).spans)
        if (span.url) collect(span.url, level + 1, sourceSpan)
    })
  }

  for (const range of spans) {
    const raw = text.slice(range.start, range.end)
    let url: URL | null = null
    try {
      url = new URL(raw)
    } catch {
      // Not an address the platform parser accepts; still a span for
      // verbatim comparison.
    }
    const span: UrlSpan = { start: range.start, end: range.end, raw, url }
    result.push(span)
    if (url) collect(url, 0, span)
  }
  return { spans: result, destinations }
}

// ============================================================================
// Offset map (slice 5)
// ============================================================================

/**
 * One rewrite in a pass, in that pass's INPUT coordinates: the code units
 * `[start, end)` became `length` code units. A strip is `length: 0`, an
 * insertion is `start === end`.
 */
export interface TextEdit {
  readonly start: number
  readonly end: number
  readonly length: number
}

/** One recorded pass: its edits plus, for each edit, its range in the pass's
 *  OUTPUT and the net length change of every edit before it. */
interface Pass {
  readonly inStart: readonly number[]
  readonly inEnd: readonly number[]
  readonly outStart: readonly number[]
  readonly outEnd: readonly number[]
  /** `shift[i]`: summed `length - (end - start)` of edits `0 … i-1`. */
  readonly shift: readonly number[]
}

/** How many leading entries of the nondecreasing `values` satisfy `ok`. */
function prefixCount(values: readonly number[], ok: (v: number) => boolean): number {
  let lo = 0
  let hi = values.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (ok(values[mid])) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * The explicit offset map from an ORIGINAL string to the string a sequence of
 * rewrite passes made of it (`docs/plan/url-interpretation-seam.md`, slice 5).
 * The ingress sanitizer records each rule's pass, so a span found in the text
 * at a later rule's pass can be located in the original leaf (`toOriginal`),
 * and a span of the original leaf located in the current text (`toCurrent`).
 *
 * A range maps by its two ends. An end that falls inside rewritten text —
 * inside a marker, or on a stripped character — snaps outward to the edge of
 * that rewrite: a range never maps to half a rewrite. Stripped characters at a
 * range's edge stay outside it; stripped characters inside it stay inside, so
 * the original range spells what the source wrote. Insertions at a range's
 * edge (a defang's backticks) stay outside it.
 *
 * Work: recording is linear in the number of edits; mapping is a binary search
 * per pass — no regex, no recursion, nothing that grows with the input faster
 * than the edits a bounded corpus produced.
 */
export class OffsetMap {
  private readonly passes: Pass[] = []

  /** Record one pass. `edits` must be sorted and non-overlapping, as one
   *  global `String.prototype.replace` produces them. */
  record(edits: readonly TextEdit[]): void {
    if (edits.length === 0) return
    const outStart: number[] = []
    const outEnd: number[] = []
    const shift: number[] = [0]
    for (const [i, edit] of edits.entries()) {
      if (edit.start > edit.end || (i > 0 && edit.start < edits[i - 1].end))
        throw new Error('OffsetMap: edits must be sorted and non-overlapping')
      outStart.push(edit.start + shift[i])
      outEnd.push(edit.start + shift[i] + edit.length)
      shift.push(shift[i] + edit.length - (edit.end - edit.start))
    }
    this.passes.push({
      inStart: edits.map((edit) => edit.start),
      inEnd: edits.map((edit) => edit.end),
      outStart,
      outEnd,
      shift,
    })
  }

  /** A range of the current text, located in the original text. */
  toOriginal(range: UrlSpanRange): UrlSpanRange {
    let { start, end } = range
    for (let p = this.passes.length - 1; p >= 0; p--) {
      const { inStart, inEnd, outStart, outEnd, shift } = this.passes[p]
      // Start: edits wholly before it shift it; one it sits inside snaps it
      // to that edit's input start.
      const s = prefixCount(outEnd, (v) => v <= start)
      start = s < inStart.length && outStart[s] <= start ? inStart[s] : start - shift[s]
      // End: edits that begin before it shift it; one it sits inside snaps it
      // to that edit's input end.
      const e = prefixCount(outStart, (v) => v < end)
      end = e > 0 && outEnd[e - 1] > end ? inEnd[e - 1] : end - shift[e]
    }
    return { start, end }
  }

  /** A range of the original text, located in the current text. */
  toCurrent(range: UrlSpanRange): UrlSpanRange {
    let { start, end } = range
    for (const { inStart, inEnd, outStart, outEnd, shift } of this.passes) {
      // The mirror image: an insertion AT the start precedes the character
      // there, an insertion AT the end follows the range.
      const s = prefixCount(inEnd, (v) => v <= start)
      start = s < inStart.length && inStart[s] <= start ? outStart[s] : start + shift[s]
      const e = prefixCount(inStart, (v) => v < end)
      end = e > 0 && inEnd[e - 1] > end ? outEnd[e - 1] : end + shift[e]
    }
    return { start, end }
  }
}
