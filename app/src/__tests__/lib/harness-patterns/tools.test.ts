/**
 * Tools Tests
 *
 * Tests for the tools grouping and namespace inference logic.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock server-only imports
vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn()
}))

// Mock MCP client
vi.mock('../../../lib/harness-patterns/mcp-client.server', () => ({
  listTools: vi.fn().mockResolvedValue([])
}))

describe('tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    vi.resetModules()
  })

  describe('ToolsFrom', () => {
    it('should export ToolsFrom function', async () => {
      const { ToolsFrom } = await import('../../../lib/harness-patterns/tools.server')
      expect(ToolsFrom).toBeDefined()
      expect(typeof ToolsFrom).toBe('function')
    })

    it('should group tools by inferred namespace', async () => {
      const { ToolsFrom } = await import('../../../lib/harness-patterns/tools.server')

      const mockTools = [
        { name: 'read_neo4j_cypher', description: 'Read from Neo4j', inputSchema: {} },
        { name: 'write_neo4j_cypher', description: 'Write to Neo4j', inputSchema: {} },
        { name: 'search', description: 'Search the web', inputSchema: {} },
        { name: 'fetch', description: 'Fetch a URL', inputSchema: {} },
      ]

      const tools = ToolsFrom(mockTools)

      expect(tools.neo4j).toContain('read_neo4j_cypher')
      expect(tools.neo4j).toContain('write_neo4j_cypher')
      // search and fetch now map to 'web' via KNOWN_TOOL_SERVERS
      expect(tools.web).toContain('search')
      expect(tools.web).toContain('fetch')
      expect(tools.all).toHaveLength(4)
    })

    it('should return empty all array for no tools', async () => {
      const { ToolsFrom } = await import('../../../lib/harness-patterns/tools.server')

      const tools = ToolsFrom([])

      expect(tools.all).toEqual([])
    })
  })

  describe('inferServer (via ToolsFrom)', () => {
    describe('known tool-server mapping', () => {
      it('should group memory tools under memory namespace', async () => {
        const { ToolsFrom } = await import('../../../lib/harness-patterns/tools.server')

        const tools = ToolsFrom([
          { name: 'create_entities', description: 'Create entities', inputSchema: {} },
          { name: 'create_relations', description: 'Create relations', inputSchema: {} },
          { name: 'add_observations', description: 'Add observations', inputSchema: {} },
          { name: 'delete_entities', description: 'Delete entities', inputSchema: {} },
          { name: 'open_nodes', description: 'Open nodes', inputSchema: {} },
          { name: 'search_nodes', description: 'Search nodes', inputSchema: {} },
          { name: 'read_graph', description: 'Read graph', inputSchema: {} },
        ])

        expect(tools.memory).toHaveLength(7)
        expect(tools.memory).toContain('create_entities')
        expect(tools.memory).toContain('search_nodes')
        expect(tools.memory).toContain('read_graph')
      })

      it('should group web tools under web namespace', async () => {
        const { ToolsFrom } = await import('../../../lib/harness-patterns/tools.server')

        const tools = ToolsFrom([
          { name: 'search', description: 'Search', inputSchema: {} },
          { name: 'fetch', description: 'Fetch', inputSchema: {} },
          { name: 'fetch_content', description: 'Fetch content', inputSchema: {} },
        ])

        expect(tools.web).toHaveLength(3)
        expect(tools.web).toContain('search')
        expect(tools.web).toContain('fetch')
        expect(tools.web).toContain('fetch_content')
      })

      it('should group neo4j tools under neo4j namespace (explicit mapping)', async () => {
        const { ToolsFrom } = await import('../../../lib/harness-patterns/tools.server')

        const tools = ToolsFrom([
          { name: 'read_neo4j_cypher', description: 'Read', inputSchema: {} },
          { name: 'write_neo4j_cypher', description: 'Write', inputSchema: {} },
          { name: 'get_neo4j_schema', description: 'Schema', inputSchema: {} },
        ])

        expect(tools.neo4j).toHaveLength(3)
        expect(tools.neo4j).toContain('read_neo4j_cypher')
        expect(tools.neo4j).toContain('write_neo4j_cypher')
        // get_neo4j_schema is pinned explicitly so a future verb-list edit
        // can't regroup it (it would otherwise rely on the heuristic).
        expect(tools.neo4j).toContain('get_neo4j_schema')
      })

      it('should group github tools under github namespace', async () => {
        const { ToolsFrom } = await import('../../../lib/harness-patterns/tools.server')

        const tools = ToolsFrom([
          { name: 'search_code', description: 'Search code', inputSchema: {} },
          { name: 'search_issues', description: 'Search issues', inputSchema: {} },
          { name: 'get_issue', description: 'Get issue', inputSchema: {} },
          { name: 'list_commits', description: 'List commits', inputSchema: {} },
          { name: 'create_pull_request', description: 'Create PR', inputSchema: {} },
        ])

        expect(tools.github).toHaveLength(5)
        expect(tools.github).toContain('search_code')
        expect(tools.github).toContain('get_issue')
        expect(tools.github).toContain('list_commits')
      })

      it('should group context7 tools under context7 namespace', async () => {
        const { ToolsFrom } = await import('../../../lib/harness-patterns/tools.server')

        const tools = ToolsFrom([
          { name: 'resolve-library-id', description: 'Resolve library', inputSchema: {} },
          { name: 'get-library-docs', description: 'Get docs', inputSchema: {} },
        ])

        expect(tools.context7).toHaveLength(2)
        expect(tools.context7).toContain('resolve-library-id')
        expect(tools.context7).toContain('get-library-docs')
      })

      it('should group redis tools under redis namespace', async () => {
        const { ToolsFrom } = await import('../../../lib/harness-patterns/tools.server')

        const tools = ToolsFrom([
          { name: 'get', description: 'Get key', inputSchema: {} },
          { name: 'set', description: 'Set key', inputSchema: {} },
          { name: 'hget', description: 'Hash get', inputSchema: {} },
          { name: 'json_get', description: 'JSON get', inputSchema: {} },
          { name: 'vector_search_hash', description: 'Vector search', inputSchema: {} },
        ])

        expect(tools.redis).toHaveLength(5)
        expect(tools.redis).toContain('get')
        expect(tools.redis).toContain('hget')
        expect(tools.redis).toContain('vector_search_hash')
      })

      it('should group code-mode under code namespace', async () => {
        const { ToolsFrom } = await import('../../../lib/harness-patterns/tools.server')

        const tools = ToolsFrom([
          { name: 'code-mode', description: 'JS executor', inputSchema: {} },
        ])

        expect(tools.code).toEqual(['code-mode'])
      })

      it('should group filesystem tools under filesystem namespace', async () => {
        const { ToolsFrom } = await import('../../../lib/harness-patterns/tools.server')

        const tools = ToolsFrom([
          { name: 'read_file', description: 'Read file', inputSchema: {} },
          { name: 'write_file', description: 'Write file', inputSchema: {} },
          { name: 'list_directory', description: 'List dir', inputSchema: {} },
          { name: 'search_files', description: 'Search files', inputSchema: {} },
        ])

        expect(tools.filesystem).toHaveLength(4)
        expect(tools.filesystem).toContain('read_file')
        expect(tools.filesystem).toContain('list_directory')
      })
    })

    describe('MCP gateway format (double underscore)', () => {
      it('should handle mcp__server__search → web namespace via known mapping', async () => {
        const { ToolsFrom } = await import('../../../lib/harness-patterns/tools.server')

        const tools = ToolsFrom([
          { name: 'mcp__kg-agent-mcp-gateway__search', description: 'Search', inputSchema: {} }
        ])

        expect(tools.web).toContain('mcp__kg-agent-mcp-gateway__search')
      })

      it('should handle mcp__server__create_entities → memory namespace', async () => {
        const { ToolsFrom } = await import('../../../lib/harness-patterns/tools.server')

        const tools = ToolsFrom([
          { name: 'mcp__kg-agent-mcp-gateway__create_entities', description: 'Create entities', inputSchema: {} }
        ])

        expect(tools.memory).toContain('mcp__kg-agent-mcp-gateway__create_entities')
      })

      it('should handle mcp__server__read_neo4j_cypher → neo4j namespace', async () => {
        const { ToolsFrom } = await import('../../../lib/harness-patterns/tools.server')

        const tools = ToolsFrom([
          { name: 'mcp__kg-agent-mcp-gateway__read_neo4j_cypher', description: 'Read Neo4j', inputSchema: {} }
        ])

        expect(tools.neo4j).toContain('mcp__kg-agent-mcp-gateway__read_neo4j_cypher')
      })

      it('should handle mcp__server__mcp-find → mcp namespace (heuristic)', async () => {
        const { ToolsFrom } = await import('../../../lib/harness-patterns/tools.server')

        const tools = ToolsFrom([
          { name: 'mcp__kg-agent-mcp-gateway__mcp-find', description: 'Find MCP', inputSchema: {} }
        ])

        expect(tools.mcp).toContain('mcp__kg-agent-mcp-gateway__mcp-find')
      })
    })

    describe('heuristic fallback (underscore-separated)', () => {
      it('should handle read_neo4j_cypher → neo4j namespace', async () => {
        const { ToolsFrom } = await import('../../../lib/harness-patterns/tools.server')

        const tools = ToolsFrom([
          { name: 'read_neo4j_cypher', description: 'Read', inputSchema: {} }
        ])

        expect(tools.neo4j).toContain('read_neo4j_cypher')
      })

      it('should handle web_search → web namespace', async () => {
        const { ToolsFrom } = await import('../../../lib/harness-patterns/tools.server')

        const tools = ToolsFrom([
          { name: 'web_search', description: 'Search', inputSchema: {} }
        ])

        expect(tools.web).toContain('web_search')
      })

      it('should handle unknown_tool_name → uses heuristic', async () => {
        const { ToolsFrom } = await import('../../../lib/harness-patterns/tools.server')

        const tools = ToolsFrom([
          { name: 'analyze_data_points', description: 'Analyze', inputSchema: {} }
        ])

        // 'analyze' not in verbs list, so first part is used
        expect(tools.analyze).toContain('analyze_data_points')
      })
    })

    describe('hyphen-separated format', () => {
      it('should handle mcp-find → mcp namespace', async () => {
        const { ToolsFrom } = await import('../../../lib/harness-patterns/tools.server')

        const tools = ToolsFrom([
          { name: 'mcp-find', description: 'Find', inputSchema: {} }
        ])

        expect(tools.mcp).toContain('mcp-find')
      })
    })

    describe('real-world tool combinations', () => {
      it('should correctly group typical MCP gateway tools', async () => {
        const { ToolsFrom } = await import('../../../lib/harness-patterns/tools.server')

        const tools = ToolsFrom([
          { name: 'mcp__kg-agent-mcp-gateway__search', description: 'Search', inputSchema: {} },
          { name: 'mcp__kg-agent-mcp-gateway__fetch', description: 'Fetch', inputSchema: {} },
          { name: 'mcp__kg-agent-mcp-gateway__fetch_content', description: 'Fetch content', inputSchema: {} },
          { name: 'mcp__kg-agent-mcp-gateway__read_neo4j_cypher', description: 'Read Neo4j', inputSchema: {} },
          { name: 'mcp__kg-agent-mcp-gateway__write_neo4j_cypher', description: 'Write Neo4j', inputSchema: {} },
          { name: 'mcp__kg-agent-mcp-gateway__get_neo4j_schema', description: 'Schema', inputSchema: {} },
          { name: 'mcp__kg-agent-mcp-gateway__create_entities', description: 'Create entities', inputSchema: {} },
          { name: 'mcp__kg-agent-mcp-gateway__search_nodes', description: 'Search nodes', inputSchema: {} },
        ])

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

      it('should handle full agent tool set', async () => {
        const { ToolsFrom } = await import('../../../lib/harness-patterns/tools.server')

        const tools = ToolsFrom([
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
          // GitHub
          { name: 'search_code', description: 'Code search', inputSchema: {} },
          { name: 'get_issue', description: 'Get issue', inputSchema: {} },
          // Redis
          { name: 'get', description: 'Get', inputSchema: {} },
          { name: 'set', description: 'Set', inputSchema: {} },
          { name: 'hget', description: 'HGet', inputSchema: {} },
          // Context7
          { name: 'resolve-library-id', description: 'Resolve lib', inputSchema: {} },
          { name: 'get-library-docs', description: 'Get docs', inputSchema: {} },
        ])

        expect(tools.web).toHaveLength(2)
        expect(tools.neo4j).toHaveLength(3)
        expect(tools.memory).toHaveLength(3)
        expect(tools.github).toHaveLength(2)
        expect(tools.redis).toHaveLength(3)
        expect(tools.context7).toHaveLength(2)
        expect(tools.all).toHaveLength(15)
      })
    })
  })
})
