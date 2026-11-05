/**
 * The URL interpretation seam (`docs/plan/url-interpretation-seam.md`, slice
 * 1): the pure module's contract, pinned on the three properties the egress
 * readers depend on — verbatim spans, every scheme occurrence, and no
 * canonicalization before comparison — plus the destinations' provenance:
 * a nested destination carries its containing top-level span, a level-0 one
 * carries none.
 *
 * Every pin names the source mutation that turns it red; the PR records that
 * each was run. Nothing here touches a server, a transport or the network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { addressesIn } from '../egress-gate.server'
import { resolveRules, sanitizeText } from '../injection-guard'
import { egressArgumentSpans, interpretUrlSpans, OffsetMap, type TextEdit } from '../url-seam'

describe('the URL interpretation seam (slice 1)', () => {
  // MUTATION: return `span.url?.href` (the parser's canonical spelling) as
  // `raw`: the lower-cased scheme and host replace the source spelling, and
  // every assertion in this test fails.
  it('a span is the original spelling, never a canonical rewrite', () => {
    const raw = 'HTTPS://Example.COM/A%20b?x=1'
    const text = `see ${raw} now`
    const [span] = interpretUrlSpans(text, egressArgumentSpans(text)).spans
    expect(span?.raw).toBe(raw)
    expect(span?.start).toBe(4)
    expect(span?.end).toBe(4 + raw.length)
    // The parser DOES canonicalize — lower-cased scheme and host — so the pin
    // is live: the two spellings differ, and `raw` must be the source one.
    expect(span?.url?.href).toBe('https://example.com/A%20b?x=1')
  })

  // MUTATION: stop the argument scan at the first scheme occurrence (`break`
  // after the first match): the nested address disappears and the span list is
  // one short.
  it('every scheme occurrence starts a span, nested ones included', () => {
    const text = 'top https://a.example/r?u=https://b.example/p tail'
    const spans = interpretUrlSpans(text, egressArgumentSpans(text)).spans
    expect(spans.map((s) => s.raw)).toEqual([
      'https://a.example/r?u=https://b.example/p',
      'https://b.example/p',
    ])
    for (const span of spans) expect(text.slice(span.start, span.end)).toBe(span.raw)
  })

  // MUTATION: keep only the spans whose `url` parses (drop the
  // `url: null` ones from the result): the address the egress reader compares
  // verbatim disappears, an unparseable candidate stops being comparable, and
  // both assertions fail.
  it('no canonicalization before comparison: an unparseable address is still a span', () => {
    const text = 'go https://% today'
    const [span] = interpretUrlSpans(text, egressArgumentSpans(text)).spans
    expect(span?.url).toBeNull()
    expect(span?.raw).toBe('https://%')
    // The string projection keeps the verbatim address for comparisons that
    // consume it: an unparseable candidate is still an address, never dropped.
    expect(addressesIn(text)).toEqual(['https://%'])
  })

  // MUTATION: revert the entry threading (`collect(url, 0, null)` at the
  // level-0 call): every destination reports `sourceSpan: null` again, and
  // the nested assertion fails.
  it('a destination from a query value carries its containing top-level span; a level-0 destination carries none', () => {
    const top = 'https://a.example/r?u=https://b.example/p'
    const text = `see ${top} tail`
    const { spans, destinations } = interpretUrlSpans(text, egressArgumentSpans(text), {
      nestedLevels: 1,
    })
    const [topDestination, nested] = destinations
    // A URL written directly in the input has no containing span.
    expect(topDestination?.level).toBe(0)
    expect(topDestination?.sourceSpan).toBeNull()
    // The nested one names the top-level span it came from — same offsets and
    // spelling as the level-0 span, never a canonical rewrite.
    expect(nested?.level).toBe(1)
    expect(nested?.href).toBe('https://b.example/p')
    const [topSpan] = spans
    expect(nested?.sourceSpan?.raw).toBe(top)
    expect(nested?.sourceSpan?.start).toBe(topSpan?.start)
    expect(nested?.sourceSpan?.end).toBe(topSpan?.end)
    expect(text.slice(nested!.sourceSpan!.start, nested!.sourceSpan!.end)).toBe(top)
  })

  // Slice 2: `destinationHosts` consumes `destinations`, so their contract is
  // load-bearing. MUTATION: push every destination (drop the `seenHref` check
  // in `collect`): the same nested URL appears twice — first through the
  // query recursion, then as the literal top-level span — and both assertions
  // fail: the count, and the retained first appearance's level.
  it('destinations are deduplicated by canonical href; the first appearance is the one kept', () => {
    const text = 'see https://a.example/r?u=https://b.example/p tail'
    const { destinations } = interpretUrlSpans(text, egressArgumentSpans(text), {
      nestedLevels: 1,
    })
    // b.example is reached through the query first; its later literal span is
    // the same href and is dropped — the retained destination is the first
    // appearance's (level 1, from the query value).
    expect(destinations).toHaveLength(2)
    expect(destinations[1]).toMatchObject({ level: 1, hostname: 'b.example' })
  })
})

/** The text one pass of `edits` makes of `text`, writing `fill` repeated for
 *  each edit's new length — the shape a rule's `String.replace` produces. */
function applyPass(text: string, edits: readonly TextEdit[], fill = '#'): string {
  let out = ''
  let cursor = 0
  for (const edit of edits) {
    out += text.slice(cursor, edit.start) + fill.repeat(edit.length)
    cursor = edit.end
  }
  return out + text.slice(cursor)
}

describe('the offset map (slice 5)', () => {
  // MUTATION: count an edit that ENDS at a start as inside it (`v < start` in
  // `toOriginal`'s start search): the range after a strip snaps back onto the
  // stripped characters, `{4,6}` becomes `{2,6}`. Count a strip that STARTS at
  // an end as before it (`v <= end` in `toOriginal`'s end search): `{0,2}`
  // swallows the stripped `XY` and becomes `{0,4}`.
  it('a strip: stripped characters at a range edge stay outside, inside stay inside', () => {
    const original = 'abXYcdef'
    const map = new OffsetMap()
    map.record([{ start: 2, end: 4, length: 0 }])
    expect(applyPass(original, [{ start: 2, end: 4, length: 0 }])).toBe('abcdef')
    expect(map.toOriginal({ start: 2, end: 4 })).toEqual({ start: 4, end: 6 }) // cd
    expect(map.toOriginal({ start: 0, end: 2 })).toEqual({ start: 0, end: 2 }) // ab
    expect(map.toOriginal({ start: 1, end: 3 })).toEqual({ start: 1, end: 5 }) // bXYc
    expect(map.toCurrent({ start: 4, end: 6 })).toEqual({ start: 2, end: 4 })
    expect(map.toCurrent({ start: 1, end: 5 })).toEqual({ start: 1, end: 3 })
  })

  // MUTATION: drop the inside-snap in `toOriginal` (always subtract the shift):
  // a range ending inside the marker maps into the middle of `IGNORE`.
  it('a length-changing replacement: an end inside it snaps to its edge', () => {
    const map = new OffsetMap()
    map.record([{ start: 2, end: 8, length: 3 }]) // abIGNOREcd -> ab###cd
    expect(map.toOriginal({ start: 0, end: 7 })).toEqual({ start: 0, end: 10 })
    expect(map.toOriginal({ start: 0, end: 4 })).toEqual({ start: 0, end: 8 })
    expect(map.toOriginal({ start: 3, end: 4 })).toEqual({ start: 2, end: 8 })
    expect(map.toOriginal({ start: 5, end: 7 })).toEqual({ start: 8, end: 10 })
    expect(map.toCurrent({ start: 2, end: 8 })).toEqual({ start: 2, end: 5 })
    expect(map.toCurrent({ start: 8, end: 10 })).toEqual({ start: 5, end: 7 })
  })

  // MUTATION: count an insertion AT the end as before it (`v <= end` in
  // `toCurrent`'s end search): the closing backtick lands inside the range,
  // `{3,14}` becomes `{3,15}`.
  it("a defang's backticks are insertions that stay outside the range they wrap", () => {
    const original = 'x https://a/q y'
    const edits = [
      { start: 2, end: 2, length: 1 },
      { start: 13, end: 13, length: 1 },
    ]
    const map = new OffsetMap()
    map.record(edits)
    expect(applyPass(original, edits, '`')).toBe('x `https://a/q` y')
    expect(map.toCurrent({ start: 2, end: 13 })).toEqual({ start: 3, end: 14 })
    expect(map.toOriginal({ start: 3, end: 14 })).toEqual({ start: 2, end: 13 })
  })

  // MUTATION: compose the passes in the wrong order (iterate `toOriginal`
  // forward): the second pass's coordinates are read in the first's.
  it('passes compose in order, in UTF-16 code units, across non-BMP characters', () => {
    // A tag character (2 units), `ab`, an emoji (2 units), a zero-width space,
    // `cd`: the hidden-text rules strip the space, then the tag character.
    const original = '\u{E0041}ab\u{1F600}\u200Bcd'
    const pass1 = [{ start: 6, end: 7, length: 0 }]
    const pass2 = [{ start: 0, end: 2, length: 0 }]
    const current = applyPass(applyPass(original, pass1), pass2)
    expect(current).toBe('ab\u{1F600}cd')
    const map = new OffsetMap()
    map.record(pass1)
    map.record(pass2)
    expect(map.toOriginal({ start: 4, end: 6 })).toEqual({ start: 7, end: 9 })
    const b2c = map.toOriginal({ start: 1, end: 5 })
    expect(original.slice(b2c.start, b2c.end)).toBe('b\u{1F600}\u200Bc')
    expect(map.toCurrent(b2c)).toEqual({ start: 1, end: 5 })
  })

  // The property the URL rule's landing check relies on: a range whose first
  // and last characters survived every pass maps to the original and back
  // onto itself. MUTATION: any of the boundary mutations above, or dropping a
  // `shift` term: some seeded range no longer round-trips.
  it('a range of surviving characters round-trips exactly through random passes', () => {
    let seed = 7
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed % n
    }
    for (let trial = 0; trial < 500; trial++) {
      // Characters are tagged with their original index so survival is
      // checkable; rewrites write `#`.
      let current: (number | null)[] = Array.from({ length: 40 }, (_, i) => i)
      const map = new OffsetMap()
      for (let pass = 0; pass < 4; pass++) {
        const edits: TextEdit[] = []
        let at = rnd(4)
        while (at < current.length) {
          const len = rnd(3)
          edits.push({ start: at, end: at + len, length: rnd(3) })
          at += len + 1 + rnd(5)
        }
        const next: (number | null)[] = []
        let cursor = 0
        for (const edit of edits) {
          next.push(...current.slice(cursor, edit.start), ...Array<null>(edit.length).fill(null))
          cursor = edit.end
        }
        current = [...next, ...current.slice(cursor)]
        map.record(edits)
      }
      for (let start = 0; start < current.length; start++) {
        for (let end = start + 1; end <= current.length; end++) {
          const first = current[start]
          const last = current[end - 1]
          if (first === null || last === null) continue
          const original = map.toOriginal({ start, end })
          expect(original).toEqual({ start: first, end: last + 1 })
          expect(map.toCurrent(original)).toEqual({ start, end })
        }
      }
    }
  })

  it('refuses edits that are not sorted and non-overlapping', () => {
    const map = new OffsetMap()
    expect(() =>
      map.record([
        { start: 4, end: 6, length: 0 },
        { start: 5, end: 7, length: 0 },
      ]),
    ).toThrow('sorted and non-overlapping')
  })
})

describe("the URL rule's landing check (slice 5)", () => {
  afterEach(() => vi.restoreAllMocks())

  // MUTATION: drop the landing check in `rewriteThroughSeam` (rewrite at the
  // mapped range whatever it is): a map that is off by one defangs the wrong
  // characters — the URL's last character is left outside the backticks — and
  // this pin fails because nothing throws.
  it('a mapped span that does not land on the detector match fails closed', () => {
    const real = OffsetMap.prototype.toCurrent
    vi.spyOn(OffsetMap.prototype, 'toCurrent').mockImplementation(function (this: OffsetMap, r) {
      const at = real.call(this, r)
      return { start: at.start, end: at.end - 1 }
    })
    const url = `https://evil.example/c?d=${'A'.repeat(80)}`
    expect(() => sanitizeText(`see ${url}`, resolveRules())).toThrow(
      'mapped span does not land on its match',
    )
  })
})
