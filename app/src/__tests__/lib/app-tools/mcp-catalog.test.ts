/**
 * The MCP-gateway namespace catalog — APP-side half of the tools test split
 * (#225 L5, Lane B2).
 *
 * The 86-entry catalog moved here from core (`harness-patterns/tools.server.ts`,
 * where it lived as `KNOWN_TOOL_SERVERS`), and these cases moved with it: they
 * assert THIS DEPLOYMENT's 6 namespaces, which only hold once
 * `app-tools/index.server.ts` has registered `mcpNamespace` on core's resolver
 * seam. What stayed in core is the heuristic's own cases plus the degradation
 * provenance — `__tests__/lib/harness-patterns/tools.test.ts`, which
 * deliberately registers no catalog, so the split itself pins that the catalog
 * left core: every case here would fail there, and every case there passes
 * without this module.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const mockCallTool = vi.fn()
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: class {
    connect = vi.fn().mockResolvedValue(undefined)
    close = vi.fn().mockResolvedValue(undefined)
    callTool = mockCallTool
    listTools = vi.fn().mockResolvedValue({ tools: [] })
  },
}))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}))

describe('the MCP namespace catalog', () => {
  it('holds 86 distinct names across 6 namespaces', async () => {
    const { MCP_TOOL_CATALOG } = await import('../../../lib/app-tools/mcp-catalog')
    const names = Object.keys(MCP_TOOL_CATALOG)
    expect(names.length).toBe(86)
    expect(new Set(names).size).toBe(86)
    expect(new Set(Object.values(MCP_TOOL_CATALOG))).toEqual(
      new Set(['memory', 'neo4j', 'context7', 'web', 'redis', 'filesystem']),
    )
  })

  it('is registered by importing the barrel, and inferServer routes through it', async () => {
    await import('../../../lib/app-tools/index.server')
    const { inferServer } = await import('../../../lib/harness-patterns/tools.server')

    // 'search' is a single word — the heuristic alone would say 'search'.
    // Only the registered catalog makes it 'web'.
    expect(inferServer('search')).toBe('web')
    expect(inferServer('vector_search_hash')).toBe('redis')
    expect(inferServer('mcp__kg-agent-mcp-gateway__search')).toBe('web')
  })

  it('the app tools keep their own grouping, ahead of the catalog', async () => {
    await import('../../../lib/app-tools/index.server')
    const { inferServer } = await import('../../../lib/harness-patterns/tools.server')

    // `list_graph_messages` would mis-bucket under any name heuristic; the app
    // transport's `namespaceFor` (the retired `appToolNamespace` special case)
    // answers before the catalog and the heuristic are consulted.
    expect(inferServer('graph_me')).toBe('graph')
    expect(inferServer('list_graph_messages')).toBe('graph')
  })
})

describe('ToolsFrom with the catalog (the moved grouping cases)', () => {
  async function load() {
    await import('../../../lib/app-tools/index.server')
    const { mcpNamespace } = await import('../../../lib/app-tools/mcp-catalog')
    const { ToolsFrom } = await import('../../../lib/harness-patterns/tools.server')
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
