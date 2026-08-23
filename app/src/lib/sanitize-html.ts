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
 * Attributes to keep. `align` is what gfm tables put on cells; `class` is kept
 * as a tag, but its *value* is filtered — see {@link CLASS_ALLOWLIST}.
 *
 * The interactive hooks (`data-entity-name`, `data-entity-ids`, `data-doc-id`)
 * are deliberately **absent** (SA-M10). They used to be allowlisted here, which
 * meant model output containing
 * `<span class="doc-ref" data-doc-id="…">` survived sanitization and rendered
 * as a real, clickable citation pointing wherever the model chose — a
 * provenance spoof, in the one part of the UI whose entire job is to say where
 * an answer came from. The annotators in `ChatMessages` run *after* this
 * function and emit those attributes themselves, so nothing genuine is lost:
 * every surviving citation is now one this code put there.
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
]

/**
 * Class values the chat renderer is allowed to carry through sanitization.
 *
 * `class` cannot simply be dropped — `marked` puts `language-*` on code fences
 * and the gfm task-list item class on `li` — but an unfiltered `class` is how a
 * forged `doc-ref` / `graph-entity` span passes for a real one. So the
 * attribute survives and the *value* is reduced to this allowlist: a
 * `language-*` prefix, plus the two task-list classes marked emits. Every
 * interactive class the chat responds to is added by the annotators after this
 * runs, and can therefore never come from model text.
 */
const CLASS_ALLOWLIST = new Set(['task-list-item', 'contains-task-list'])

/** Keep only allowlisted class tokens; drop the attribute when none survive. */
function filterClassAttribute(node: Element): void {
  const raw = node.getAttribute('class')
  if (raw === null) return
  const kept = raw
    .split(/\s+/)
    .filter((token) => token.startsWith('language-') || CLASS_ALLOWLIST.has(token))
  if (kept.length === 0) node.removeAttribute('class')
  else node.setAttribute('class', kept.join(' '))
}

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
  // `afterSanitizeAttributes` runs per node, after DOMPurify has applied
  // ALLOWED_ATTR. Registered and removed around the single call rather than at
  // module load, so this hook only ever sees this function's nodes.
  DOMPurify.addHook('afterSanitizeAttributes', filterClassAttribute)
  try {
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOW_DATA_ATTR: false,
    })
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes')
  }
}
