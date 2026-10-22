/**
 * Which tool results the injection screen gates in (boundary guards, ruling O):
 * content from external senders and other unsafe sources, never the deployment's
 * own. `general-next`'s office and info guards take {@link classifyIngress} as
 * their screen's `classify`, through `AgentDeps.classifyIngress`.
 *
 * The rule, by namespace, declared here in code:
 *
 *   - `neo4j` is internal: the deployment's own graph.
 *   - `graph` (Microsoft 365) is internal only when the connector stamped the
 *     result home: every identity it carries (a message's sender, an event's
 *     organiser, a sharer) is an address on a {@link homeDomains} domain. The
 *     stamp is computed from the raw Graph response before shaping, never from
 *     the shaped display name a sender sets, and a result with no stamp (every
 *     file listing today) is external.
 *   - everything else is external: `web`, `context7`, the sandbox's tools (in
 *     the office route a file's contents reach the model only through them,
 *     whoever sent it), and any namespace this rule does not know.
 *
 * Internal content still gets the deterministic pass, and a deterministic
 * finding on it still forces the screen (the guard's rule, not this module's).
 * Memory reads reach this as a namespace the rule does not know, so they are
 * external and screened: `general-next`'s exemption for them (ruling L) waits
 * for the owner's attestation of the memory store.
 */
import { domainToASCII } from 'node:url'
import type { IngressClassifier } from '@hames-ai/harness-patterns/injection-guard'
import { graphProvenance } from '@hames-ai/connectors/graph/graph-tools.server'

/**
 * The deployment's home email domains, from `HOME_EMAIL_DOMAINS` (comma-separated),
 * read on every call and never written in the tree (the company domain is
 * deliberately absent from this public repository). An address is home when its
 * domain is one of these or a subdomain of one, compared lower-cased and
 * IDNA-normalised (the connector's `isHomeAddress`). Empty: every sender is
 * external.
 */
export function homeDomains(): readonly string[] {
  return (process.env.HOME_EMAIL_DOMAINS ?? '')
    .split(',')
    .map((domain) => domain.trim())
    .filter((domain) => domain.length > 0)
}

/** Suffixes many organisations share, and public mail providers: as a home
 *  domain, each makes every address under it internal. A short fixed list,
 *  warned about rather than refused, since a deployment may own a name under one. */
const SHARED_SUFFIXES: ReadonlySet<string> = new Set([
  'co.uk',
  'com.au',
  'onmicrosoft.com',
  'gmail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'yahoo.com',
  'icloud.com',
])

/** A normalised domain an address can match: dot-separated labels of letters,
 *  digits and hyphens, none empty. */
const USABLE_DOMAIN = /^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/

let checked = false

/**
 * Run once, at boot, by the composition root that hands {@link homeDomains} to
 * the Graph tools. It REFUSES (throws) an entry with fewer than two labels after
 * normalisation: `com` would make every `.com` sender internal through the
 * subdomain rule. It warns, naming the entry, on one that normalises to no
 * domain or one an address can never match (`@contoso.com`, `https://…`,
 * `*.contoso.com`), and on a shared suffix or public mail provider. When no entry
 * is usable it warns that every sender is external: a safe default, so a
 * warning rather than a refusal, but one somebody should be told about.
 */
export function checkHomeDomains(log: (message: string) => void = console.warn): void {
  if (checked) return
  checked = true
  let usable = 0
  for (const entry of homeDomains()) {
    const domain = domainToASCII(entry)
    if (domain !== '' && domain.split('.').filter(Boolean).length < 2) {
      throw new Error(
        `[ingress] HOME_EMAIL_DOMAINS entry ${JSON.stringify(entry)} has fewer than two ` +
          'labels: every address under it would count as internal and skip the injection ' +
          'screen. Name the deployment’s own domains.',
      )
    }
    if (!USABLE_DOMAIN.test(domain)) {
      log(
        `[ingress] HOME_EMAIL_DOMAINS entry ${JSON.stringify(entry)} is not a domain an ` +
          'address can match, so it is ignored. Write a bare domain such as contoso.com.',
      )
      continue
    }
    if (SHARED_SUFFIXES.has(domain)) {
      log(
        `[ingress] HOME_EMAIL_DOMAINS entry ${JSON.stringify(entry)} is a shared suffix or a ` +
          'public mail provider: every address under it counts as internal and skips the ' +
          'injection screen.',
      )
    }
    usable++
  }
  if (usable > 0) return
  log(
    '[ingress] HOME_EMAIL_DOMAINS names no usable domain: every Microsoft 365 sender, ' +
      'organiser and sharer counts as external, so the injection screen and its gate run ' +
      'on all of their content. Set it to the deployment’s own email domains.',
  )
}

/** Test-only: forget that the check ran. */
export function __resetHomeDomainsCheck(): void {
  checked = false
}

/** The host classifier. Reads code-written provenance only; anything it cannot
 *  place is external. */
export const classifyIngress: IngressClassifier = ({ namespace, data }) => {
  if (namespace === 'neo4j') return 'internal'
  if (namespace === 'graph') return graphProvenance(data) === 'home' ? 'internal' : 'external'
  return 'external'
}
