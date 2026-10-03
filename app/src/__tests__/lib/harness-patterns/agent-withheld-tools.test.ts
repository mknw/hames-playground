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
import type { ControllerInput } from '@hames-ai/harness-patterns/types'

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
/** The same tool from a server started with `NEO4J_NAMESPACE=graph2`: the pinned
 *  `mcp-neo4j-cypher` 0.5.0 names its tools `<namespace>-<tool>`, which is how
 *  a second, namespaced Neo4j server would arrive. */
const NAMESPACED_WRITE = `graph2-${WRITE}`

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
const READ_WRITE_LISTING = [
  ...KEPT.slice(0, 2),
  WRITE,
  ...KEPT.slice(2),
  PREFIXED_WRITE,
  NAMESPACED_WRITE,
]

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
    expect(names).not.toContain(NAMESPACED_WRITE)
    expect(names).toEqual(KEPT)
  })

  it('is matched by name, not by substring: a tool merely ending in the same words is kept', async () => {
    const { isAgentWithheldTool } = await import('@hames-ai/harness-patterns/agent-withheld-tools')

    for (const name of [WRITE, PREFIXED_WRITE, NAMESPACED_WRITE]) {
      expect(isAgentWithheldTool(name), name).toBe(true)
    }
    for (const name of ['read_neo4j_cypher', 'rewrite_neo4j_cypher', `${WRITE}_audit`, 'search']) {
      expect(isAgentWithheldTool(name), name).toBe(false)
    }
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

  it('warns once that the server-side switch is off, naming the switch and the recreate', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { listTools } = await import('@hames-ai/harness-patterns/mcp-client.server')

    await listTools()
    await listTools()

    const drops = warn.mock.calls.filter((c) => String(c[0]).includes(WRITE))
    expect(drops).toHaveLength(1)
    expect(drops[0][0]).toContain(PREFIXED_WRITE)
    expect(drops[0][0]).toContain(NAMESPACED_WRITE)
    expect(drops[0][0]).toContain('read_only: true')
    // Recreate, after a fresh render — never a restart, which re-reads the old
    // render (docs/MCP_GATEWAY.md "Neo4j writes").
    expect(drops[0][0]).toContain(
      'docker compose run --rm mcp-config && docker compose up -d --no-deps --force-recreate mcp-gateway',
    )
    expect(drops[0][0]).not.toMatch(/restart/)
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

/**
 * The review's MEDIUM on #434: the catalog drop covers every allowlist built
 * from `Tools()`, but a loop handed a list written by hand used to accept the
 * tool — and show its few-shot. The loops' own allowlist check now refuses it,
 * so "no loop allowlist holds it" is true of every loop, not only the shipped
 * agents'. The gateway here serves the tool and would execute it if asked.
 */
describe('a loop whose allowlist names the write tool still cannot call it', () => {
  const context = () => ({
    sessionId: 'hand-written',
    createdAt: Date.now(),
    events: [
      {
        type: 'user_message' as const,
        ts: 1,
        patternId: 'harness',
        data: { content: 'Add several concepts at once: Vectors, Embeddings.' },
      },
    ],
    status: 'running' as const,
    data: {},
    input: 'Add several concepts at once: Vectors, Embeddings.',
  })

  const action = (tool_name: string, tool_args: string, extra: object = {}) => ({
    reasoning: 'r',
    tool_name,
    tool_args,
    status: 'Working',
    is_final: false,
    ...extra,
  })
  const finish = { ...action('Return', 'done'), is_final: true }

  /** What the gateway was actually asked to run. */
  const sentToGateway = () => mockCallTool.mock.calls.map(([c]) => (c as { name: string }).name)

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: '[{"n":1}]' }] })
  })

  it('simpleLoop: shows no write example, advertises no write tool, and refuses the call', async () => {
    const { simpleLoop } = await import('@hames-ai/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('@hames-ai/harness-patterns/context.server')
    const { createEventView } = await import('@hames-ai/harness-patterns/patterns')
    const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')
    const { NEO4J_FEW_SHOTS_DEFAULT } =
      await import('@hames-ai/agents/agents/neo4j-fewshots.server')
    const upsert = NEO4J_FEW_SHOTS_DEFAULT.find((shot) => shot.tool === WRITE)!

    // A controller that copies the write example — the #401 habit — and names
    // the tool even when it is not shown one.
    const controller = vi.fn(async () => ({
      action: action(WRITE, upsert.args),
      llmCall: undefined,
    }))
    const pattern = simpleLoop(controller, ['read_neo4j_cypher', WRITE], {
      patternId: 'hand-written',
      fewShots: NEO4J_FEW_SHOTS_DEFAULT,
    })

    const result = await withRunFrame({}, () =>
      pattern.fn(createScope('hand-written', {}), createEventView(context())),
    )

    const input = (controller.mock.calls[0] as unknown as [ControllerInput])[0]
    expect(input.tools).toEqual(['read_neo4j_cypher'])
    expect(input.fewShots?.map((shot) => shot.tool)).not.toContain(WRITE)
    expect(sentToGateway()).not.toContain(WRITE)
    // Since #437 a refusal is a recovery the loop feeds back, not an error
    // that ends it: every round names the tool, every round is refused, and
    // the consecutive-recovery cap (default 2) ends the loop on the second.
    const refusal = `Tool not allowed: ${WRITE} (withheld from every agent). Allowed: read_neo4j_cypher`
    const recoveries = result.events
      .filter((e) => e.type === 'loop_recovery')
      .map((e) => e.data as { failure: string; error: string })
    expect(recoveries.length).toBeGreaterThan(0)
    for (const r of recoveries)
      expect(r).toMatchObject({ failure: 'tool_not_allowed', error: refusal })
    // The marker reaches the model: the next round's turn log carries it as
    // the refused round's ERROR, so the controller reads "withheld", not
    // "misspelled". Mutation: build the singular refusal without `refusal()`
    // (no withheld marker) → red.
    const second = (controller.mock.calls[1] as unknown as [ControllerInput])[0]
    expect(second.turns[0].tool_result?.error).toBe(refusal)
    const errors = result.events.filter((e) => e.type === 'error')
    expect(errors.map((e) => e.data)).toEqual([
      expect.objectContaining({ kind: 'recovery_exhausted', error: refusal }),
    ])
  })

  it('simpleLoop: a scoped transport that claims the name cannot hand it back either', async () => {
    const { simpleLoop } = await import('@hames-ai/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('@hames-ai/harness-patterns/context.server')
    const { createEventView } = await import('@hames-ai/harness-patterns/patterns')
    const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')

    const transportCall = vi.fn(async () => ({ success: true, data: { nodes_created: 1 } }))
    const transport = {
      id: 'scoped:claims-write',
      ownsTool: (name: string) => name === WRITE,
      callTool: transportCall,
      listTools: async () => [],
    }
    const controller = vi.fn(async () => ({
      action: action(WRITE, '{"query":"MERGE (n)"}'),
      llmCall: undefined,
    }))
    const pattern = simpleLoop(controller, ['read_neo4j_cypher'], { patternId: 'scoped-claim' })

    const result = await withRunFrame({ transports: [transport] }, () =>
      pattern.fn(createScope('scoped-claim', {}), createEventView(context())),
    )

    expect(transportCall).not.toHaveBeenCalled()
    expect(sentToGateway()).not.toContain(WRITE)
    const recoveries = result.events.filter((e) => e.type === 'loop_recovery')
    expect(String((recoveries[0]?.data as { error?: string })?.error)).toContain(
      'withheld from every agent',
    )
  })

  it('simpleLoop: refuses it inside a multi-call turn and still runs the read beside it', async () => {
    const { simpleLoop } = await import('@hames-ai/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('@hames-ai/harness-patterns/context.server')
    const { createEventView } = await import('@hames-ai/harness-patterns/patterns')
    const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')

    const controller = vi
      .fn()
      .mockResolvedValueOnce({
        action: action('read_neo4j_cypher', '{"query":"MATCH (n) RETURN n"}', {
          additional_calls: [{ tool_name: PREFIXED_WRITE, tool_args: '{"query":"MERGE (n)"}' }],
        }),
        llmCall: undefined,
      })
      .mockResolvedValueOnce({ action: finish, llmCall: undefined })
    const pattern = simpleLoop(controller, ['read_neo4j_cypher', PREFIXED_WRITE], {
      patternId: 'hand-written-batch',
    })

    const result = await withRunFrame({}, () =>
      pattern.fn(createScope('hand-written-batch', {}), createEventView(context())),
    )

    expect(sentToGateway()).toEqual(['read_neo4j_cypher'])
    const refused = result.events
      .filter((e) => e.type === 'tool_result')
      .map((e) => e.data as { tool: string; success: boolean; error?: string })
      .find((d) => d.tool === PREFIXED_WRITE)
    expect(refused?.success).toBe(false)
    expect(refused?.error).toContain('withheld from every agent')
  })

  it.each<[string, { tools: string[]; config?: Record<string, unknown> }]>([
    ['a hand-written list', { tools: [WRITE] }],
    [
      'a dynamicToolPattern',
      { tools: ['read_neo4j_cypher'], config: { dynamicToolPattern: /neo4j/ } },
    ],
    [
      'a dynamicToolAllowlist',
      { tools: [], config: { dynamicToolAllowlist: async () => [WRITE] } },
    ],
  ])('actorCritic: %s cannot admit it', async (_label, { tools, config }) => {
    const { actorCritic } = await import('@hames-ai/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('@hames-ai/harness-patterns/context.server')
    const { createEventView } = await import('@hames-ai/harness-patterns/patterns')
    const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')

    const actor = vi.fn(async () => ({
      action: action(WRITE, '{"query":"MERGE (n:Probe)"}'),
      llmCall: undefined,
    }))
    const critic = vi.fn(async () => ({
      result: { is_sufficient: true, explanation: 'ok' },
      llmCall: undefined,
    }))
    const pattern = actorCritic(actor, critic, tools, {
      patternId: 'hand-written-actor',
      maxRetries: 1,
      ...config,
    })

    const result = await withRunFrame({}, () =>
      pattern.fn(createScope('hand-written-actor', {}), createEventView(context())),
    )

    expect(actor).toHaveBeenCalled()
    expect(sentToGateway()).not.toContain(WRITE)
    // A `loop_recovery` since #437, not an `error`: the actor is told through
    // `previousAttempts` and the loop goes on.
    const refusals = result.events
      .filter((e) => e.type === 'loop_recovery')
      .map((e) => String((e.data as { error: string }).error))
    expect(refusals).toContain(`Tool not allowed: ${WRITE} (withheld from every agent)`)
  })

  it('actorCritic: refuses it inside a multi-call attempt and still runs the read beside it', async () => {
    const { actorCritic } = await import('@hames-ai/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('@hames-ai/harness-patterns/context.server')
    const { createEventView } = await import('@hames-ai/harness-patterns/patterns')
    const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')

    const actor = vi.fn(async () => ({
      action: action('read_neo4j_cypher', '{"query":"MATCH (n) RETURN n"}', {
        additional_calls: [{ tool_name: WRITE, tool_args: '{"query":"MERGE (n)"}' }],
      }),
      llmCall: undefined,
    }))
    const critic = vi.fn(async () => ({
      result: { is_sufficient: true, explanation: 'ok' },
      llmCall: undefined,
    }))
    const pattern = actorCritic(actor, critic, ['read_neo4j_cypher', WRITE], {
      patternId: 'hand-written-actor-batch',
      maxRetries: 1,
    })

    const result = await withRunFrame({}, () =>
      pattern.fn(createScope('hand-written-actor-batch', {}), createEventView(context())),
    )

    expect(sentToGateway()).toEqual(['read_neo4j_cypher'])
    const refused = result.events
      .filter((e) => e.type === 'tool_result')
      .map((e) => e.data as { tool: string; success: boolean; error?: string })
      .find((d) => d.tool === WRITE)
    expect(refused?.success).toBe(false)
    expect(refused?.error).toBe(`Tool not allowed: ${WRITE} (withheld from every agent)`)
  })
})
