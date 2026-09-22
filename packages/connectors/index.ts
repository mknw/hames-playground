/**
 * @hames-ai/connectors — the connectors companion (#225 PR-3).
 *
 * Microsoft Graph app-side tools, the Neo4j non-agentic layer, and the
 * MCP-gateway namespace catalog — moved out of the host app behind injected
 * seams so a consumer supplies identity, tokens, content classification and
 * storage while this package owns the protocols and the query shapes.
 *
 * ## What the root barrel carries (and what it deliberately does not)
 *
 * The root is the CLIENT-SAFE surface: the namespace catalog (pure data) and
 * the Neo4j→Cytoscape transform (pure functions, type-only cytoscape import).
 * Everything else is server-only and reached through its subpath, resolved by
 * the `./*` wildcard export:
 *
 *   - `@hames-ai/connectors/neo4j` and `@hames-ai/connectors/neo4j/client` — the
 *     explicit-config driver factory (`configureNeo4j`, no env fallback);
 *   - `@hames-ai/connectors/neo4j/queries` / `neo4j/graph-edit.server` — the
 *     identity-free ops the host's `'use server'` wrappers gate and delegate
 *     to;
 *   - `@hames-ai/connectors/app-tools/registry` — the generic in-process tool
 *     registry (`createAppToolRegistry`);
 *   - `@hames-ai/connectors/graph/graph-tools.server` —
 *     `registerGraphConnectorTools(deps)` and its REQUIRED supplier bag.
 *
 * The app that hosted these modules composes them in its
 * `app-tools/index.server.ts` composition root (which stays host-side): it
 * builds the registry with its own identity resolver, hands the Graph tools
 * their `graphFetch` / content / stash suppliers, and registers the transport
 * on core's seam.
 */

export { mcpNamespace, MCP_TOOL_CATALOG } from './mcp-catalog'
export {
  transformNeo4jToCytoscape,
  parseNeo4jResults,
  type Neo4jNode,
  type Neo4jRelationship,
  type Neo4jQueryResult,
} from './neo4j/transform'
