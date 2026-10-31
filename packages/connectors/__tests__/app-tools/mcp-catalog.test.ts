/**
 * The MCP-gateway namespace catalog — the DATA half (#225 L5 / PR-C2).
 *
 * The catalog moved here from core, and these cases moved with it:
 * they assert THIS DEPLOYMENT's 5 namespaces and the grouping the catalog
 * produces when handed to `ToolsFrom`. The COMPOSITION half — the catalog
 * registered on core's resolver seam by the host's composition root, and the
 * app transport's namespaceFor answering ahead of it — stayed in the host's
 * test tree, which is what registers it.
 */

import { describe, it, expect } from 'vitest'
import { mcpNamespace, MCP_TOOL_CATALOG } from '../../mcp-catalog'
import { ToolsFrom, registerToolNamespaces } from '@hames-ai/harness-patterns/tools.server'

// The catalog registered on core's resolver seam — the same registration the
// HOST's composition root performs at boot. `inferServer` (and therefore
// ToolsFrom's grouping, including the MCP-prefix strip) consults the REGISTERED
// resolvers, so without this the catalog data alone groups nothing. Mirrors the
// host's own `src/__tests__/mocks/namespace-catalog.ts` helper.
registerToolNamespaces(mcpNamespace)

describe('the MCP namespace catalog', () => {
  it('holds 79 distinct names across 5 namespaces', async () => {
    const names = Object.keys(MCP_TOOL_CATALOG)
    expect(names.length).toBe(79)
    expect(new Set(names).size).toBe(79)
    expect(new Set(Object.values(MCP_TOOL_CATALOG))).toEqual(
      new Set(['neo4j', 'context7', 'web', 'redis', 'filesystem']),
    )
  })

  // The shared memory graph was retired; its tools name no namespace. Written
  // out, so re-adding one to the catalog turns this red.
  it.each([
    'create_entities',
    'create_relations',
    'add_observations',
    'delete_entities',
    'delete_relations',
    'delete_observations',
    'open_nodes',
    'search_nodes',
    'read_graph',
  ])('does not catalogue the retired memory-graph tool %s', (name) => {
    expect(MCP_TOOL_CATALOG).not.toHaveProperty(name)
    expect(mcpNamespace(name)).toBeUndefined()
  })
})

describe('ToolsFrom with the catalog (the moved grouping cases)', () => {
  async function load() {
    return { mcpNamespace, ToolsFrom }
  }

  it('groups web tools under web namespace', async () => {
    const { mcpNamespace, ToolsFrom } = await load()

    const tools = ToolsFrom(
      [
        { name: 'search', description: 'Search', inputSchema: {} },
        { name: 'fetch', description: 'Fetch', inputSchema: {} },
        { name: 'fetch_content', description: 'Fetch content', inputSchema: {} },
        { name: 'web_search_exa', description: 'Exa search', inputSchema: {} },
        { name: 'web_fetch_exa', description: 'Exa fetch', inputSchema: {} },
      ],
      { namespaces: mcpNamespace },
    )

    expect(tools.web).toHaveLength(5)
    expect(tools.web).toContain('search')
    expect(tools.web).toContain('fetch')
    expect(tools.web).toContain('fetch_content')
    expect(tools.web).toContain('web_search_exa')
    expect(tools.web).toContain('web_fetch_exa')
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
        { name: 'mcp__hames-mcp-gateway__search', description: 'Search', inputSchema: {} },
        {
          name: 'mcp__hames-mcp-gateway__read_neo4j_cypher',
          description: 'Read Neo4j',
          inputSchema: {},
        },
      ],
      { namespaces: mcpNamespace },
    )

    expect(tools.web).toContain('mcp__hames-mcp-gateway__search')
    expect(tools.neo4j).toContain('mcp__hames-mcp-gateway__read_neo4j_cypher')
  })

  it('correctly groups the full typical gateway tool set', async () => {
    const { mcpNamespace, ToolsFrom } = await load()

    const tools = ToolsFrom(
      [
        { name: 'mcp__hames-mcp-gateway__search', description: 'Search', inputSchema: {} },
        { name: 'mcp__hames-mcp-gateway__fetch', description: 'Fetch', inputSchema: {} },
        {
          name: 'mcp__hames-mcp-gateway__fetch_content',
          description: 'Fetch content',
          inputSchema: {},
        },
        {
          name: 'mcp__hames-mcp-gateway__read_neo4j_cypher',
          description: 'Read Neo4j',
          inputSchema: {},
        },
        {
          name: 'mcp__hames-mcp-gateway__write_neo4j_cypher',
          description: 'Write Neo4j',
          inputSchema: {},
        },
        {
          name: 'mcp__hames-mcp-gateway__get_neo4j_schema',
          description: 'Schema',
          inputSchema: {},
        },
      ],
      { namespaces: mcpNamespace },
    )

    // Web tools grouped under 'web'
    expect(tools.web).toHaveLength(3)
    expect(tools.web).toContain('mcp__hames-mcp-gateway__search')
    expect(tools.web).toContain('mcp__hames-mcp-gateway__fetch')
    expect(tools.web).toContain('mcp__hames-mcp-gateway__fetch_content')

    // Neo4j tools grouped under 'neo4j'
    expect(tools.neo4j).toHaveLength(3)
    expect(tools.neo4j).toContain('mcp__hames-mcp-gateway__read_neo4j_cypher')
    expect(tools.neo4j).toContain('mcp__hames-mcp-gateway__write_neo4j_cypher')
    expect(tools.neo4j).toContain('mcp__hames-mcp-gateway__get_neo4j_schema')

    // Should NOT have scattered groups
    expect(tools.mcp).toBeUndefined()

    expect(tools.all).toHaveLength(6)
  })

  it('groups the full agent tool set across all five namespaces', async () => {
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
    expect(tools.filesystem).toHaveLength(2)
    expect(tools.redis).toHaveLength(3)
    expect(tools.context7).toHaveLength(2)
    expect(tools.all).toHaveLength(12)
  })
})
