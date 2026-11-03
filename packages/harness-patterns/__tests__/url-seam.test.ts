/**
 * The URL interpretation seam (`docs/plan/url-interpretation-seam.md`, slice
 * 1): the pure module's contract, pinned on the three properties the egress
 * readers depend on — verbatim spans, every scheme occurrence, and no
 * canonicalization before comparison.
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
})
