// @vitest-environment node
// The server half of the chat link-review classification (#901 slice 1,
// ruling Q1): the recognised-host comparison runs HERE, against
// GRAPH_DOCUMENT_HOSTS, and only the verdict — the recognised hostnames among a
// message's own links — crosses to the browser. The hosts below are synthetic
// on purpose: the real tenant hostnames are env-provided and never appear in
// this repository.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recognisedLinkHostsFor } from '../../../lib/harness-client/link-verdicts.server'

afterEach(() => {
  vi.unstubAllEnvs()
})

const RECOGNISED = 'docs.example'
const RECOGNISED_2 = 'hub.example'

describe('recognisedLinkHostsFor() — the verdict the browser receives', () => {
  it('returns the recognised hostnames of the message own links, in order, deduplicated', () => {
    vi.stubEnv('GRAPH_DOCUMENT_HOSTS', `${RECOGNISED},${RECOGNISED_2}`)
    const out = recognisedLinkHostsFor(
      'See [a](https://docs.example/x), [b](https://docs.example/y) ' +
        'and [c](https://hub.example/z), not [d](https://untrusted.example/w).',
    )
    expect(out).toEqual([RECOGNISED, RECOGNISED_2])
  })

  it('matches hostnames exactly — a listed host is not its subdomains (M2)', () => {
    vi.stubEnv('GRAPH_DOCUMENT_HOSTS', RECOGNISED)
    const out = recognisedLinkHostsFor(
      '[ok](https://docs.example/a) [sub](https://sub.docs.example/b) ' +
        '[suffix](https://notdocs.example/c)',
    )
    expect(out).toEqual([RECOGNISED])
  })

  it('is case-consistent on both sides of the comparison', () => {
    vi.stubEnv('GRAPH_DOCUMENT_HOSTS', 'docs.example')
    // The markdown may spell the host upper-case; the URL parser lower-cases
    // the hostname, which is the form the client compares against too.
    expect(recognisedLinkHostsFor('[x](https://DOCS.example/a)')).toEqual(['docs.example'])
  })

  it('sees every spelling of an anchor the browser will render', () => {
    vi.stubEnv('GRAPH_DOCUMENT_HOSTS', `${RECOGNISED},${RECOGNISED_2}`)
    const md = [
      'An inline destination [a](https://docs.example/inline).',
      'A reference definition [b][ref] and an image ![c](https://docs.example/img.png).',
      '',
      '[ref]: https://docs.example/ref',
      '',
      'A raw anchor <a href="https://hub.example/raw">d</a>.',
      'An autolink <https://docs.example/auto>.',
    ].join('\n')
    expect(recognisedLinkHostsFor(md)).toEqual([RECOGNISED, RECOGNISED_2])
  })

  it('stays http/https only — other schemes are not link-review business', () => {
    vi.stubEnv('GRAPH_DOCUMENT_HOSTS', 'docs.example')
    const out = recognisedLinkHostsFor(
      '[mail](mailto:someone@docs.example) [ftp](ftp://docs.example/pub) ' +
        'and a bare [web](https://docs.example/x).',
    )
    // The mailto/ftp addresses carry the host string but are not web links;
    // the http one is, and is recognised.
    expect(out).toEqual([RECOGNISED])
  })

  it('unset or empty host list: nothing is recognised', () => {
    vi.stubEnv('GRAPH_DOCUMENT_HOSTS', undefined)
    expect(recognisedLinkHostsFor('[x](https://docs.example/a)')).toEqual([])
    vi.stubEnv('GRAPH_DOCUMENT_HOSTS', ' , ')
    expect(recognisedLinkHostsFor('[x](https://docs.example/a)')).toEqual([])
  })

  it('empty or link-less content: an empty verdict', () => {
    vi.stubEnv('GRAPH_DOCUMENT_HOSTS', RECOGNISED)
    expect(recognisedLinkHostsFor('')).toEqual([])
    expect(recognisedLinkHostsFor('No links at all, just prose.')).toEqual([])
  })

  // The scan is a superset of the rendered anchors: a bare-text address the
  // browser never links is still scanned, and its verdict is simply unused
  // client-side. A MISSED anchor hostname (the fail-open direction) is what
  // these tests exist to exclude — every spelling above that a rendered anchor
  // can carry is found.
  it('scans bare-text addresses too — a superset of the rendered anchors', () => {
    vi.stubEnv('GRAPH_DOCUMENT_HOSTS', RECOGNISED)
    const out = recognisedLinkHostsFor('Read https://docs.example/manual for details.')
    expect(out).toEqual([RECOGNISED])
  })
})
