/**
 * Sanitizer for the chat rendering path.
 *
 * Covers what must be removed from marked's output (scripts, event handlers,
 * script-bearing URLs, and — since SA-M10 — every `class`/`data-*` hook a model
 * could use to forge a citation), what must survive it (the markdown feature
 * set the chat actually renders), and the attribute-escaping helper the
 * annotators interpolate through.
 *
 * The annotators' own spans are NOT expected to survive this function: they are
 * added afterwards, by `renderAssistantMarkdown`, which is where the
 * end-to-end citation behaviour is tested.
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

  // SA-M10: the annotator hooks used to be allowlisted here, so model output
  // could forge them. They are now stripped unconditionally — the annotators
  // run AFTER this function and add their own.
  it('drops every data attribute, the annotator hooks included', () => {
    const out = sanitizeMarkdownHtml(
      '<span data-entity-name="Acme" data-entity-ids="n1" data-doc-id="doc-1" ' +
        'data-unexpected="1">Acme</span>',
    )
    expect(out).not.toContain('data-entity-name')
    expect(out).not.toContain('data-entity-ids')
    expect(out).not.toContain('data-doc-id')
    expect(out).not.toContain('data-unexpected')
    expect(out).toContain('Acme')
  })

  it('strips the interactive classes so a forged citation cannot render', () => {
    const forged =
      '<p>See <span class="doc-ref" data-doc-id="attacker-chosen">payroll.xlsx</span> ' +
      'and <span class="graph-entity toggled" data-entity-ids="n9">Acme</span></p>'
    const out = sanitizeMarkdownHtml(forged)

    expect(out).not.toContain('doc-ref')
    expect(out).not.toContain('graph-entity')
    expect(out).not.toContain('attacker-chosen')
    // The text itself is untouched — this neutralizes the hooks, not the prose.
    expect(out).toContain('payroll.xlsx')
    expect(out).toContain('Acme')
  })

  it('keeps the class values marked legitimately emits', () => {
    const out = sanitizeMarkdownHtml(
      '<pre><code class="language-ts">x</code></pre>' +
        '<ul class="contains-task-list"><li class="task-list-item">a</li></ul>',
    )
    expect(out).toContain('class="language-ts"')
    expect(out).toContain('class="contains-task-list"')
    expect(out).toContain('class="task-list-item"')
  })

  it('drops only the disallowed half of a mixed class attribute', () => {
    const out = sanitizeMarkdownHtml('<code class="language-js doc-ref">x</code>')
    expect(out).toContain('class="language-js"')
    expect(out).not.toContain('doc-ref')
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

  // Standing UI rule (2026-08-24): the app never navigates away to follow a
  // link, so the sanitizer — the one chokepoint every rendered assistant
  // message passes through — stamps the target and rel itself. See the
  // repo-wide guard in `src/__tests__/links-new-tab.test.ts` for the JSX half.
  it('points every rendered link at a new tab', () => {
    const out = sanitizeMarkdownHtml('<p><a href="https://example.test/doc">link</a></p>')

    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
    expect(out).toContain('href="https://example.test/doc"')
  })

  it('replaces a target and rel written by the model with its own', () => {
    const out = sanitizeMarkdownHtml(
      '<a href="https://example.test/doc" target="_self" rel="opener">link</a>',
    )

    expect(out).not.toContain('_self')
    expect(out).not.toContain('rel="opener"')
    expect(out).toContain('target="_blank"')
    expect(out).toContain('rel="noopener noreferrer"')
  })

  it('leaves an anchor with no href alone', () => {
    const out = sanitizeMarkdownHtml('<a>bare</a>')

    expect(out).toContain('bare')
    expect(out).not.toContain('target=')
  })

  // The annotator markup is NOT expected to survive a round trip any more —
  // it is never fed back through. This pins that, so nobody restores the
  // allowlist entries to "fix" it.
  it('does not preserve annotator markup fed back through it', () => {
    const annotated =
      '<p><span class="graph-entity toggled" data-entity-name="Acme Corp" ' +
      'data-entity-ids="n1,n2" title="Click to pin highlight">Acme Corp</span></p>'
    const out = sanitizeMarkdownHtml(annotated)

    expect(out).not.toContain('graph-entity')
    expect(out).not.toContain('data-entity-name')
    // `title` is harmless and stays; only the interactive hooks go.
    expect(out).toContain('title="Click to pin highlight"')
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
