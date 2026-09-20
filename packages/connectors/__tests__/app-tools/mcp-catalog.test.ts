/**
 * The MCP-gateway namespace catalog — the DATA half (#225 L5 / PR-C2).
 *
 * The 86-entry catalog moved here from core, and these cases moved with it:
 * they assert THIS DEPLOYMENT's 6 namespaces and the grouping the catalog
 * produces when handed to `ToolsFrom`. The COMPOSITION half — the catalog
 * registered on core's resolver seam by the host's composition root, and the
 * app transport's namespaceFor answering ahead of it — stayed in the host's
 * test tree, which is what registers it.
 */

import { describe, it, expect } from 'vitest'
import { mcpNamespace, MCP_TOOL_CATALOG } from '../../mcp-catalog'
import { ToolsFrom, registerToolNamespaces } from '@hames/harness-patterns/tools.server'

// The catalog registered on core's resolver seam — the same registration the
// HOST's composition root performs at boot. `inferServer` (and therefore
// ToolsFrom's grouping, including the MCP-prefix strip) consults the REGISTERED
// resolvers, so without this the catalog data alone groups nothing. Mirrors the
// host's own `src/__tests__/mocks/namespace-catalog.ts` helper.
registerToolNamespaces(mcpNamespace)

describe('the MCP namespace catalog', () => {
  it('holds 86 distinct names across 6 namespaces', async () => {
    const catalog = MCP_TOOL_CATALOG
    const names = Object.keys(MCP_TOOL_CATALOG)
    expect(names.length).toBe(86)
    expect(new Set(names).size).toBe(86)
    expect(new Set(Object.values(MCP_TOOL_CATALOG))).toEqual(
      new Set(['memory', 'neo4j', 'context7', 'web', 'redis', 'filesystem']),
    )
  })
})

describe('ToolsFrom with the catalog (the moved grouping cases)', () => {
  async function load() {
    return { mcpNamespace, ToolsFrom }
  }

  it('groups memory tools under memory namespace', async () => {
    const { mcpNamespace, ToolsFrom } = await load()

    const tools = ToolsFrom(
      [
        { name: 'create_entities', description: 'Create entities', inputSchema: {} },
        { name: 'create_relations', description: 'Create relations', inputSchema: {} },
        { name: 'add_observations', description: 'Add observations', inputSchema: {} },
        { name: 'delete_entities', description: 'Delete entities', inputSchema: {} },
        { name: 'open_nodes', description: 'Open nodes', inputSchema: {} },
        { name: 'search_nodes', description: 'Search nodes', inputSchema: {} },
        { name: 'read_graph', description: 'Read graph', inputSchema: {} },
      ],
      { namespaces: mcpNamespace },
    )

    expect(tools.memory).toHaveLength(7)
    expect(tools.memory).toContain('create_entities')
    expect(tools.memory).toContain('search_nodes')
    expect(tools.memory).toContain('read_graph')
  })

  it('groups web tools under web namespace', async () => {
    const { mcpNamespace, ToolsFrom } = await load()

    const tools = ToolsFrom(
      [
        { name: 'search', description: 'Search', inputSchema: {} },
        { name: 'fetch', description: 'Fetch', inputSchema: {} },
        { name: 'fetch_content', description: 'Fetch content', inputSchema: {} },
      ],
      { namespaces: mcpNamespace },
    )

    expect(tools.web).toHaveLength(3)
    expect(tools.web).toContain('search')
    expect(tools.web).toContain('fetch')
    expect(tools.web).toContain('fetch_content')
  })

  it('groups neo4j tools under neo4j namespace (explicit mapping)', async () => {
    const { mcpNamespace, ToolsFrom } = await load()

    const tools = ToolsFrom(
      [
        { name: 'read_neo4j_cypher', description: 'Read', inputSchema: {} },
        { name: 'write_neo4j_cypher', description: 'Write', inputSchema: {} },
        { name: 'get_neo4j_schema', description: 'Schema', inputSchema: {} },
      ],
      { namespaces: mcpNamespace },
    )

    expect(tools.neo4j).toHaveLength(3)
    expect(tools.neo4j).toContain('read_neo4j_cypher')
    expect(tools.neo4j).toContain('write_neo4j_cypher')
    // get_neo4j_schema is pinned explicitly so a future verb-list edit
    // can't regroup it (it would otherwise rely on the heuristic).
    expect(tools.neo4j).toContain('get_neo4j_schema')
  })

  it('groups context7 tools under context7 namespace', async () => {
    const { mcpNamespace, ToolsFrom } = await load()

    const tools = ToolsFrom(
      [
        { name: 'resolve-library-id', description: 'Resolve library', inputSchema: {} },
        { name: 'get-library-docs', description: 'Get docs', inputSchema: {} },
      ],
      { namespaces: mcpNamespace },
    )

    expect(tools.context7).toHaveLength(2)
    expect(tools.context7).toContain('resolve-library-id')
    expect(tools.context7).toContain('get-library-docs')
  })

  it('groups redis tools under redis namespace', async () => {
    const { mcpNamespace, ToolsFrom } = await load()

    const tools = ToolsFrom(
      [
        { name: 'get', description: 'Get key', inputSchema: {} },
        { name: 'set', description: 'Set key', inputSchema: {} },
        { name: 'hget', description: 'Hash get', inputSchema: {} },
        { name: 'json_get', description: 'JSON get', inputSchema: {} },
        { name: 'vector_search_hash', description: 'Vector search', inputSchema: {} },
      ],
      { namespaces: mcpNamespace },
    )

    expect(tools.redis).toHaveLength(5)
    expect(tools.redis).toContain('get')
    expect(tools.redis).toContain('hget')
    expect(tools.redis).toContain('vector_search_hash')
  })

  it('groups filesystem tools under filesystem namespace', async () => {
    const { mcpNamespace, ToolsFrom } = await load()

    const tools = ToolsFrom(
      [
        { name: 'read_file', description: 'Read file', inputSchema: {} },
        { name: 'write_file', description: 'Write file', inputSchema: {} },
        { name: 'list_directory', description: 'List dir', inputSchema: {} },
        { name: 'search_files', description: 'Search files', inputSchema: {} },
      ],
      { namespaces: mcpNamespace },
    )

    expect(tools.filesystem).toHaveLength(4)
    expect(tools.filesystem).toContain('read_file')
    expect(tools.filesystem).toContain('list_directory')
  })

  it('routes MCP-prefixed names through the catalog after the prefix strip', async () => {
    const { mcpNamespace, ToolsFrom } = await load()

    const tools = ToolsFrom(
      [
        { name: 'mcp__kg-agent-mcp-gateway__search', description: 'Search', inputSchema: {} },
        {
          name: 'mcp__kg-agent-mcp-gateway__create_entities',
          description: 'Create entities',
          inputSchema: {},
        },
        {
          name: 'mcp__kg-agent-mcp-gateway__read_neo4j_cypher',
          description: 'Read Neo4j',
          inputSchema: {},
        },
      ],
      { namespaces: mcpNamespace },
    )

    expect(tools.web).toContain('mcp__kg-agent-mcp-gateway__search')
    expect(tools.memory).toContain('mcp__kg-agent-mcp-gateway__create_entities')
    expect(tools.neo4j).toContain('mcp__kg-agent-mcp-gateway__read_neo4j_cypher')
  })

  it('correctly groups the full typical gateway tool set', async () => {
    const { mcpNamespace, ToolsFrom } = await load()

    const tools = ToolsFrom(
      [
        { name: 'mcp__kg-agent-mcp-gateway__search', description: 'Search', inputSchema: {} },
        { name: 'mcp__kg-agent-mcp-gateway__fetch', description: 'Fetch', inputSchema: {} },
        {
          name: 'mcp__kg-agent-mcp-gateway__fetch_content',
          description: 'Fetch content',
          inputSchema: {},
        },
        {
          name: 'mcp__kg-agent-mcp-gateway__read_neo4j_cypher',
          description: 'Read Neo4j',
          inputSchema: {},
        },
        {
          name: 'mcp__kg-agent-mcp-gateway__write_neo4j_cypher',
          description: 'Write Neo4j',
          inputSchema: {},
        },
        {
          name: 'mcp__kg-agent-mcp-gateway__get_neo4j_schema',
          description: 'Schema',
          inputSchema: {},
        },
        {
          name: 'mcp__kg-agent-mcp-gateway__create_entities',
          description: 'Create entities',
          inputSchema: {},
        },
        {
          name: 'mcp__kg-agent-mcp-gateway__search_nodes',
          description: 'Search nodes',
          inputSchema: {},
        },
      ],
      { namespaces: mcpNamespace },
    )

    // Web tools grouped under 'web'
    expect(tools.web).toHaveLength(3)
    expect(tools.web).toContain('mcp__kg-agent-mcp-gateway__search')
    expect(tools.web).toContain('mcp__kg-agent-mcp-gateway__fetch')
    expect(tools.web).toContain('mcp__kg-agent-mcp-gateway__fetch_content')

    // Neo4j tools grouped under 'neo4j'
    expect(tools.neo4j).toHaveLength(3)
    expect(tools.neo4j).toContain('mcp__kg-agent-mcp-gateway__read_neo4j_cypher')
    expect(tools.neo4j).toContain('mcp__kg-agent-mcp-gateway__write_neo4j_cypher')
    expect(tools.neo4j).toContain('mcp__kg-agent-mcp-gateway__get_neo4j_schema')

    // Memory tools grouped under 'memory'
    expect(tools.memory).toHaveLength(2)
    expect(tools.memory).toContain('mcp__kg-agent-mcp-gateway__create_entities')
    expect(tools.memory).toContain('mcp__kg-agent-mcp-gateway__search_nodes')

    // Should NOT have scattered groups
    expect(tools.mcp).toBeUndefined()

    expect(tools.all).toHaveLength(8)
  })

  it('groups the full agent tool set across all six namespaces', async () => {
    const { mcpNamespace, ToolsFrom } = await load()

    const tools = ToolsFrom(
      [
        // Web
        { name: 'search', description: 'Search', inputSchema: {} },
        { name: 'fetch', description: 'Fetch', inputSchema: {} },
        // Neo4j
        { name: 'read_neo4j_cypher', description: 'Read', inputSchema: {} },
        { name: 'write_neo4j_cypher', description: 'Write', inputSchema: {} },
        { name: 'get_neo4j_schema', description: 'Schema', inputSchema: {} },
        // Memory
        { name: 'create_entities', description: 'Create', inputSchema: {} },
        { name: 'create_relations', description: 'Relations', inputSchema: {} },
        { name: 'read_graph', description: 'Read graph', inputSchema: {} },
        // Filesystem
        { name: 'read_file', description: 'Read file', inputSchema: {} },
        { name: 'write_file', description: 'Write file', inputSchema: {} },
        // Redis
        { name: 'get', description: 'Get', inputSchema: {} },
        { name: 'set', description: 'Set', inputSchema: {} },
        { name: 'hget', description: 'HGet', inputSchema: {} },
        // Context7
        { name: 'resolve-library-id', description: 'Resolve lib', inputSchema: {} },
        { name: 'get-library-docs', description: 'Get docs', inputSchema: {} },
      ],
      { namespaces: mcpNamespace },
    )

    expect(tools.web).toHaveLength(2)
    expect(tools.neo4j).toHaveLength(3)
    expect(tools.memory).toHaveLength(3)
    expect(tools.filesystem).toHaveLength(2)
    expect(tools.redis).toHaveLength(3)
    expect(tools.context7).toHaveLength(2)
    expect(tools.all).toHaveLength(15)
  })
})
