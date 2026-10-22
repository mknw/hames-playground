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
 * Memory reads never reach this: they are exempt from the screen (ruling L).
 */
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

let warned = false

/** Logged once, at boot, by the composition root that hands {@link homeDomains}
 *  to the Graph tools. An empty list is a safe default, so it warns rather than
 *  refuses: every sender is external, and the screen and its gate run on all of
 *  them. */
export function warnWhenNoHomeDomains(log: (message: string) => void = console.warn): void {
  if (warned || homeDomains().length > 0) return
  warned = true
  log(
    '[ingress] HOME_EMAIL_DOMAINS is empty: every Microsoft 365 sender, organiser and ' +
      'sharer counts as external, so the injection screen and its gate run on all of ' +
      'their content. Set it to the deployment’s own email domains.',
  )
}

/** Test-only: forget that the warning was logged. */
export function __resetHomeDomainsWarning(): void {
  warned = false
}

/** The host classifier. Reads code-written provenance only; anything it cannot
 *  place is external. */
export const classifyIngress: IngressClassifier = ({ namespace, data }) => {
  if (namespace === 'neo4j') return 'internal'
  if (namespace === 'graph') return graphProvenance(data) === 'home' ? 'internal' : 'external'
  return 'external'
}
