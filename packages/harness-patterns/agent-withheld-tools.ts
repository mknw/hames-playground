/**
 * The tools withheld from every agent, and the one predicate that asks.
 *
 * Its own module, with no imports, for two reasons: the catalog
 * (`mcp-client.server.ts`) and the loops (`patterns/simpleLoop.server.ts`,
 * `patterns/actorCritic.server.ts`) all read it, and tests that stub the MCP
 * client must not stub this along with it — a stubbed predicate would make
 * every loop's refusal untested.
 *
 * Placement is an open follow-up, due before the next release: the review of
 * #434 recommends moving the
 * NAMES into the host's catalog (`@hames-ai/connectors/mcp-catalog.ts`) and
 * registering them at boot, beside `registerToolNamespaces`, with this
 * mechanism staying in core.
 */

/**
 * Catalog-server tools no agent may hold, whatever the gateway lists and
 * whatever a loop's allowlist names.
 *
 * Owner decision, 2026-10-03 (#403, #206): agents are READ-ONLY against Neo4j,
 * the `general` agent included. The one writer is the memory hook (#419), and
 * it writes through the app, not through an agent's tool list.
 *
 * Enforced in two places, both through {@link isAgentWithheldTool}:
 *   - the CATALOG: `listTools` drops these names, so `Tools()`, every
 *     `tools.*` list, the planner's catalog and the controllers' catalog never
 *     carry them;
 *   - every LOOP's allowlist check (`simpleLoop`, `actorCritic`, singular and
 *     batched calls alike) refuses them, so a hand-written allowlist, a
 *     `dynamicToolAllowlist` or a `dynamicToolPattern` cannot hand one back.
 * Deliberately NOT `callTool`: this decides what an agent may call, not what
 * the app may, and the hook's write path is the app's.
 *
 * A list, not a single name, so another surface agents must not hold is one
 * entry here rather than a second mechanism.
 *
 * The deployment withholds the tool at the server as well: `read_only: true`
 * for `neo4j-cypher` in `configs/mcp-config.yaml`, under which the pinned
 * `mcp-neo4j-cypher` 0.5.0 does not list it. This list is the second layer,
 * the same shape as the gateway management-tool list in `mcp-client.server.ts`:
 * it holds when a host's config says `false`, or when a server bump changes how
 * the key is read.
 */
export const AGENT_WITHHELD_TOOLS: ReadonlySet<string> = new Set(['write_neo4j_cypher'])

/**
 * Is `name` one of {@link AGENT_WITHHELD_TOOLS}? The one predicate the catalog
 * and every loop's allowlist check ask.
 *
 * Two prefixes must not hand a tool back, so both are seen through:
 *   - the gateway's `mcp__<server>__<tool>`, split as `inferServer` splits it;
 *   - a server's own namespace, `<namespace>-<tool>`: `mcp-neo4j-cypher`
 *     registers its tools that way when `NEO4J_NAMESPACE` is set, which is the
 *     shape a second, namespaced Neo4j server would arrive in.
 */
export function isAgentWithheldTool(name: string): boolean {
  const at = name.lastIndexOf('__')
  const bare = at >= 0 ? name.slice(at + 2) : name
  if (AGENT_WITHHELD_TOOLS.has(bare)) return true
  for (const withheld of AGENT_WITHHELD_TOOLS) {
    if (bare.endsWith(`-${withheld}`)) return true
  }
  return false
}
