/**
 * The MCP gateway tool→namespace catalog — THIS DEPLOYMENT'S data.
 *
 * Moved here from core (`harness-patterns/tools.server.ts`, where it lived as
 * `KNOWN_TOOL_SERVERS`) by Lane B2 (#225 L5): which tool names exist behind the
 * gateway is a property of this deployment's `configs/mcp-config.yaml`, not of
 * the library, so the catalog lives in `app-tools/` beside the rest of the
 * app's own tooling (docs/plan/harness-npm-lib.md §"stays in app/"). Core keeps
 * only the consultation ORDER and the deployment-independent heuristic.
 *
 * It is registered ONCE, at the same boot point as the app-tool transport:
 * `app-tools/index.server.ts` (imported by `src/middleware.ts`) calls
 * `registerToolNamespaces(mcpNamespace)`, so `inferServer` — and therefore both
 * `Tools()`'s grouping and `withInjectionGuard`'s `isUntrusted` — see this map
 * without any call site passing it. The `Tools({ namespaces })` argument
 * (REQUIRED, owner ruling B-iii) is the same map passed explicitly.
 *
 * For a package consumer, the registration is not advisory: since #242 item 4
 * the guard REFUSES a declared namespace it cannot verify, and the refusal
 * names this registration. Skipping it is a build-time error, not a silent
 * pass-through.
 *
 * 86 distinct names across 6 namespaces. The app-side per-user tools are NOT
 * here — they declare their own namespaces (`registry.server.ts`), which ride
 * `inferServer` through the app transport's `namespaceFor`.
 */

/** Explicit mapping of tool names to server groups. Covers tools whose names
 *  don't encode the server identity (memory, context7, redis, filesystem, web)
 *  and pins names the heuristic already gets right (neo4j) so a future edit to
 *  the heuristic's verb list can't silently regroup them. */
const MCP_TOOL_CATALOG: Record<string, string> = {}

// Memory Knowledge Graph server
for (const t of [
  'create_entities',
  'create_relations',
  'add_observations',
  'delete_entities',
  'delete_relations',
  'delete_observations',
  'open_nodes',
  'search_nodes',
  'read_graph',
])
  MCP_TOOL_CATALOG[t] = 'memory'

// Neo4j Cypher server. These already resolve to 'neo4j' via the verb-strip
// heuristic in core (read_/write_/get_ → parts[1]), but pin them explicitly so
// a future edit to the `verbs` list can't silently regroup them.
for (const t of ['read_neo4j_cypher', 'write_neo4j_cypher', 'get_neo4j_schema'])
  MCP_TOOL_CATALOG[t] = 'neo4j'

// Context7 documentation server
for (const t of ['resolve-library-id', 'get-library-docs']) MCP_TOOL_CATALOG[t] = 'context7'

// Web search / fetch server
for (const t of ['search', 'fetch', 'fetch_content']) MCP_TOOL_CATALOG[t] = 'web'

// Redis server
for (const t of [
  'get',
  'set',
  'delete',
  'expire',
  'rename',
  'type',
  'dbsize',
  'info',
  'hget',
  'hset',
  'hdel',
  'hexists',
  'hgetall',
  'lpush',
  'rpush',
  'lpop',
  'rpop',
  'lrange',
  'llen',
  'sadd',
  'srem',
  'smembers',
  'zadd',
  'zrange',
  'zrem',
  'json_get',
  'json_set',
  'json_del',
  'xadd',
  'xdel',
  'xrange',
  'publish',
  'subscribe',
  'unsubscribe',
  'scan_keys',
  'scan_all_keys',
  'search_redis_documents',
  'create_vector_index_hash',
  'set_vector_in_hash',
  'get_vector_from_hash',
  'vector_search_hash',
  'get_indexed_keys_number',
  'get_indexes',
  'get_index_info',
])
  MCP_TOOL_CATALOG[t] = 'redis'

// Filesystem server
for (const t of [
  'read_file',
  'write_file',
  'edit_file',
  'create_directory',
  'list_directory',
  'list_directory_with_sizes',
  'directory_tree',
  'move_file',
  'search_files',
  'search_files_content',
  'get_file_info',
  'read_file_lines',
  'head_file',
  'tail_file',
  'read_text_file',
  'read_multiple_text_files',
  'read_media_file',
  'read_multiple_media_files',
  'find_duplicate_files',
  'find_empty_directories',
  'calculate_directory_size',
  'list_allowed_directories',
  'zip_directory',
  'zip_files',
  'unzip_file',
])
  MCP_TOOL_CATALOG[t] = 'filesystem'

/** The catalog, for introspection (the app-side namespace test reads it). */
export { MCP_TOOL_CATALOG }

/**
 * The catalog as a `NamespaceResolver` — the value this module hands to
 * `registerToolNamespaces()` and to every `Tools({ namespaces })` call site.
 * Undefined for names it does not know, so the caller's chain falls through.
 */
export function mcpNamespace(toolName: string): string | undefined {
  return MCP_TOOL_CATALOG[toolName]
}
