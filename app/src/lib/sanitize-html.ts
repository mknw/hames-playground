/**
 * HTML hardening helpers for the chat rendering path.
 *
 * Assistant messages are markdown rendered by `marked` and handed to
 * `innerHTML`. That markdown frequently carries tool-result content verbatim
 * (mail bodies, document text, web pages), so the rendered HTML has to be
 * treated as untrusted before it reaches the DOM, and again on every reload
 * because it is persisted in conversation history.
 *
 * Two helpers live here:
 *  - {@link sanitizeMarkdownHtml} — runs marked's output through DOMPurify with
 *    an allowlist sized to what marked actually emits.
 *  - {@link escapeHtmlAttribute} — for values interpolated into attributes of
 *    markup we generate ourselves (entity/reference annotations).
 */

import DOMPurify from 'dompurify'

/**
 * Tags `marked` emits for the feature set the chat uses (gfm + breaks):
 * headings, emphasis, code fences, lists, task-list checkboxes, tables,
 * blockquotes, links and images — plus the `span`/`sup` the entity and
 * reference annotators add on top of the rendered HTML.
 */
const ALLOWED_TAGS = [
  'p',
  'br',
  'hr',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'a',
  'ul',
  'ol',
  'li',
  'input',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'img',
  'span',
  'sup',
  'sub',
]

/**
 * Attributes to keep. `class` carries marked's `language-*` on code fences and
 * the annotators' `graph-entity` / `doc-ref` hooks; `align` is what gfm tables
 * put on cells; the `data-*` entries are read back by the click/hover handlers
 * in ChatMessages, so they are listed explicitly rather than relying on
 * blanket data-attribute permission (`ALLOW_DATA_ATTR` stays off, so unknown
 * data attributes in model output are dropped).
 */
const ALLOWED_ATTR = [
  'href',
  'src',
  'alt',
  'title',
  'class',
  'align',
  'type',
  'checked',
  'disabled',
  'data-entity-name',
  'data-entity-ids',
  'data-doc-id',
]

/** Escape a value for interpolation into text or a double-quoted attribute. */
export function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Sanitize HTML produced by `marked` before it is assigned to `innerHTML`.
 *
 * Runs client-side only. The chat message list starts empty and is filled by
 * client-side effects (history hydration, live runs), so this never executes
 * during SSR; DOMPurify needs a DOM and its own `sanitize()` is a no-op pass
 * through when unsupported, so any DOM-less environment falls back to escaping
 * the markup into inert text rather than returning it unchanged.
 */
export function sanitizeMarkdownHtml(html: string): string {
  if (typeof window === 'undefined' || !DOMPurify.isSupported) {
    return escapeHtmlAttribute(html)
  }
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
  })
}
