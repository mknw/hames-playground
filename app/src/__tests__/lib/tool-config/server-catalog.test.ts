/**
 * server-catalog tests
 *
 * Verifies the catalog maps live gateway tools onto their REAL server names
 * (the keys in configs/custom-catalog.yaml — neo4j-cypher, web_search, …),
 * not the client-side inferServer namespaces (neo4j, web). listTools is
 * mocked; the catalog/enabled YAMLs are read from the real committed configs.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

// Mock the whole mcp-client module so its MCP-SDK transitive imports don't
// load, and so getServerCatalog sees a deterministic live-tool universe.
vi.mock('../../../lib/harness-patterns/mcp-client.server', () => ({
  listTools: vi.fn(async () => [
    { name: 'read_neo4j_cypher', description: '', inputSchema: {} },
    { name: 'write_neo4j_cypher', description: '', inputSchema: {} },
    { name: 'get_neo4j_schema', description: '', inputSchema: {} },
    { name: 'search', description: '', inputSchema: {} },
    { name: 'fetch_content', description: '', inputSchema: {} },
    { name: 'fetch', description: '', inputSchema: {} },
    { name: 'create_entities', description: '', inputSchema: {} },
  ]),
}))

describe('server-catalog', () => {
  it('maps live tools onto real gateway server names', async () => {
    const { getServerCatalog } = await import(
      '../../../lib/tool-config/server-catalog.server'
    )
    const cat = await getServerCatalog()
    const byKey = Object.fromEntries(cat.map((s) => [s.key, s]))

    // Real server name is `neo4j-cypher`, NOT the `neo4j` namespace.
    expect(byKey['neo4j-cypher']).toBeDefined()
    expect(byKey['neo4j-cypher'].enabled).toBe(true)
    expect(byKey['neo4j-cypher'].secretGated).toBe(true) // declares a password secret
    expect(byKey['neo4j-cypher'].tools.map((t) => t.name)).toContain('read_neo4j_cypher')

    // web_search declares no tools in the catalog → bridged from the `web`
    // namespace (search / fetch_content), distinct from the `fetch` server.
    expect(byKey['web_search']).toBeDefined()
    expect(byKey['web_search'].tools.map((t) => t.name)).toContain('search')
    expect(byKey['fetch']?.tools.map((t) => t.name)).toContain('fetch')

    // No client-namespace key leaked through (would mean a tool went unmapped).
    expect(byKey['neo4j']).toBeUndefined()
    expect(byKey['web']).toBeUndefined()
  })

  it('getPresetTools expands the preset servers to their tool names', async () => {
    const { getPresetTools } = await import(
      '../../../lib/tool-config/server-catalog.server'
    )
    const preset = await getPresetTools()
    expect(preset).toContain('read_neo4j_cypher') // neo4j-cypher ∈ preset
    expect(preset).toContain('search') // web_search ∈ preset
    expect(preset).not.toContain('create_entities') // memory ∉ preset
  })
})
