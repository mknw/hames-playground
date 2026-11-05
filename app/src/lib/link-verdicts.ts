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
    // Not an address the platform parser accepts (relative hrefs land here).
    if (!span?.url) continue
    // http/https only — a link that is not a web address gets neither
    // indicator nor dialog metadata.
    if (span.url.protocol !== 'http:' && span.url.protocol !== 'https:') continue
    const recognised = hosts.has(span.url.hostname) || span.url.origin === window.location.origin
    if (recognised) continue
    anchor.setAttribute(REVIEW_MARKER, 'unverified')
    anchor.setAttribute(RAW_ATTRIBUTE, span.raw)
    anchor.setAttribute(DEST_ATTRIBUTE, span.url.href)
    unverified++
  }
  return unverified
}
