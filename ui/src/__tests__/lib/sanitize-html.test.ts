/**
 * Sanitizer for the chat rendering path.
 *
 * Covers what must be removed from marked's output (scripts, event handlers,
 * script-bearing URLs), what must survive it (the markdown feature set the
 * chat actually renders, plus the entity/reference annotation spans), and the
 * attribute-escaping helper the annotators interpolate through.
 */
import { describe, it, expect } from 'vitest'
import { escapeHtmlAttribute, sanitizeMarkdownHtml } from '~/lib/sanitize-html'

describe('sanitizeMarkdownHtml', () => {
  it('drops script elements and their contents', () => {
    const out = sanitizeMarkdownHtml('<p>hi</p><script>window.stolen = 1</script>')
    expect(out).toContain('<p>hi</p>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('window.stolen')
  })

  it('drops inline event handlers but keeps the element', () => {
    const out = sanitizeMarkdownHtml('<img src="x.png" onerror="window.stolen = 1">')
    expect(out).toContain('<img')
    expect(out).toContain('src="x.png"')
    expect(out).not.toContain('onerror')
  })

  it('neutralises javascript: URLs on links', () => {
    const out = sanitizeMarkdownHtml('<a href="javascript:window.stolen=1">click</a>')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('click')
  })

  it('drops iframes, objects and form controls that markdown never emits', () => {
    const out = sanitizeMarkdownHtml(
      '<iframe src="https://evil.test"></iframe><object data="x"></object><form><button>x</button></form>',
    )
    expect(out).not.toContain('<iframe')
    expect(out).not.toContain('<object')
    expect(out).not.toContain('<form')
  })

  it('drops unknown data attributes while keeping the annotator ones', () => {
    const out = sanitizeMarkdownHtml(
      '<span data-entity-name="Acme" data-unexpected="1">Acme</span>',
    )
    expect(out).toContain('data-entity-name="Acme"')
    expect(out).not.toContain('data-unexpected')
  })

  it('keeps the markdown feature set the chat renders', () => {
    const html = [
      '<h2>Title</h2>',
      '<p><strong>bold</strong> <em>italic</em> <del>struck</del></p>',
      '<pre><code class="language-js">const a = 1</code></pre>',
      '<table><thead><tr><th align="left">a</th></tr></thead>',
      '<tbody><tr><td align="right">1</td></tr></tbody></table>',
      '<ul><li><input checked="" disabled="" type="checkbox"> done</li></ul>',
      '<blockquote><p>quote</p></blockquote>',
      '<p><a href="https://example.test/doc">link</a></p>',
      '<p><img src="https://example.test/i.png" alt="pic"></p>',
      '<hr>',
    ].join('')
    const out = sanitizeMarkdownHtml(html)

    expect(out).toContain('<h2>Title</h2>')
    expect(out).toContain('<strong>bold</strong>')
    expect(out).toContain('<em>italic</em>')
    expect(out).toContain('<del>struck</del>')
    expect(out).toContain('class="language-js"')
    expect(out).toContain('const a = 1')
    expect(out).toContain('<table>')
    expect(out).toContain('align="left"')
    expect(out).toContain('align="right"')
    expect(out).toContain('type="checkbox"')
    expect(out).toContain('<blockquote>')
    expect(out).toContain('href="https://example.test/doc"')
    expect(out).toContain('src="https://example.test/i.png"')
    expect(out).toContain('alt="pic"')
    expect(out).toContain('<hr>')
  })

  it('keeps the annotation spans the post-processors emit', () => {
    const annotated =
      '<p><span class="graph-entity toggled" data-entity-name="Acme Corp" ' +
      'data-entity-ids="n1,n2" title="Click to pin highlight">Acme Corp</span> and ' +
      '<span class="doc-ref" data-doc-id="doc-1" title="Open notes.md in viewer">' +
      'notes.md<sup class="doc-ref-mark">↗</sup></span></p>'
    const out = sanitizeMarkdownHtml(annotated)

    expect(out).toContain('class="graph-entity toggled"')
    expect(out).toContain('data-entity-name="Acme Corp"')
    expect(out).toContain('data-entity-ids="n1,n2"')
    expect(out).toContain('class="doc-ref"')
    expect(out).toContain('data-doc-id="doc-1"')
    expect(out).toContain('<sup class="doc-ref-mark">↗</sup>')
  })
})

describe('escapeHtmlAttribute', () => {
  it('escapes the characters that can terminate a quoted attribute', () => {
    expect(escapeHtmlAttribute(`a"b'c<d>e&f`)).toBe('a&quot;b&#39;c&lt;d&gt;e&amp;f')
  })

  it('escapes ampersands before the other replacements', () => {
    expect(escapeHtmlAttribute('&quot;')).toBe('&amp;quot;')
  })

  it('leaves ordinary values alone', () => {
    expect(escapeHtmlAttribute('quarterly-report.pdf')).toBe('quarterly-report.pdf')
  })
})
