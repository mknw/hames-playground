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
 * following recurses at most `nestedLevels` deep (the egress reader passes 3),
 * so the whole call is linear in input length plus a bounded number of parsed
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
        sourceSpan,
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
    if (url) collect(url, 0, null)
  }
  return { spans: result, destinations }
}
