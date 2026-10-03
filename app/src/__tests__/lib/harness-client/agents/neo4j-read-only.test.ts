// The composition root registers the harness client seam (tier policy, model
// tables); every adapter below runs through it as a production turn does.
import '../../../../lib/inference/config.server'
// The guards `search` and `retriever` declare resolve their namespaces through
// THIS deployment's catalog, registered at boot in production.
import '../../../mocks/namespace-catalog'
/**
 * A write-shaped request to an agent that reaches Neo4j ends in an answer, not
 * in an error (#401, #403).
 *
 * Owner decision, 2026-10-03: agents are read-only against Neo4j, `general`
 * included. Before this, a write-shaped turn on a read-only gateway broke two
 * ways, and both ended the loop on an error event rather than an answer:
 *
 *   - the shipped Neo4j few-shots demonstrate `write_neo4j_cypher`; a controller
 *     that copied the example named a tool outside the allowlist, and the loop
 *     broke on "Tool not allowed" (#401);
 *   - a controller told nothing about why it holds no write tool reaches for
 *     one from memory, with the same result.
 *
 * Each agent's real `createPatterns` runs one whole turn here. The gateway
 * listing is the REGRESSION case — `neo4j-cypher` served with `read_only:
 * false`, offering the write tool and executing it if called — so all three
 * guards are under test at once: the catalog withholding the tool
 * (`listTools`), the loop showing no example of it (`simpleLoop`'s few-shot
 * filter), and the context telling the controller the graph is read-only
 * (`NEO4J_READ_ONLY_CONTEXT`).
 *
 * The controller is a scripted stand-in with the habits that broke the turn:
 * it copies a write example when it is shown one, reaches for the write tool
 * when nothing tells it the graph is read-only, and otherwise answers that it
 * can only read. Whether a REAL model answers that way is model behaviour and
 * is graded live by the eval suite's `controller-write-on-read-only`
 * (`app/evals/scenarios/controller.ts`); what this file proves is that every
 * agent hands its controller what that answer needs, and that the loop ends
 * cleanly when it is given.
 *
 * Only the MCP SDK and the generated BAML client are mocked. `listTools`,
 * `Tools`, `callTool`, the adapters, the patterns and the agent definitions are
 * the real modules.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mcpNamespace } from '@hames-ai/connectors/mcp-catalog'
import type { AgentData, AgentDefinition } from '@hames-ai/agents'
import type { ContextEvent } from '@hames-ai/harness-patterns'
import { testAgentDeps } from './test-deps'

vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

// Hoisted: the two side-effect imports at the top load the MCP client, so the
// SDK mock has to exist before any of this file's own top-level code runs.
const { WRITE, mockSdkCallTool, MockClient } = vi.hoisted(() => {
  const WRITE = 'write_neo4j_cypher'

  /** The gateway as a regressed config serves it: the write tool listed beside
   *  the reads, and the web tools the routed agents also hold. */
  const LISTING = [
    'get_neo4j_schema',
    'read_neo4j_cypher',
    WRITE,
    'search',
    'fetch',
    'fetch_content',
    'read_graph',
    'create_entities',
  ]

  const mockSdkCallTool = vi.fn(async ({ name }: { name: string }) => {
    const results: Record<string, unknown> = {
      get_neo4j_schema: { Concept: { name: 'STRING' } },
      read_neo4j_cypher: [{ name: 'Redis' }],
      // A read-write server executes the write — which is what makes a call
      // here a write to the graph rather than a refused one.
      [WRITE]: { nodes_created: 1 },
    }
    return { content: [{ type: 'text', text: JSON.stringify(results[name] ?? null) }] }
  })

  class MockClient {
    connect = vi.fn(async () => undefined)
    close = vi.fn(async () => undefined)
    callTool = mockSdkCallTool
    listTools = vi.fn(async () => ({
      tools: LISTING.map((name) => ({ name, description: `${name} tool`, inputSchema: {} })),
    }))
  }

  return { WRITE, mockSdkCallTool, MockClient }
})

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: MockClient }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({
  StreamableHTTPClientTransport: class {},
}))

const READ_ONLY_ANSWER = 'I can only read the knowledge graph, so nothing was added.'

interface FewShotArg {
  tool: string
  args: string
}

const action = (tool_name: string, tool_args: string, is_final = false) => ({
  reasoning: 'scripted',
  tool_name,
  tool_args,
  status: 'Working',
  is_final,
})

/**
 * `b.LoopController(user_message, intent, tools, turns, context,
 * turns_previous_runs, few_shots, …)` — positional, as the adapter calls it.
 */
const mockLoopController = vi.fn(async (...args: unknown[]) => {
  const turns = args[3] as unknown[]
  const context = args[4] as string | undefined
  const fewShots = args[6] as FewShotArg[] | undefined
  if (turns.length > 0) return action('Return', 'done', true)
  const writeExample = fewShots?.find((s) => s.tool.startsWith('write_'))
  if (writeExample) return action(writeExample.tool, writeExample.args)
  if (context?.includes('READ-ONLY')) return action('Return', READ_ONLY_ANSWER, true)
  return action(WRITE, JSON.stringify({ query: "MERGE (c:Concept {name: 'Stream Processing'})" }))
})

vi.mock('@hames-ai/harness-baml/baml_client', () => ({
  b: {
    LoopController: (...args: unknown[]) => mockLoopController(...args),
    Router: vi.fn(async () => ({
      intent: 'add Stream Processing to the graph',
      needs_tool: true,
      route: 'neo4j',
      response: 'Looking into that…',
    })),
    Planner: vi.fn(async () => ({
      reasoning: 'r',
      plan: '1. Add the concept to the graph.',
      n_steps: 1,
    })),
    Synthesize: vi.fn(async () => READ_ONLY_ANSWER),
  },
}))

const REQUEST = "Add 'Stream Processing' as a concept connected to Redis."

async function agents(): Promise<Record<string, AgentDefinition>> {
  const [search, retriever, general] = await Promise.all([
    import('@hames-ai/agents/agents/search.server'),
    import('@hames-ai/agents/agents/retriever-agent.server'),
    import('@hames-ai/agents/agents/general.server'),
  ])
  return {
    search: search.searchAgent,
    retriever: retriever.retrieverAgent,
    general: general.generalAgent,
  }
}

async function runTurn(agentId: string) {
  const { harness } = await import('@hames-ai/harness-patterns/harness.server')
  const agent = (await agents())[agentId]
  const patterns = await agent.createPatterns('s-read-only', {
    ...testAgentDeps,
    toolNamespaces: mcpNamespace,
  })
  const result = await harness<AgentData>(...patterns)(REQUEST, 's-read-only')
  return { result, events: result.context.events as ContextEvent[] }
}

const ofType = (events: ContextEvent[], type: string) => events.filter((e) => e.type === type)

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe.each(['search', 'retriever', 'general'])(
  '%s: a write-shaped request against a read-only graph',
  (agentId) => {
    it('ends in an answer, with no error event and nothing written', async () => {
      const { result, events } = await runTurn(agentId)

      expect(ofType(events, 'error').map((e) => e.data)).toEqual([])
      expect(result.status).not.toBe('error')
      expect(result.response).toBe(READ_ONLY_ANSWER)

      // Nothing reached the write tool: no call event, and no call on the wire.
      const calls = ofType(events, 'tool_call').map((e) => (e.data as { tool: string }).tool)
      expect(calls).not.toContain(WRITE)
      expect(mockSdkCallTool.mock.calls.map(([c]) => c.name)).not.toContain(WRITE)

      // The loop ended on the controller's own Return.
      const actions = ofType(events, 'controller_action').map(
        (e) => (e.data as { action: { tool_name: string } }).action.tool_name,
      )
      expect(actions).toEqual(['Return'])
    })

    it('hands the controller no write tool, no write example, and the read-only context', async () => {
      await runTurn(agentId)

      expect(mockLoopController).toHaveBeenCalledTimes(1)
      const [, , tools, , context, , fewShots] = mockLoopController.mock.calls[0]
      const advertised = (tools as { name: string }[]).map((t) => t.name)
      expect(advertised).toContain('read_neo4j_cypher')
      expect(advertised).not.toContain(WRITE)
      for (const shot of (fewShots as FewShotArg[] | undefined) ?? []) {
        expect(shot.tool).not.toBe(WRITE)
      }
      const { NEO4J_READ_ONLY_CONTEXT } =
        await import('@hames-ai/agents/agents/neo4j-fewshots.server')
      expect(context).toContain(NEO4J_READ_ONLY_CONTEXT)
    })
  },
)

describe.each(['search', 'retriever'])('%s: the Neo4j few-shots on a read-only loop', (agentId) => {
  it('are the two reads of the shipped set, with its write example filtered out', async () => {
    const { NEO4J_FEW_SHOTS_DEFAULT } =
      await import('@hames-ai/agents/agents/neo4j-fewshots.server')
    // The shipped set still carries the upsert; it is the loop that drops it.
    expect(NEO4J_FEW_SHOTS_DEFAULT.map((s) => s.tool)).toContain(WRITE)

    await runTurn(agentId)

    const fewShots = mockLoopController.mock.calls[0][6] as FewShotArg[]
    expect(fewShots).toEqual(NEO4J_FEW_SHOTS_DEFAULT.filter((s) => s.tool !== WRITE))
    expect(fewShots).toHaveLength(2)
  })
})
