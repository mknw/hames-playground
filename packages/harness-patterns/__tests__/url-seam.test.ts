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
import { describe, expect, it } from 'vitest'
import { addressesIn } from '../egress-gate.server'
import { egressArgumentSpans, interpretUrlSpans } from '../url-seam'

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
    // The reader keeps the verbatim address for the given-address comparison:
    // an unparseable candidate is still an address, never dropped.
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
