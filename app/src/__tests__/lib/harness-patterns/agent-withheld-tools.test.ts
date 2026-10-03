// The composition root registers the harness client seam (tier policy, model
// tables); the adapters below run through it as a production turn does.
import '../../../lib/inference/config.server'
/**
 * No agent is offered `write_neo4j_cypher`, whatever the gateway lists (#403).
 *
 * Owner decision, 2026-10-03: agents are read-only against Neo4j, the `general`
 * agent included; the one writer is the memory hook (#419), through the app.
 *
 * Two layers. `configs/mcp-config.yaml` ships `read_only: true`, under which the
 * server does not list the write tool (pinned in
 * `lib/config/mcp-config-read-only.test.ts`). This file pins the app-side layer:
 * `listTools()`, the one door every gateway catalog read goes through, drops it
 * — the same door #422 shut on the gateway's management tools. So a config that
 * says `false` (a host's own copy, a missing key, a server bump) still hands it
 * to no agent: not `Tools()` (every `tools.all` and namespace, i.e. every
 * loop's allowlist), not the planner's catalog, not a controller's.
 *
 * Only the MCP SDK is mocked. `listTools`, `Tools`, `callTool`, the namespace
 * catalog and the adapters are the real modules, so removing the filter turns
 * this file red rather than a stub of it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mcpNamespace } from '@hames-ai/connectors/mcp-catalog'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const mockListTools = vi.fn()
const mockCallTool = vi.fn()

class MockClient {
  connect = vi.fn(async () => undefined)
  close = vi.fn(async () => undefined)
  callTool = mockCallTool
  listTools = mockListTools
}

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: MockClient }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}))

const mockPlanner = vi.fn()
const mockLoopController = vi.fn()
vi.mock('@hames-ai/harness-baml/baml_client', () => ({
  b: {
    Planner: (...args: unknown[]) => mockPlanner(...args),
    LoopController: (...args: unknown[]) => mockLoopController(...args),
  },
}))

/** Written out rather than imported, so dropping the name from the filter
 *  turns this red. */
const WRITE = 'write_neo4j_cypher'
/** The same tool behind a gateway that prefixes names, the form `inferServer`
 *  already reads; a prefix must not hand the tool back. */
const PREFIXED_WRITE = `mcp__hames-mcp-gateway__${WRITE}`

/** What an agent may keep: the two Neo4j reads and the other catalog servers. */
const KEPT = [
  'get_neo4j_schema',
  'read_neo4j_cypher',
  'fetch',
  'search',
  'resolve-library-id',
  'get-library-docs',
  'read_graph',
  'create_entities',
]

/** A gateway serving `neo4j-cypher` with `read_only: false` — the regression the
 *  second layer exists for — interleaved the way the live listing is. */
const READ_WRITE_LISTING = [...KEPT.slice(0, 2), WRITE, ...KEPT.slice(2), PREFIXED_WRITE]

function gatewayListing(names: string[]) {
  return { tools: names.map((name) => ({ name, description: `${name} tool`, inputSchema: {} })) }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockListTools.mockResolvedValue(gatewayListing(READ_WRITE_LISTING))
  mockPlanner.mockResolvedValue({ reasoning: 'r', plan: '1. Query.', n_steps: 1 })
  mockLoopController.mockResolvedValue({
    reasoning: 'r',
    tool_name: 'Return',
    tool_args: 'done',
    status: 'success',
    is_final: true,
  })
})

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('the Neo4j write tool is withheld from agents', () => {
  it('is dropped from listTools, prefixed or not, and every other tool is kept in order', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { listTools } = await import('@hames-ai/harness-patterns/mcp-client.server')

    const names = (await listTools()).map((t) => t.name)

    expect(names).not.toContain(WRITE)
    expect(names).not.toContain(PREFIXED_WRITE)
    expect(names).toEqual(KEPT)
  })

  it('is dropped on the pool-rebuild path as well', async () => {
    // `listTools` has a second success path: both attempts on the leased
    // connection fail, the pool is emptied, and one more read answers.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    mockListTools
      .mockRejectedValueOnce(new Error('connection closed'))
      .mockRejectedValueOnce(new Error('connection closed'))
    const { listTools } = await import('@hames-ai/harness-patterns/mcp-client.server')

    const names = (await listTools()).map((t) => t.name)

    expect(mockListTools).toHaveBeenCalledTimes(3)
    expect(names).toEqual(KEPT)
  })

  it('reaches no agent tool list: tools.neo4j holds the two reads, and nothing holds the write', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { Tools } = await import('@hames-ai/harness-patterns/tools.server')

    const tools = await Tools({ namespaces: mcpNamespace })

    // `tools.neo4j` is what `search` and `retriever` hand their Neo4j loop;
    // `tools.all` is what `general` hands its planner and its loop.
    expect(tools.neo4j).toEqual(['get_neo4j_schema', 'read_neo4j_cypher'])
    for (const [namespace, list] of Object.entries(tools) as [string, string[]][]) {
      expect(list, `${namespace} has ${WRITE}`).not.toContain(WRITE)
      expect(list, `${namespace} has ${PREFIXED_WRITE}`).not.toContain(PREFIXED_WRITE)
    }
  })

  it("is not in the planner's catalog, even when an allowlist names it", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { Tools } = await import('@hames-ai/harness-patterns/tools.server')
    const { createPlannerAdapter } = await import('@hames-ai/harness-baml/baml-adapters.server')

    const tools = await Tools({ namespaces: mcpNamespace })
    await createPlannerAdapter(tools.all)('add these to the graph', 'add nodes')
    await createPlannerAdapter([...tools.all, WRITE])('add these to the graph', 'add nodes')

    expect(mockPlanner).toHaveBeenCalledTimes(2)
    for (const call of mockPlanner.mock.calls) {
      const shown = (call[2] as { name: string }[]).map((t) => t.name)
      expect(shown).toEqual(KEPT)
    }
  })

  it("is not in a loop controller's catalog, even when the loop's allowlist names it", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { createLoopControllerAdapter } =
      await import('@hames-ai/harness-baml/baml-adapters.server')

    await createLoopControllerAdapter()({
      userMessage: 'add these to the graph',
      intent: 'add nodes',
      tools: ['read_neo4j_cypher', 'get_neo4j_schema', WRITE],
      turns: [],
      turn: 0,
    })

    const advertised = (mockLoopController.mock.calls[0][2] as { name: string }[]).map(
      (t) => t.name,
    )
    expect(advertised).toEqual(['get_neo4j_schema', 'read_neo4j_cypher'])
  })

  it('warns once that the server-side switch is off, naming the switch and the restart', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { listTools } = await import('@hames-ai/harness-patterns/mcp-client.server')

    await listTools()
    await listTools()

    const drops = warn.mock.calls.filter((c) => String(c[0]).includes(WRITE))
    expect(drops).toHaveLength(1)
    expect(drops[0][0]).toContain(PREFIXED_WRITE)
    expect(drops[0][0]).toContain('read_only: true')
    expect(drops[0][0]).toContain('restart the gateway')
  })

  it('warns about nothing when the gateway serves Neo4j read-only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockListTools.mockResolvedValue(gatewayListing(KEPT))
    const { listTools } = await import('@hames-ai/harness-patterns/mcp-client.server')

    expect((await listTools()).map((t) => t.name)).toEqual(KEPT)
    expect(warn).not.toHaveBeenCalled()
  })

  it('narrows the catalog only: callTool still dispatches the name, which is the app-side writer room', async () => {
    // Deliberate (#403, #419): the list decides what an AGENT is offered, and a
    // loop cannot call a name its allowlist lacks. A write the app issues by
    // name — the memory hook's path, once it exists — is not blocked here.
    // Moving the block onto callTool would make that a deliberate edit that
    // turns this red, rather than a silent one.
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: '{"nodes_created":1}' }] })
    const { callTool } = await import('@hames-ai/harness-patterns/mcp-client.server')

    const result = await callTool(WRITE, { query: 'MERGE (n:Probe) RETURN n' })

    expect(mockCallTool).toHaveBeenCalledWith({
      name: WRITE,
      arguments: { query: 'MERGE (n:Probe) RETURN n' },
    })
    expect(result).toEqual({ success: true, data: { nodes_created: 1 } })
  })
})
