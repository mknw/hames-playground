// The composition root registers the harness client seam (tier policy, model
// tables); the adapters below run through it as a production turn does.
import '../../../lib/inference/config.server'
/**
 * No agent is offered a Postgres tool, whatever the gateway lists (#412).
 *
 * Owner decision, 2026-10-03: running agents were never meant to have Postgres
 * access. The `database-server` catalog server ran SQL against the app's own
 * database, and `general` hands every gateway tool to its planner and its loop.
 *
 * Two layers. The server is gone from the catalog and the configs, and the
 * gateway gets no Postgres credential (pinned in
 * `lib/config/no-agent-postgres.test.ts`). This file pins the app-side layer,
 * for a config regression that brings the server back: `listTools()`, the one
 * door every gateway catalog read goes through, withholds its tools through
 * the same list that withholds `write_neo4j_cypher` (#403). So no agent is
 * offered one: not `Tools()` (every `tools.all` and namespace, i.e. every
 * loop's allowlist), not the planner's catalog, not a controller's, not the
 * tool list any shipped agent hands to any pattern — and a loop whose own
 * allowlist names one, or matches it by pattern, still refuses the call.
 *
 * Only the MCP SDK is mocked, plus the generated BAML client. `listTools`,
 * `Tools`, the namespace catalog, the adapters and the agents themselves are
 * the real modules, so removing the names from the list turns this red rather
 * than a stub of it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mcpNamespace } from '@hames-ai/connectors/mcp-catalog'
import type { AgentDefinition } from '@hames-ai/agents'
import type { ControllerInput } from '@hames-ai/harness-patterns/types'
import { testAgentDeps } from '../harness-client/agents/test-deps'

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

/**
 * The tool list every pattern factory an agent can call was handed, in call
 * order. The factories stay real; this only records their tools argument.
 */
const handed: { factory: string; tools: string[] }[] = []

vi.mock('@hames-ai/harness-patterns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hames-ai/harness-patterns')>()
  const record =
    <F extends (...args: never[]) => unknown>(factory: string, at: number, fn: F) =>
    (...args: Parameters<F>) => {
      handed.push({ factory, tools: [...(args[at] as unknown as string[])] })
      return fn(...args)
    }
  return {
    ...actual,
    simpleLoop: record('simpleLoop', 1, actual.simpleLoop),
    planner: record('planner', 1, actual.planner),
    actorCritic: record('actorCritic', 2, actual.actorCritic),
  }
})

/** The `database-server` image's tools, from its upstream catalog entry
 *  (`configs/catalog.yaml`, which lists `execute_sql` too). Written out rather
 *  than imported, so dropping one from the list turns this red. */
const POSTGRES_TOOLS = [
  'query_database',
  'execute_sql',
  'list_tables',
  'describe_table',
  'connect_to_database',
  'get_connection_examples',
  'get_current_database_info',
]
/** The same tools behind a gateway that prefixes names, the form `inferServer`
 *  already reads; a prefix must not hand one back. */
const PREFIXED = POSTGRES_TOOLS.map((t) => `mcp__hames-mcp-gateway__${t}`)
const WITHHELD = [...POSTGRES_TOOLS, ...PREFIXED]

/** What an agent may keep: the other catalog servers, including the app's
 *  per-user Graph names so `microsoft-365` composes as it does in production. */
const KEPT = [
  'get_neo4j_schema',
  'read_neo4j_cypher',
  'fetch',
  'search',
  'resolve-library-id',
  'get-library-docs',
  'read_graph',
  'create_entities',
  'graph_mail_recent',
  'graph_calendar_today',
]

/** A gateway still serving `database-server` — the regression this layer is
 *  for — interleaved the way the live listing is. */
const REGRESSED_LISTING = [
  ...KEPT.slice(0, 3),
  ...POSTGRES_TOOLS.slice(0, 4),
  ...KEPT.slice(3),
  ...POSTGRES_TOOLS.slice(4),
  ...PREFIXED,
]

function gatewayListing(names: string[]) {
  return { tools: names.map((name) => ({ name, description: `${name} tool`, inputSchema: {} })) }
}

beforeEach(() => {
  vi.clearAllMocks()
  handed.length = 0
  mockListTools.mockResolvedValue(gatewayListing(REGRESSED_LISTING))
  mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: '{}' }] })
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

describe('the database-server tools are withheld from agents', () => {
  it('are dropped from listTools, prefixed or not, and every other tool is kept in order', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { listTools } = await import('@hames-ai/harness-patterns/mcp-client.server')

    const names = (await listTools()).map((t) => t.name)

    for (const name of WITHHELD) expect(names, name).not.toContain(name)
    expect(names).toEqual(KEPT)
  })

  it('reach no namespace and not tools.all', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { Tools } = await import('@hames-ai/harness-patterns/tools.server')

    const tools = await Tools({ namespaces: mcpNamespace })

    const lists = Object.entries(tools) as [string, string[]][]
    expect(lists.length).toBeGreaterThan(1)
    for (const [namespace, list] of lists)
      for (const name of WITHHELD) expect(list, `${namespace} has ${name}`).not.toContain(name)
    // The heuristic would have bucketed them under these.
    for (const ns of ['query', 'execute', 'tables', 'describe', 'connect', 'connection', 'current'])
      expect(tools).not.toHaveProperty(ns)
  })

  it("are not in the planner's or a loop controller's catalog, even when the allowlist names them", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { createPlannerAdapter, createLoopControllerAdapter } =
      await import('@hames-ai/harness-baml/baml-adapters.server')

    await createPlannerAdapter([...KEPT, ...WITHHELD])('list the tables', 'list tables')
    await createLoopControllerAdapter()({
      userMessage: 'list the tables',
      intent: 'list tables',
      tools: ['read_neo4j_cypher', ...WITHHELD],
      turns: [],
      turn: 0,
    })

    const planned = (mockPlanner.mock.calls[0][2] as { name: string }[]).map((t) => t.name)
    expect(planned).toEqual(KEPT)
    const advertised = (mockLoopController.mock.calls[0][2] as { name: string }[]).map(
      (t) => t.name,
    )
    expect(advertised).toEqual(['read_neo4j_cypher'])
  })

  it('warn once, naming the decision and what to remove at the gateway', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { listTools } = await import('@hames-ai/harness-patterns/mcp-client.server')

    await listTools()
    await listTools()

    const drops = warn.mock.calls.filter((c) => String(c[0]).includes('query_database'))
    expect(drops).toHaveLength(1)
    for (const name of WITHHELD) expect(drops[0][0]).toContain(name)
    expect(drops[0][0]).toContain('no Postgres access')
    expect(drops[0][0]).toContain('remove `database-server`')
    expect(drops[0][0]).toContain(
      'docker compose run --rm mcp-config && docker compose up -d --no-deps --force-recreate mcp-gateway',
    )
    expect(drops[0][0]).not.toMatch(/restart/)
    // Its own warning: not folded into the Neo4j one, which names another switch.
    expect(drops[0][0]).not.toContain('read_only')
  })

  it('warn about nothing when the gateway serves no database-server', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockListTools.mockResolvedValue(gatewayListing(KEPT))
    const { listTools } = await import('@hames-ai/harness-patterns/mcp-client.server')

    expect((await listTools()).map((t) => t.name)).toEqual(KEPT)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('no shipped agent hands a Postgres tool to any pattern', () => {
  async function shippedAgents(): Promise<AgentDefinition[]> {
    const mod = (await import('@hames-ai/agents/agents')) as Record<string, unknown>
    return Object.values(mod).filter(
      (v): v is AgentDefinition =>
        typeof v === 'object' && v !== null && 'createPatterns' in v && 'id' in v,
    )
  }

  it('builds every agent against the regressed gateway and checks each tool list it hands out', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const agents = await shippedAgents()
    // The five registered today. A new agent lands in this list by export,
    // without an edit here.
    expect(agents.map((a) => a.id).sort()).toEqual(
      expect.arrayContaining(['general', 'microsoft-365', 'retriever', 'sandbox', 'search']),
    )

    for (const agent of agents) {
      const before = handed.length
      await agent.createPatterns(`no-pg-${agent.id}`, testAgentDeps)
      const lists = handed.slice(before)
      expect(lists.length, `${agent.id} built no tool-taking pattern`).toBeGreaterThan(0)
      for (const { factory, tools } of lists)
        for (const name of WITHHELD)
          expect(tools, `${agent.id} → ${factory} holds ${name}`).not.toContain(name)
    }

    // Not vacuous: `general` hands its planner and its loop the whole gateway
    // surface, so the listing above did reach the agents.
    const general = handed.filter((h) => h.factory === 'planner' || h.factory === 'simpleLoop')
    expect(general.some((h) => KEPT.every((t) => h.tools.includes(t)))).toBe(true)
  })
})

describe('a loop whose allowlist names a Postgres tool still cannot call it', () => {
  const context = () => ({
    sessionId: 'hand-written',
    createdAt: Date.now(),
    events: [
      {
        type: 'user_message' as const,
        ts: 1,
        patternId: 'harness',
        data: { content: 'How many conversations are stored?' },
      },
    ],
    status: 'running' as const,
    data: {},
    input: 'How many conversations are stored?',
  })

  const action = (tool_name: string, tool_args: string) => ({
    reasoning: 'r',
    tool_name,
    tool_args,
    status: 'Working',
    is_final: false,
  })

  /** What the gateway was actually asked to run. */
  const sentToGateway = () => mockCallTool.mock.calls.map(([c]) => (c as { name: string }).name)

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mockCallTool.mockResolvedValue({ content: [{ type: 'text', text: '[{"n":1}]' }] })
  })

  it('simpleLoop: advertises no Postgres tool and refuses the call', async () => {
    const { simpleLoop } = await import('@hames-ai/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('@hames-ai/harness-patterns/context.server')
    const { createEventView } = await import('@hames-ai/harness-patterns/patterns')
    const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')

    const controller = vi.fn(async () => ({
      action: action('execute_sql', '{"sql":"SELECT count(*) FROM conversations"}'),
      llmCall: undefined,
    }))
    const pattern = simpleLoop(controller, ['read_neo4j_cypher', 'execute_sql'], {
      patternId: 'hand-written',
    })

    const result = await withRunFrame({}, () =>
      pattern.fn(createScope('hand-written', {}), createEventView(context())),
    )

    const input = (controller.mock.calls[0] as unknown as [ControllerInput])[0]
    expect(input.tools).toEqual(['read_neo4j_cypher'])
    expect(sentToGateway()).not.toContain('execute_sql')
    // Since #437 the first refusal is fed back as a recovery; the second in a
    // row reaches the consecutive-recovery cap and ends the loop with it.
    const refusal =
      'Tool not allowed: execute_sql (withheld from every agent). Allowed: read_neo4j_cypher'
    const recoveries = result.events.filter((e) => e.type === 'loop_recovery')
    expect(recoveries.map((e) => e.data)).toEqual([
      expect.objectContaining({ failure: 'tool_not_allowed', error: refusal }),
    ])
    const errors = result.events.filter((e) => e.type === 'error')
    expect(errors).toHaveLength(1)
    expect(errors[0].data).toMatchObject({ kind: 'recovery_exhausted', error: refusal })
  })

  it('actorCritic: a dynamicToolPattern that matches everything does not hand one back', async () => {
    const { actorCritic } = await import('@hames-ai/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('@hames-ai/harness-patterns/context.server')
    const { createEventView } = await import('@hames-ai/harness-patterns/patterns')
    const { withRunFrame } = await import('@hames-ai/harness-patterns/run-frame.server')

    const actor = vi.fn(async () => ({
      action: action('mcp__hames-mcp-gateway__query_database', '{"query":"SELECT 1"}'),
      llmCall: undefined,
    }))
    const critic = vi.fn(async () => ({
      result: { is_sufficient: true, explanation: 'ok' },
      llmCall: undefined,
    }))
    const pattern = actorCritic(actor, critic, ['read_neo4j_cypher'], {
      patternId: 'dynamic-actor',
      maxRetries: 1,
      dynamicToolPattern: /.*/,
    })

    const result = await withRunFrame({}, () =>
      pattern.fn(createScope('dynamic-actor', {}), createEventView(context())),
    )

    expect(sentToGateway()).toEqual([])
    // Since #437 the refusal is a `loop_recovery` the actor reads in its
    // attempt log, not an `error`.
    const recoveries = result.events
      .filter((e) => e.type === 'loop_recovery')
      .map((e) => String((e.data as { error: string }).error))
    expect(recoveries).toContain(
      'Tool not allowed: mcp__hames-mcp-gateway__query_database (withheld from every agent)',
    )
  })
})
