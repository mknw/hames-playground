/**
 * Link-review classification for the chat rendering path (#901 slice 1).
 *
 * The annotate-pass half of the link-verification design
 * (`docs/plan/link-verification.md`, owner rulings of 2026-11-03): every
 * anchor (`a[href]`) in an assistant message is classified, and the unaccepted,
 * unrecognised ones are stamped with code-owned metadata that slices 2 and 3
 * (the review dialog, the indicator and the defang) key on.
 *
 * ## Where the recognised-host decision runs (ruling Q1)
 *
 * SERVER-SIDE, never here. `GRAPH_DOCUMENT_HOSTS` stays on the server
 * (`harness-client/document-hosts.server.ts`); what crosses to the browser is
 * the verdict — `Message.recognisedLinkHosts`, the recognised hostnames among
 * THIS message's own links, computed where the content is served (the live
 * `done` frame, history load, the shared transcript). An anchor this module
 * cannot prove recognised is UNVERIFIED — fail-closed, so a missing or partial
 * verdict can only add a review, never remove one.
 *
 * The app's own origin is the one clause decided here, client-side: the page's
 * own origin is not a secret from the page, and the serving boundaries do not
 * uniformly know the public origin (proxy hosts, ports) the way the browser
 * itself does. The comparison is exact origin equality.
 *
 * ## The seam, and what each output is for
 *
 * Each anchor's `href` attribute is handed to `interpretUrlSpans`
 * (`@hames-ai/harness-patterns/url-seam`, the documented INTERNAL subpath —
 * ruling Q4; the root barrel re-exports `.server.ts` modules) as one
 * whole-value span. The two seam outputs map to two different jobs:
 *
 *  - the span's `raw` — the anchor's own spelling of its address — is the
 *    DEFANG IDENTITY (ruling Q5: slice 3 replaces the anchor in the current
 *    rendering only), and is stamped verbatim. Never a canonical rewrite.
 *  - the parsed URL (canonical `href`, hostname) is the DESTINATION: what the
 *    review dialog displays, what acceptance keys on, and what the recognised
 *    decision reads. Only `http:`/`https:` anchors participate — a link that is
 *    not a web address gets neither indicator nor dialog (approved Q9).
 *
 * A base-relative spelling the base-less parse rejects is resolved against
 * the page's own URL before that decision — judged as the browser resolves
 * it, not as the string it looks like — so a protocol-relative host cannot
 * escape the stamp by its spelling.
 *
 * ## The trust model (SA-M10)
 *
 * This runs as part of the sanitizer's `annotate` pass: on the inert DOM, AFTER
 * DOMPurify and BEFORE the image pass, which keeps the last word. DOMPurify
 * drops every `data-*` attribute (`ALLOW_DATA_ATTR: false`), so the
 * `data-link-*` values below can only be set by this code — a forged
 * `data-link-*` in model output cannot produce an interactive link-review
 * element. Model output cannot carry these attributes past sanitization, the
 * same guarantee the citation annotators rely on.
 */
import { interpretUrlSpans } from '@hames-ai/harness-patterns/url-seam'

/**
 * The recognised hostnames among one message's own http(s) links, as computed
 * by the serving boundary (`harness-client/link-verdicts.server.ts`).
 * Hostnames are the lower-cased canonical form the URL parser produces, so
 * both sides of the comparison agree on spelling. Absent/undefined = nothing
 * is recognised: every http(s) link is unverified.
 */
export type RecognisedLinkHosts = readonly string[]

/** The annotate pass's verdict, stamped as code-owned metadata per anchor. */
const REVIEW_MARKER = 'data-link-review'
const RAW_ATTRIBUTE = 'data-link-raw'
const DEST_ATTRIBUTE = 'data-link-dest'

/** `new URL(href, window.location.href)` — the page-resolved form — or `null`
 *  when even that is not a URL the platform parser accepts (the browser could
 *  not navigate it either). */
function resolveAsTheBrowserWould(href: string): URL | null {
  try {
    return new URL(href, window.location.href)
  } catch {
    return null
  }
}

/**
 * Classify every anchor in the inert, already-sanitized `root` and stamp the
 * unverified ones. Returns the per-message unverified count — the indicator's
 * number (slice 3), delivered as a parallel return value rather than by
 * re-parsing rendered HTML, which the sanitizer forbids.
 *
 * Recognised anchors and non-http(s) anchors are left untouched — no metadata,
 * not counted. The image pass still runs after this and keeps the last word:
 * a blocked image's placeholder is inert text and is never counted.
 */
export function annotateLinkVerdicts(root: Element, recognisedHosts?: RecognisedLinkHosts): number {
  const hosts = new Set(recognisedHosts ?? [])
  let unverified = 0
  for (const anchor of Array.from(root.querySelectorAll('a[href]'))) {
    const href = anchor.getAttribute('href') as string
    // One whole-value span per anchor: the href attribute, handed to the seam.
    const span = interpretUrlSpans(href, [{ start: 0, end: href.length }]).spans[0]
    // Classify the href AS THE BROWSER RESOLVES IT: the seam parses with no
    // base, so a base-relative spelling — a protocol-relative `//host/path`
    // above all — comes back `url: null` and would escape classification
    // entirely while still rendering as a live cross-origin anchor. Resolving
    // against the page's own URL is the same discipline `isAllowedImageSource`
    // documents (sanitize-html.ts): judged as what they would fetch, not as
    // the string they look like. For an absolute href the base changes nothing.
    const url = span?.url ?? resolveAsTheBrowserWould(href)
    // Not an address even page-resolved — the browser could not navigate it
    // either, so there is nothing to classify.
    if (!url) continue
    // http/https only — a link that is not a web address gets neither
    // indicator nor dialog metadata.
    if (url.protocol !== 'http:' && url.protocol !== 'https:') continue
    const recognised = hosts.has(url.hostname) || url.origin === window.location.origin
    if (recognised) continue
    anchor.setAttribute(REVIEW_MARKER, 'unverified')
    anchor.setAttribute(RAW_ATTRIBUTE, span?.raw ?? href)
    anchor.setAttribute(DEST_ATTRIBUTE, url.href)
    unverified++
  }
  return unverified
}
