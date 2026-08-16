/**
 * End-to-end assistant markdown rendering (ChatMessages.renderAssistantMarkdown):
 * markdown → marked → sanitizer → entity/reference annotation.
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
import type { RetrievalReference } from '~/lib/harness-patterns/patterns/retriever.server'
import { escapeHtmlAttribute } from '~/lib/sanitize-html'

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
    const out = renderAssistantMarkdown(
      '<img src="x.png" onerror="window.stolen = 1">',
      noEntities,
      [],
    )
    const img = mount(out).querySelector('img')
    expect(img).not.toBeNull()
    expect(img!.getAttribute('src')).toBe('x.png')
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
    expect(host.querySelector('sup.doc-ref-mark')?.textContent).toBe('↗')
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

  // The filename is interpolated into the citation `title`. marked escapes
  // quotes in text, so a quote-bearing filename no longer matches its own
  // mention and the span is usually not emitted at all — the escaping is what
  // holds if that ever changes. The docId and entity-id cases above are the
  // directly reachable ones; this pins the value, not just the outcome.
  it('escapes a quote in a filename before it reaches the citation title', () => {
    const source = 'q1" onmouseover="window.stolen=1" x="report.pdf'
    const host = mount(
      renderAssistantMarkdown(`Summary of ${source} attached.`, noEntities, [reference(source)]),
    )

    expect(attributeNames(host)).not.toContain('onmouseover')
    expect(attributeNames(host)).not.toContain('x')
    expect(escapeHtmlAttribute(source)).toBe(
      'q1&quot; onmouseover=&quot;window.stolen=1&quot; x=&quot;report.pdf',
    )
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
