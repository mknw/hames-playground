/**
 * Tools Wrapper
 *
 * Groups MCP tools by server/namespace for convenient access.
 */

import { assertServerOnImport } from './assert.server'
import { listTools as mcpListTools } from './mcp-client.server'
import { appToolNamespace } from '../app-tools/index.server'
import type { ToolSet, MCPToolDescription } from './types'

assertServerOnImport()

/**
 * Create a ToolSet from MCP tools.
 * Groups tools by inferred server name.
 *
 * @example
 * const tools = await Tools()
 * tools.neo4j  // ['read_neo4j_cypher', 'write_neo4j_cypher', 'get_neo4j_schema']
 * tools.web    // ['search', 'fetch']
 * tools.all    // all tool names
 */
export async function Tools(): Promise<ToolSet> {
  const mcpTools = await mcpListTools()
  return groupTools(mcpTools)
}

/**
 * Create a ToolSet from an existing list of tool descriptions.
 */
export function ToolsFrom(mcpTools: MCPToolDescription[]): ToolSet {
  return groupTools(mcpTools)
}

function groupTools(mcpTools: MCPToolDescription[]): ToolSet {
  const grouped: Record<string, string[]> = {}

  for (const t of mcpTools) {
    const server = inferServer(t.name)
    grouped[server] ??= []
    grouped[server].push(t.name)
  }

  const all = mcpTools.map((t) => t.name)

  return { ...grouped, all } as ToolSet
}

// ============================================================================
// Known Tool-to-Server Mapping
// ============================================================================

/**
 * Explicit mapping of tool names to server groups.
 * Checked before the heuristic. Covers tools whose names don't encode
 * the server identity (memory, context7, redis, github, filesystem, web).
 */
const KNOWN_TOOL_SERVERS: Record<string, string> = {}

// Memory Knowledge Graph server
for (const t of [
  'create_entities', 'create_relations', 'add_observations',
  'delete_entities', 'delete_relations', 'delete_observations',
  'open_nodes', 'search_nodes', 'read_graph',
]) KNOWN_TOOL_SERVERS[t] = 'memory'

// Neo4j Cypher server. These already resolve to 'neo4j' via the verb-strip
// heuristic below (read_/write_/get_ → parts[1]), but pin them explicitly so
// a future edit to the `verbs` list can't silently regroup them.
for (const t of ['read_neo4j_cypher', 'write_neo4j_cypher', 'get_neo4j_schema'])
  KNOWN_TOOL_SERVERS[t] = 'neo4j'

// Context7 documentation server
for (const t of ['resolve-library-id', 'get-library-docs'])
  KNOWN_TOOL_SERVERS[t] = 'context7'

// Code-mode JS execution tool (kg-agent gateway built-in)
KNOWN_TOOL_SERVERS['code-mode'] = 'code'

// Web search / fetch server
for (const t of ['search', 'fetch', 'fetch_content'])
  KNOWN_TOOL_SERVERS[t] = 'web'

// Redis server
for (const t of [
  'get', 'set', 'delete', 'expire', 'rename', 'type', 'dbsize', 'info',
  'hget', 'hset', 'hdel', 'hexists', 'hgetall',
  'lpush', 'rpush', 'lpop', 'rpop', 'lrange', 'llen',
  'sadd', 'srem', 'smembers',
  'zadd', 'zrange', 'zrem',
  'json_get', 'json_set', 'json_del',
  'xadd', 'xdel', 'xrange',
  'publish', 'subscribe', 'unsubscribe',
  'scan_keys', 'scan_all_keys',
  'search_redis_documents',
  'create_vector_index_hash', 'set_vector_in_hash',
  'get_vector_from_hash', 'vector_search_hash',
  'get_indexed_keys_number', 'get_indexes', 'get_index_info',
]) KNOWN_TOOL_SERVERS[t] = 'redis'

// GitHub server
for (const t of [
  'search_code', 'search_issues', 'search_repositories', 'search_users',
  'get_issue', 'list_issues', 'create_issue', 'update_issue', 'add_issue_comment',
  'get_file_contents', 'create_or_update_file', 'push_files',
  'get_pull_request', 'list_pull_requests', 'create_pull_request',
  'merge_pull_request', 'get_pull_request_files', 'get_pull_request_comments',
  'get_pull_request_reviews', 'get_pull_request_status',
  'create_pull_request_review', 'update_pull_request_branch',
  'list_commits', 'create_branch', 'create_repository', 'fork_repository',
]) KNOWN_TOOL_SERVERS[t] = 'github'

// Filesystem server
for (const t of [
  'read_file', 'write_file', 'edit_file', 'create_directory',
  'list_directory', 'list_directory_with_sizes', 'directory_tree',
  'move_file', 'search_files', 'search_files_content',
  'get_file_info', 'read_file_lines', 'head_file', 'tail_file',
  'read_text_file', 'read_multiple_text_files',
  'read_media_file', 'read_multiple_media_files',
  'find_duplicate_files', 'find_empty_directories',
  'calculate_directory_size', 'list_allowed_directories',
  'zip_directory', 'zip_files', 'unzip_file',
]) KNOWN_TOOL_SERVERS[t] = 'filesystem'

// ============================================================================
// Server Inference
// ============================================================================

/**
 * Infer server name from tool name.
 *
 * 1. Strip MCP gateway prefix (mcp__gateway__toolName → toolName)
 * 2. App-side tools declare their own namespace (#110)
 * 3. Check KNOWN_TOOL_SERVERS lookup
 * 4. Fall back to heuristic (verb prefix stripping, underscore/hyphen split)
 */
export function inferServer(toolName: string): string {
  // Handle MCP gateway format: mcp__server-name__tool_name → infer from tool_name part
  if (toolName.includes('__')) {
    const parts = toolName.split('__')
    const actualToolName = parts[parts.length - 1]
    return inferServer(actualToolName)
  }

  // App-side tools carry an explicit namespace, so grouping never depends on
  // the name heuristic (which would mis-bucket e.g. `list_graph_messages`).
  const appNs = appToolNamespace(toolName)
  if (appNs) {
    return appNs
  }

  // Check known mapping first
  if (KNOWN_TOOL_SERVERS[toolName]) {
    return KNOWN_TOOL_SERVERS[toolName]
  }

  // Heuristic: underscore-separated with verb prefix → strip verb
  if (toolName.includes('_')) {
    const parts = toolName.split('_')
    const verbs = ['read', 'write', 'get', 'list', 'create', 'delete', 'update', 'search']
    if (verbs.includes(parts[0]) && parts.length >= 2) {
      return parts[1]
    }
    return parts[0]
  }

  // Heuristic: hyphen-separated → first segment
  if (toolName.includes('-')) {
    return toolName.split('-')[0]
  }

  // Single word
  return toolName
}
