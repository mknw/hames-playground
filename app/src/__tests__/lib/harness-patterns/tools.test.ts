/**
 * Tools Tests — CORE's half of the split (#225 L5, Lane B2).
 *
 * The 86-entry catalog moved to `app-tools/mcp-catalog.ts` (which deployment's
 * tool names exist is the app's fact, not the library's), and the cases that
 * asserted this deployment's 6 namespaces moved with it — they now live in
 * `__tests__/lib/app-tools/mcp-catalog.test.ts`, beside the data they test.
 * What stays here is what the design note keeps in core: the heuristic's own
 * cases, the resolver-registry behaviour (`registerToolNamespaces`), and the
 * degradation provenance. A catalog registration in THIS file would make the
 * split decorative, so there is none.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock server-only imports
vi.mock('../../../../../packages/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

// Mock MCP client
vi.mock('../../../../../packages/harness-patterns/mcp-client.server', () => ({
  listTools: vi.fn().mockResolvedValue([]),
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
      const { ToolsFrom } = await import('../../../../../packages/harness-patterns/tools.server')
      expect(ToolsFrom).toBeDefined()
      expect(typeof ToolsFrom).toBe('function')
    })

    it('should group tools by inferred namespace', async () => {
      const { ToolsFrom } = await import('../../../../../packages/harness-patterns/tools.server')

      const mockTools = [
        { name: 'read_neo4j_cypher', description: 'Read from Neo4j', inputSchema: {} },
        { name: 'write_neo4j_cypher', description: 'Write to Neo4j', inputSchema: {} },
        { name: 'web_search', description: 'Search the web', inputSchema: {} },
      ]

      const tools = ToolsFrom(mockTools)

      // Heuristic-resolvable names only: the core tests register no catalog,
      // so every name here must resolve through the heuristic alone.
      expect(tools.neo4j).toContain('read_neo4j_cypher')
      expect(tools.neo4j).toContain('write_neo4j_cypher')
      expect(tools.web).toContain('web_search')
      expect(tools.all).toHaveLength(3)
    })

    it('should return empty all array for no tools', async () => {
      const { ToolsFrom } = await import('../../../../../packages/harness-patterns/tools.server')

      const tools = ToolsFrom([])

      expect(tools.all).toEqual([])
    })
  })

  describe('the registered namespace resolver', () => {
    it('is consulted by inferServer before the heuristic, and unregisters', async () => {
      const mod = await import('../../../../../packages/harness-patterns/tools.server')

      // Without registration, the heuristic alone answers.
      expect(mod.inferServer('search')).toBe('search')

      const off = mod.registerToolNamespaces((name) => (name === 'search' ? 'web' : undefined))
      expect(mod.inferServer('search')).toBe('web')

      off()
      expect(mod.inferServer('search')).toBe('search')
    })

    it('never consults the heuristic when a resolver claims the name', async () => {
      const mod = await import('../../../../../packages/harness-patterns/tools.server')
      const off = mod.registerToolNamespaces((name) =>
        name === 'read_neo4j_cypher' ? 'graph-db' : undefined,
      )
      // The heuristic would say 'neo4j'; the resolver wins.
      expect(mod.inferServer('read_neo4j_cypher')).toBe('graph-db')
      off()
    })

    it('is idempotent to unregister, like the transport registry', async () => {
      const mod = await import('../../../../../packages/harness-patterns/tools.server')
      const off = mod.registerToolNamespaces(() => undefined)
      off()
      off()
      expect(mod.inferServer('anything')).toBe('anything')
    })
  })

  describe('inferServer (via ToolsFrom)', () => {
    describe('heuristic (the deployment-independent core)', () => {
      it('groups an unknown hyphenated tool under its first segment', async () => {
        const { ToolsFrom } = await import('../../../../../packages/harness-patterns/tools.server')

        const tools = ToolsFrom([
          { name: 'mcp-exec', description: 'gateway meta-tool', inputSchema: {} },
        ])

        expect(tools.mcp).toEqual(['mcp-exec'])
      })

      // #226 E3: the GitHub server and its catalog block are gone, so these
      // names fall through to the heuristic. Asserted rather than deleted:
      // re-adding a `github` namespace should be a deliberate act.
      it('has no github namespace — those names fall through to the heuristic', async () => {
        const { ToolsFrom } = await import('../../../../../packages/harness-patterns/tools.server')

        const tools = ToolsFrom([
          { name: 'search_code', description: 'Search code', inputSchema: {} },
          { name: 'get_issue', description: 'Get issue', inputSchema: {} },
        ])

        expect(tools.github).toBeUndefined()
        expect(tools.code).toContain('search_code')
        expect(tools.issue).toContain('get_issue')
      })

      it('should handle read_neo4j_cypher → neo4j namespace', async () => {
        const { ToolsFrom } = await import('../../../../../packages/harness-patterns/tools.server')

        const tools = ToolsFrom([
          { name: 'read_neo4j_cypher', description: 'Read', inputSchema: {} },
        ])

        expect(tools.neo4j).toContain('read_neo4j_cypher')
      })

      it('should handle web_search → web namespace', async () => {
        const { ToolsFrom } = await import('../../../../../packages/harness-patterns/tools.server')

        const tools = ToolsFrom([{ name: 'web_search', description: 'Search', inputSchema: {} }])

        expect(tools.web).toContain('web_search')
      })

      it('should handle unknown_tool_name → uses heuristic', async () => {
        const { ToolsFrom } = await import('../../../../../packages/harness-patterns/tools.server')

        const tools = ToolsFrom([
          { name: 'analyze_data_points', description: 'Analyze', inputSchema: {} },
        ])

        // 'analyze' not in verbs list, so first part is used
        expect(tools.analyze).toContain('analyze_data_points')
      })
    })

    describe('MCP gateway format (double underscore)', () => {
      it('strips the prefix and runs the heuristic on the tool name', async () => {
        const { ToolsFrom } = await import('../../../../../packages/harness-patterns/tools.server')

        // `mcp-find` is not in any catalog the core tests register, so this is
        // the heuristic end to end: split → 'mcp'. The catalog-routed members
        // of this family live app-side, with the catalog.
        const tools = ToolsFrom([
          { name: 'mcp__kg-agent-mcp-gateway__mcp-find', description: 'Find MCP', inputSchema: {} },
        ])

        expect(tools.mcp).toContain('mcp__kg-agent-mcp-gateway__mcp-find')
      })
    })

    describe('provenance for the outage guard (#278 F1)', () => {
      /**
       * `all` means "every tool this app can reach", and the gateway is part of
       * that surface whether or not it answered. Grouping is therefore the one
       * place that knows an `all` is AMPUTATED rather than small — the pattern
       * that receives it only sees names, and the app-side survivors are
       * byte-identical to the list `microsoft-365` composes on purpose.
       */
      it('marks `all` as degraded when the catalog read did not reach the gateway', async () => {
        const health =
          await import('../../../../../packages/harness-patterns/gateway-health.server')
        const { ToolsFrom } = await import('../../../../../packages/harness-patterns/tools.server')
        health.__resetGatewayHealth()
        health.markGatewayUnreachable('ECONNREFUSED 127.0.0.1:8811')

        // What `listTools` returns on its failure path: the app-side survivors.
        const tools = ToolsFrom([{ name: 'graph_me', description: 'Me', inputSchema: {} }])

        expect(health.isDegradedToolSurface(tools.all)).toBe(true)
        expect(health.toolSurfaceOutage(tools.all)).not.toBeNull()
      })

      it('leaves `all` unmarked while the gateway is answering', async () => {
        const health =
          await import('../../../../../packages/harness-patterns/gateway-health.server')
        const { ToolsFrom } = await import('../../../../../packages/harness-patterns/tools.server')
        health.__resetGatewayHealth()

        const tools = ToolsFrom([
          { name: 'read_neo4j_cypher', description: 'Read', inputSchema: {} },
          { name: 'graph_me', description: 'Me', inputSchema: {} },
        ])

        expect(health.isDegradedToolSurface(tools.all)).toBe(false)
      })

      it('does not mark a per-namespace list, so an app-side agent is untouched', async () => {
        // `microsoft-365` reads `tools.graph`. Marking the surviving namespaces
        // would refuse it for an outage it does not depend on; a GATEWAY
        // namespace has no key at all under an outage, so `tools.neo4j ?? []`
        // still reaches the guard as the empty array it already handles.
        const health =
          await import('../../../../../packages/harness-patterns/gateway-health.server')
        const { ToolsFrom } = await import('../../../../../packages/harness-patterns/tools.server')
        health.__resetGatewayHealth()
        health.markGatewayUnreachable('ECONNREFUSED 127.0.0.1:8811')

        const tools = ToolsFrom([{ name: 'graph_me', description: 'Me', inputSchema: {} }])

        expect(health.isDegradedToolSurface(tools.graph)).toBe(false)
        expect(health.toolSurfaceOutage(tools.graph)).toBeNull()
        expect(tools.neo4j).toBeUndefined()
        expect(health.toolSurfaceOutage(tools.neo4j ?? [])).not.toBeNull()
      })
    })
  })
})
