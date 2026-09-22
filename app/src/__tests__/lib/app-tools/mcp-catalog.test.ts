/**
 * The MCP namespace catalog — the COMPOSITION half (#225 L5 / PR-C2).
 *
 * The catalog DATA and its ToolsFrom grouping moved co-located into
 * `@hames-ai/connectors` with the module; what stayed here is what only the host
 * can prove: that importing the composition root registers `mcpNamespace` on
 * core's resolver seam (so `inferServer` sees it without any call site passing
 * it), and that the app tools' own `namespaceFor` answers ahead of the
 * catalog. The heuristic's own cases plus the degradation provenance live in
 * `__tests__/lib/harness-patterns/tools.test.ts`, which deliberately registers
 * no catalog, so the split itself pins that the catalog left core.
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
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

describe('the MCP namespace catalog (composition root wiring)', () => {
  it('is registered by importing the barrel, and inferServer routes through it', async () => {
    await import('../../../lib/app-tools/index.server')
    const { inferServer } = await import('@hames-ai/harness-patterns/tools.server')

    // 'search' is a single word — the heuristic alone would say 'search'.
    // Only the registered catalog makes it 'web'.
    expect(inferServer('search')).toBe('web')
    expect(inferServer('vector_search_hash')).toBe('redis')
    expect(inferServer('mcp__kg-agent-mcp-gateway__search')).toBe('web')
  })

  it('the app tools keep their own grouping, ahead of the catalog', async () => {
    await import('../../../lib/app-tools/index.server')
    const { inferServer } = await import('@hames-ai/harness-patterns/tools.server')

    // `list_graph_messages` would mis-bucket under any name heuristic; the app
    // transport's `namespaceFor` (the retired `appToolNamespace` special case)
    // answers before the catalog and the heuristic are consulted.
    expect(inferServer('graph_me')).toBe('graph')
    expect(inferServer('list_graph_messages')).toBe('graph')
  })
})
