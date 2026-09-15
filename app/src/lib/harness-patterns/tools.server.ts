/**
 * Tools Wrapper
 *
 * Groups MCP tools by server/namespace for convenient access.
 *
 * ## Where the namespace of a tool name comes from
 *
 * `inferServer` consults three phases, in this order and no other:
 *
 *   1. **Registered transports' `namespaceFor`** — a process transport may
 *      declare its own grouping (today: the app-side tools, whose `graph_*`
 *      names would mis-bucket under any name heuristic).
 *   2. **Registered namespace resolvers** — `registerToolNamespaces()`, the
 *      deployment's explicit catalog. The app registers one at boot, from
 *      `app-tools/mcp-catalog.ts`; core carries no catalog of its own, because
 *      which tool names exist is a property of the deployment, not of the
 *      library (#225 L5).
 *   3. **The heuristic** — verb-prefix stripping and separator splitting. It
 *      stays in core deliberately: it is deployment-independent and is what
 *      makes `Tools()` useful before any registration lands.
 *
 * There is no fourth phase. A name nothing declares and no heuristic can split
 * groups under itself, which is exactly what the guard's construction-time
 * warning (SD-5) exists to surface.
 */

import { assertServerOnImport } from './assert.server'
import { listTools as mcpListTools } from './mcp-client.server'
import { processTransports } from './tool-transport.server'
import { gatewayDegradation, markDegradedToolSurface } from './gateway-health.server'
import type { ToolSet, MCPToolDescription } from './types'

assertServerOnImport()

/** Maps a tool name to its namespace, or undefined when it does not know. */
export type NamespaceResolver = (toolName: string) => string | undefined

/** Options for `Tools()` / `ToolsFrom()`. */
export interface ToolsOptions {
  /**
   * The deployment's explicit tool→namespace map, REQUIRED per owner ruling
   * B-iii: `Tools()` with no map is how `tools.web` disappears silently on the
   * day a catalog moves, so the map is an argument, not an option. The
   * registration (`registerToolNamespaces`) is the default the GUARD sees;
   * this argument is what the grouping sees. Pre-1.0, strict→lenient later is
   * free; lenient→strict is breaking — which is why it starts strict.
   */
  namespaces: NamespaceResolver
}

/** The deployment's registered namespace resolvers, consulted in registration
 *  order before the heuristic. Process-level, like the transport registry. */
const namespaceResolvers: NamespaceResolver[] = []

/**
 * Register a deployment's tool→namespace catalog, consulted by `inferServer`
 * BEFORE the heuristic — and therefore by both `Tools()`'s grouping and
 * `withInjectionGuard`'s `isUntrusted`, which share this one resolver.
 * Process-level, one value per deployment, set by the app at boot beside its
 * tool registration. Returns an unregister handle (tests, HMR).
 */
export function registerToolNamespaces(resolver: NamespaceResolver): () => void {
  namespaceResolvers.push(resolver)
  let unregistered = false
  return () => {
    if (unregistered) return
    unregistered = true
    const at = namespaceResolvers.indexOf(resolver)
    if (at >= 0) namespaceResolvers.splice(at, 1)
  }
}

/**
 * Create a ToolSet from MCP tools.
 * Groups tools by inferred server name.
 *
 * @param options - REQUIRED (ruling B-iii): the deployment's tool→namespace
 *   map. See `ToolsOptions`.
 * @example
 * const tools = await Tools({ namespaces: mcpNamespace })
 * tools.neo4j  // ['read_neo4j_cypher', 'write_neo4j_cypher', 'get_neo4j_schema']
 * tools.web    // ['search', 'fetch']
 * tools.all    // all tool names
 */
export async function Tools(options: ToolsOptions): Promise<ToolSet> {
  const mcpTools = await mcpListTools()
  return groupTools(mcpTools, options)
}

/**
 * Create a ToolSet from an existing list of tool descriptions.
 *
 * `options` is optional here (unlike `Tools`) because this entry point exists
 * for callers that already hold a tool list in hand — tests, and the guard
 * inventory — and the heuristic alone is a valid grouping for them. The
 * production path always goes through `Tools()`, which requires the map.
 */
export function ToolsFrom(mcpTools: MCPToolDescription[], options?: ToolsOptions): ToolSet {
  return groupTools(mcpTools, options)
}

function groupTools(mcpTools: MCPToolDescription[], options?: ToolsOptions): ToolSet {
  const grouped: Record<string, string[]> = {}

  for (const t of mcpTools) {
    const server = options?.namespaces(t.name) ?? inferServer(t.name)
    grouped[server] ??= []
    grouped[server].push(t.name)
  }

  const all = mcpTools.map((t) => t.name)

  // Provenance for the outage guard (#278 F1). `all` means "every tool this app
  // can reach", and the gateway is part of that surface whether or not it
  // answered — so an `all` built during an outage is an AMPUTATED whole surface,
  // not a small one. The pattern that receives it cannot tell: `listTools`
  // degrades to the app-side tools, and those are byte-identical to the list
  // `microsoft-365` composes on purpose. Recording it here is the only place
  // both facts are in hand at once — which catalog read this came from, and
  // whether that read reached the gateway.
  //
  // Only `all` is marked, and that is sufficient rather than a shortcut: a
  // gateway namespace has no key at all under an outage (`grouped` only gets a
  // key for a namespace some tool landed in), so `tools.neo4j ?? []` reaches
  // the guard as an empty array and the empty half of the check already holds
  // it. Marking the surviving app-side namespaces instead would refuse
  // `tools.graph` for an outage that costs it nothing.
  if (gatewayDegradation()) markDegradedToolSurface(all)

  return { ...grouped, all } as ToolSet
}

// ============================================================================
// Server Inference
// ============================================================================

/**
 * Infer server name from tool name.
 *
 * 1. Strip MCP gateway prefix (mcp__gateway__toolName → toolName)
 * 2. Registered transports' `namespaceFor` (today: the app-side transport)
 * 3. Registered namespace resolvers (`registerToolNamespaces` — the catalog)
 * 4. Fall back to heuristic (verb prefix stripping, underscore/hyphen split)
 */
export function inferServer(toolName: string): string {
  // Handle MCP gateway format: mcp__server-name__tool_name → infer from tool_name part
  if (toolName.includes('__')) {
    const parts = toolName.split('__')
    const actualToolName = parts[parts.length - 1]
    return inferServer(actualToolName)
  }

  // A process transport may declare its own grouping (today: the app-side
  // tools, whose `graph_*` names would mis-bucket under the name heuristic).
  for (const transport of processTransports()) {
    const declared = transport.namespaceFor?.(toolName)
    if (declared !== undefined) return declared
  }

  // The deployment's registered catalog, consulted before the heuristic.
  for (const resolve of namespaceResolvers) {
    const declared = resolve(toolName)
    if (declared !== undefined) return declared
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
