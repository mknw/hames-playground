/**
 * The server half of the link-review classification (#901 slice 1, ruling Q1):
 * SERVER-COMPUTED per-link verdicts.
 *
 * `GRAPH_DOCUMENT_HOSTS` is a validated, exact, server-only list of the
 * tenant's own document hosts (`document-hosts.server.ts`), and the ruling is
 * that it never reaches the browser, the page bundle, or a shared transcript's
 * HTML. So the comparison against it runs HERE — on the server, at every
 * boundary where assistant message content is served (the live `done` frame in
 * `routes/api/events.ts`, history load in `actions.server.ts#loadConversation`,
 * and the shared transcript in `shared-conversation.server.ts`) — and only the
 * VERDICT crosses: the recognised hostnames among that message's own links.
 * The invariant is substring-hood, not anchor text: every hostname in the
 * verdict is a substring of the message's own `content` — the markdown source
 * and the rendered href alike — so the verdict adds no identifier `content`
 * does not already carry, and `content` crosses on every serving path. A
 * hostname the verdict does not name is unverified on the client, fail-closed.
 *
 * Computing at the content-serving boundaries rather than through a
 * classify-anything endpoint is what keeps this oracle-free: a caller can
 * only learn about links in content a conversation's read path already
 * entitled them to — there is no way to submit an address of one's choosing.
 *
 * The scan is the URL-interpretation seam's own egress lexical rule
 * (`egressArgumentSpans`): every http(s) address in the message text, each
 * scheme occurrence starting one candidate. The scan sees a superset of the
 * anchors the browser will render (bare-text addresses included); the extra
 * verdicts are simply unused client-side, and an anchor whose hostname the
 * scan somehow missed is unverified, never trusted. Matching on the hostname
 * — not the whole address — is what makes the two sides agree: hostnames
 * survive the entity decoding and destination rewrites that make a raw
 * markdown spelling and a rendered attribute value differ.
 *
 * The app's own origin is deliberately NOT decided here: the serving
 * boundaries do not uniformly know the public origin, while the browser
 * always does — the client-side half (`lib/link-verdicts.ts`) compares the
 * anchor's origin to the page's own.
 */
import { documentHosts } from './document-hosts.server'
import { egressArgumentSpans, interpretUrlSpans } from '@hames-ai/harness-patterns/url-seam'

/**
 * The recognised hostnames among every http(s) address in `content`, in first
 * appearance order, deduplicated. Hostnames are the lower-cased canonical form
 * the URL parser produces; recognition is by EXACT host equality against
 * `GRAPH_DOCUMENT_HOSTS` — a subdomain of a listed host is not that host.
 *
 * Empty list (the default for the env var), or content with no recognised
 * addresses: `[]`, and the client treats every http(s) link as unverified.
 */
export function recognisedLinkHostsFor(content: string): readonly string[] {
  const recognised: string[] = []
  if (!content) return recognised
  const hosts = documentHosts()
  if (hosts.length === 0) return recognised
  const seen = new Set<string>()
  for (const span of interpretUrlSpans(content, egressArgumentSpans(content)).spans) {
    if (!span.url) continue
    if (span.url.protocol !== 'http:' && span.url.protocol !== 'https:') continue
    const hostname = span.url.hostname
    if (seen.has(hostname)) continue
    if (hosts.includes(hostname)) {
      seen.add(hostname)
      recognised.push(hostname)
    }
  }
  return recognised
}
