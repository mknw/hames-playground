/**
 * The tenant's own SharePoint/OneDrive hosts (#784 item 6), from
 * `GRAPH_DOCUMENT_HOSTS` (comma-separated), read on every call and never written
 * in the tree (the tenant's name is deliberately absent from this public
 * repository). `general-next` and `microsoft-365` hand them to their Graph
 * guard's `sourceLinks`: a Graph result's `webUrl` on one of them is exempt from
 * `exfil-data-url`, and from no other rule.
 *
 * Matching is by exact hostname, so an entry names a host, never a pattern:
 * `contoso.sharepoint.com` does not cover `contoso-my.sharepoint.com` (list both)
 * or `evil.contoso.sharepoint.com`. Empty (the default): no link is exempt, and
 * the rule flags them as before.
 */

/** A lower-cased bare hostname: two or more dot-separated labels of letters,
 *  digits and hyphens, none empty. No scheme, port, path or wildcard. */
const HOSTNAME = /^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/

/**
 * Every entry of `GRAPH_DOCUMENT_HOSTS`, lower-cased. REFUSES (throws) an entry
 * that is not a bare hostname — `*.sharepoint.com`, `https://…`, a path — since
 * the operator who wrote it expected it to match something it never will. Boot
 * calls it once (`middleware.ts`) so a bad value refuses boot rather than a turn.
 */
export function documentHosts(): readonly string[] {
  const hosts = (process.env.GRAPH_DOCUMENT_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter((host) => host.length > 0)
  for (const host of hosts) {
    if (!HOSTNAME.test(host)) {
      throw new Error(
        `[guards] GRAPH_DOCUMENT_HOSTS entry ${JSON.stringify(host)} is not a bare hostname. ` +
          'Write each host exactly, such as contoso.sharepoint.com,contoso-my.sharepoint.com.',
      )
    }
  }
  return hosts
}
