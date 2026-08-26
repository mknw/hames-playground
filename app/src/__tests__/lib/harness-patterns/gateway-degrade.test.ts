/**
 * A collapsed MCP tool surface is reported, not papered over (#276).
 *
 * The shipped behaviour this changes: with the gateway refusing connections,
 * `listTools` logged and returned only the app-side tools, so `Tools()` handed
 * every agent a ToolSet with no `neo4j` and no `web` key, `tools.neo4j ?? []`
 * turned that into an empty allowlist, and the loop ran its full turn budget
 * calling nothing — after which the synthesizer answered the question anyway.
 * The row said `done`. The app-path e2e suite had measured exactly that and
 * written it into scenario 6's header as the reason it injected some other
 * fault.
 *
 * Three things are pinned here, because they fail independently:
 *   - the pool rebuild + second attempt in `listTools` (recovery), and the
 *     health state it records either way;
 *   - `toolSurfaceOutage`, whose whole job is NOT firing on the empty tool
 *     lists that are legitimate;
 *   - both loop patterns refusing, with the severity that stops the chain.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
  assertServer: vi.fn(),
}))

// ---------------------------------------------------------------------------
// MCP SDK double (same shape as mcp-client.test.ts)
// ---------------------------------------------------------------------------
const mockConnect = vi.fn()
const mockClose = vi.fn()
const mockCallTool = vi.fn()
const mockListTools = vi.fn()

class MockClient {
  connect = mockConnect
  close = mockClose
  callTool = mockCallTool
  listTools = mockListTools
}

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: MockClient }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}))

/** The transport-level shape `isConnectionError` recognises. */
const DOWN = new Error('fetch failed: ECONNREFUSED 127.0.0.1:8811')

beforeEach(() => {
  vi.clearAllMocks()
  mockConnect.mockResolvedValue(undefined)
  mockClose.mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('listTools recovery and health', () => {
  it('rebuilds the pool and tries again before giving up', async () => {
    const mcp = await import('../../../lib/harness-patterns/mcp-client.server')
    // Warm all four pooled connections first (concurrent calls, so each takes
    // its own slot). This is the state the rebuild is FOR: a gateway restart
    // drops every keep-alive at once, and `withReconnect` only ever rebuilds
    // the one connection its lease was holding.
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: '{}' }] })
    await Promise.all([
      mcp.callTool('a', {}),
      mcp.callTool('b', {}),
      mcp.callTool('c', {}),
      mcp.callTool('d', {}),
    ])
    const warmed = mockClose.mock.calls.length
    mockListTools.mockRejectedValue(DOWN)

    await mcp.listTools()

    // Two attempts, each with `withReconnect`'s own single retry — four calls.
    expect(mockListTools).toHaveBeenCalledTimes(4)
    // And at least one close per warm connection, which is what separates a
    // pool rebuild from the per-lease reconnect (measured: 6 closes with the
    // rebuild, 2 without it).
    expect(mockClose.mock.calls.length - warmed).toBeGreaterThanOrEqual(4)
  })

  it('recovers silently when the rebuild works', async () => {
    mockListTools
      .mockRejectedValueOnce(DOWN)
      .mockRejectedValueOnce(DOWN)
      .mockResolvedValue({ tools: [{ name: 'read_neo4j_cypher', inputSchema: {} }] })

    const { listTools } = await import('../../../lib/harness-patterns/mcp-client.server')
    const { gatewayDegradation } =
      await import('../../../lib/harness-patterns/gateway-health.server')

    const tools = await listTools()

    expect(tools.map((t) => t.name)).toContain('read_neo4j_cypher')
    // Recovered means recovered: nothing downstream should start refusing.
    expect(gatewayDegradation()).toBeNull()
  })

  it('records the outage, with the cause, when it cannot recover', async () => {
    mockListTools.mockRejectedValue(DOWN)
    const { listTools } = await import('../../../lib/harness-patterns/mcp-client.server')
    const { gatewayDegradation } =
      await import('../../../lib/harness-patterns/gateway-health.server')

    const tools = await listTools()

    // Still degrades gracefully for callers that must not crash on a missing
    // catalog — the app-side tools run in-process.
    expect(tools.every((t) => t.name !== 'read_neo4j_cypher')).toBe(true)
    const outage = gatewayDegradation()
    expect(outage).not.toBeNull()
    // The message names the cause a "tools unavailable" line cannot.
    expect(outage!.error).toContain('ECONNREFUSED')
  })

  it('clears the outage on the next successful read', async () => {
    mockListTools.mockRejectedValue(DOWN)
    const { listTools } = await import('../../../lib/harness-patterns/mcp-client.server')
    const { gatewayDegradation } =
      await import('../../../lib/harness-patterns/gateway-health.server')

    await listTools()
    expect(gatewayDegradation()).not.toBeNull()

    mockListTools.mockReset()
    mockListTools.mockResolvedValue({ tools: [{ name: 'search', inputSchema: {} }] })
    await listTools()

    expect(gatewayDegradation()).toBeNull()
  })

  it('does not treat a failing tool CALL as a dead gateway', async () => {
    mockListTools.mockResolvedValue({ tools: [{ name: 'search', inputSchema: {} }] })
    mockCallTool.mockRejectedValue(DOWN)
    const { callTool } = await import('../../../lib/harness-patterns/mcp-client.server')
    const { gatewayDegradation } =
      await import('../../../lib/harness-patterns/gateway-health.server')

    await callTool('search', { query: 'x' })

    // A tool that fails mid-loop is ordinary — the controller sees the error and
    // decides. Only a catalog that cannot be fetched means no tool can be
    // chosen at all, so only `listTools` writes the health state.
    expect(gatewayDegradation()).toBeNull()
  })
})

describe('toolSurfaceOutage', () => {
  it('says nothing when the pattern has tools', async () => {
    const health = await import('../../../lib/harness-patterns/gateway-health.server')
    health.markGatewayUnreachable('down')

    // A degraded gateway plus a non-empty list is a pattern whose tools came
    // from somewhere else (an app-side tool, a sandbox) and which can still do
    // its job.
    expect(health.toolSurfaceOutage(['graph_me'])).toBeNull()
  })

  it('says nothing about an empty list while the gateway is fine', async () => {
    const health = await import('../../../lib/harness-patterns/gateway-health.server')
    health.__resetGatewayHealth()

    // The two sandbox agents pass `[]` on purpose — their tools arrive over
    // `docker exec`. An empty list is not by itself a fault.
    expect(health.toolSurfaceOutage([])).toBeNull()
  })

  it('explains an empty list that the gateway caused', async () => {
    const health = await import('../../../lib/harness-patterns/gateway-health.server')
    health.markGatewayUnreachable('ECONNREFUSED 127.0.0.1:8811')

    const outage = health.toolSurfaceOutage([])

    expect(outage).not.toBeNull()
    expect(outage!.error).toContain('Tools unavailable')
    expect(outage!.error).toContain('ECONNREFUSED')
    // The hint tells the operator where to look and tells the user not to
    // rephrase the question, which is what they would otherwise try.
    expect(outage!.hint).toContain('MCP_GATEWAY_URL')
  })

  it('explains a whole tool surface the gateway amputated, app-side survivors and all', async () => {
    // F1 on #278, at unit scale. `listTools` returns the app-side tools on its
    // failure path, so `tools.all` under a dead gateway is the nine `graph_*`
    // tools rather than `[]` — and while this guard opened with
    // `tools.length > 0`, the `general` agent (which passes `tools.all` to a
    // planner and a `simpleLoop`) sailed straight past it and answered `done`.
    const health = await import('../../../lib/harness-patterns/gateway-health.server')
    health.__resetGatewayHealth()
    health.markGatewayUnreachable('ECONNREFUSED 127.0.0.1:8811')

    const amputated = ['graph_me', 'graph_calendar_today', 'graph_mail_recent']
    health.markDegradedToolSurface(amputated)

    const outage = health.toolSurfaceOutage(amputated)
    expect(outage, 'an amputated whole surface read as healthy').not.toBeNull()
    expect(outage!.error).toContain('ECONNREFUSED')
  })

  it('leaves an agent that composed an app-side list alone', async () => {
    // The same three names, and the reason a name-based test would be wrong:
    // every app-side tool registered today is in the `graph` namespace, so a
    // `general` agent robbed of the gateway holds exactly the list
    // `microsoft-365` builds on purpose out of `tools.graph`. That agent needs
    // no gateway, so refusing it would break a working agent over an outage
    // that costs it nothing. Only provenance separates the two.
    const health = await import('../../../lib/harness-patterns/gateway-health.server')
    health.__resetGatewayHealth()
    health.markGatewayUnreachable('ECONNREFUSED 127.0.0.1:8811')

    const composed = ['graph_me', 'graph_calendar_today', 'graph_mail_recent']
    expect(health.toolSurfaceOutage(composed)).toBeNull()
  })

  it('forgets the provenance on reset, so one test cannot brand another', async () => {
    const health = await import('../../../lib/harness-patterns/gateway-health.server')
    const surface = ['graph_me']
    health.markDegradedToolSurface(surface)
    health.__resetGatewayHealth()
    health.markGatewayUnreachable('down')

    expect(health.toolSurfaceOutage(surface)).toBeNull()
  })

  it('keeps the first failure time, so `since` measures the outage', async () => {
    const health = await import('../../../lib/harness-patterns/gateway-health.server')
    health.__resetGatewayHealth()
    health.markGatewayUnreachable('first')
    const since = health.gatewayDegradation()!.since
    health.markGatewayUnreachable('second')

    expect(health.gatewayDegradation()!.since).toBe(since)
    expect(health.gatewayDegradation()!.error).toBe('second')
  })
})

describe('the loops refuse to answer without tools', () => {
  /** The scope + view a pattern needs, with one user message in context. */
  async function harness(patternId: string) {
    const { createScope } = await import('../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../lib/harness-patterns/patterns')
    const ctx = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        {
          type: 'user_message' as const,
          ts: Date.now(),
          patternId: 'harness',
          data: { content: 'how many nodes are in the graph?' },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'how many nodes are in the graph?',
    }
    return {
      scope: createScope(patternId, { intent: 'how many nodes are in the graph?' }),
      view: createEventView(ctx),
    }
  }

  it('simpleLoop records an irrecoverable error and makes no LLM call', async () => {
    const health = await import('../../../lib/harness-patterns/gateway-health.server')
    health.markGatewayUnreachable('ECONNREFUSED')
    const { simpleLoop } = await import('../../../lib/harness-patterns/patterns/simpleLoop.server')

    const controller = vi.fn()
    const pattern = simpleLoop(controller, [], { patternId: 'neo4j-query' })
    const { scope, view } = await harness('neo4j-query')

    await pattern.fn(scope, view)

    // Refused BEFORE the controller call: spending a turn budget on a question
    // this pattern cannot act on is the part that made the old behaviour look
    // like work.
    expect(controller).not.toHaveBeenCalled()
    const errors = scope.events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    const data = errors[0].data as { error: string; severity?: string; hint?: string }
    expect(data.error).toContain('Tools unavailable')
    // The severity is what makes `runChain` stop the chain, so the synthesizer
    // never gets to answer around the hole. It is on the EVENT because the
    // pattern default (`simpleLoop: 'recoverable'`) is right for every other
    // failure this loop has.
    expect(data.severity).toBe('irrecoverable')
    expect(data.hint).toBeTruthy()
  })

  it('actorCritic does the same', async () => {
    const health = await import('../../../lib/harness-patterns/gateway-health.server')
    health.markGatewayUnreachable('ECONNREFUSED')
    const { actorCritic } =
      await import('../../../lib/harness-patterns/patterns/actorCritic.server')

    const actor = vi.fn()
    const critic = vi.fn()
    const pattern = actorCritic(actor, critic, [], { patternId: 'ac' })
    const { scope, view } = await harness('ac')

    await pattern.fn(scope, view)

    expect(actor).not.toHaveBeenCalled()
    expect(critic).not.toHaveBeenCalled()
    expect(
      (scope.events.find((e) => e.type === 'error')!.data as { severity?: string }).severity,
    ).toBe('irrecoverable')
  })

  it('leaves a sandbox loop alone — its tools never came from the gateway', async () => {
    const health = await import('../../../lib/harness-patterns/gateway-health.server')
    health.markGatewayUnreachable('ECONNREFUSED')
    const { actorCritic } =
      await import('../../../lib/harness-patterns/patterns/actorCritic.server')
    const scopeMod = await import('../../../lib/sandbox/scope.server')

    // The two sandbox agents pass `[]` and get their tools from the VM over
    // `docker exec`. Refusing them on a gateway outage would break the one kind
    // of agent that does not need the gateway at all.
    vi.spyOn(scopeMod, 'getActiveSandbox').mockReturnValue({
      ownsTool: () => true,
      listTools: async () => [],
    } as never)

    const actor = vi.fn().mockRejectedValue(new Error('stop here'))
    const pattern = actorCritic(actor, vi.fn(), [], { patternId: 'sandbox-loop' })
    const { scope, view } = await harness('sandbox-loop')

    await pattern.fn(scope, view)

    // It got as far as the actor, which is all this case is about.
    expect(actor).toHaveBeenCalled()
    const refusal = scope.events.find(
      (e) =>
        e.type === 'error' &&
        String((e.data as { error?: string }).error).includes('Tools unavailable'),
    )
    expect(refusal).toBeUndefined()
  })
})
