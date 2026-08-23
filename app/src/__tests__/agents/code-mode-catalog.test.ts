/**
 * Code Mode Agent — up-front ENABLED SERVERS catalog (Theme 1).
 *
 * The actor must see the enabled servers' REAL names on turn 0 so it scopes
 * `code-mode {servers:[...]}` directly instead of guessing via mcp-find /
 * tripping mcp-add's secret check (see .harness-logs/context-neo4j-*.json).
 *
 * Isolated from code-mode.test.ts so this file can mock getServerCatalog's
 * deps (listTools + tools.server.inferServer) without disturbing that file's
 * delicate actor/critic queues. getServerCatalog reads the real committed
 * configs (custom-catalog.yaml / mcp-config.yaml) for the server names.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAction, mockCriticResult } from '../mocks/baml'
import { mockCallTool, mockListTools } from '../mocks/mcp'

const META = ['mcp-find', 'mcp-add', 'code-mode', 'mcp-exec']
const NEO4J = ['read_neo4j_cypher', 'write_neo4j_cypher', 'get_neo4j_schema']
const mockToolSets = { code: [...META], all: [...META] }

vi.mock('../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const callToolMock = mockCallTool({
  responses: { 'code-mode': { tool_name: 'code-mode-x' } },
})

vi.mock('../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: callToolMock,
  // Live universe getServerCatalog + filterToolDescriptions see.
  listTools: mockListTools([...NEO4J, ...META]),
}))

const actorController = vi.fn()
const critic = vi.fn()
const router = vi.fn()
const synthesize = vi.fn()

vi.mock('../../../baml_client', () => ({
  b: {
    LoopController: vi.fn(),
    ActorController: actorController,
    Critic: critic,
    Router: router,
    Synthesize: synthesize,
    ResultDescribe: vi.fn(async () => ''),
  },
}))

vi.mock('@boundaryml/baml', () => {
  class MockCollector {
    last = {
      rawLlmResponse: 'raw',
      usage: { inputTokens: 10, outputTokens: 5 },
      calls: [{ httpRequest: { body: {} } }],
    }
    constructor(_name?: string) {}
  }
  class BamlValidationError extends Error {}
  return { Collector: MockCollector, BamlValidationError }
})

// inferServer is trivial here — the neo4j tools resolve via the real
// custom-catalog declared-tools index, not the namespace bridge.
vi.mock('../../lib/harness-patterns/tools.server', () => ({
  Tools: vi.fn(async () => mockToolSets),
  ToolsFrom: vi.fn(() => mockToolSets),
  inferServer: (n: string) => n,
}))

// No persisted selection → contextProvider takes the preset path (which
// includes neo4j-cypher).
vi.mock('../../lib/harness-client/session.server', () => ({
  loadSession: vi.fn(async () => null),
}))
vi.mock('../../lib/harness-client/request-user.server', () => ({
  getRequestUserId: vi.fn(() => null),
  runWithUserId: (_uid: string, fn: () => Promise<unknown>) => fn(),
  getRequestSessionId: vi.fn(() => null),
  runWithRequestContext: (_c: unknown, fn: () => Promise<unknown>) => fn(),
}))

describe('code-mode agent — up-front ENABLED SERVERS catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    router.mockResolvedValue({
      intent: 'query neo4j',
      needs_tool: true,
      route: 'code_mode',
      response: '',
    })
    actorController.mockResolvedValue(
      mockAction({
        reasoning: 'Scope a code-mode tool to neo4j-cypher.',
        tool_name: 'code-mode',
        tool_args: JSON.stringify({ name: 'x', servers: ['neo4j-cypher'] }),
      }),
    )
    critic.mockResolvedValue(mockCriticResult({ is_sufficient: true }))
    synthesize.mockResolvedValue('done')
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('folds the enabled-servers catalog (real names) into the actor context', async () => {
    const { codeModeAgent } = await import('../../lib/harness-client/agents/code-mode.server')
    const { harness } = await import('../../lib/harness-patterns/harness.server')

    const patterns = await codeModeAgent.createPatterns('test-session')
    const agent = harness(...patterns)
    await agent('Fetch the 3 most connected nodes in the neo4j db.')

    expect(actorController).toHaveBeenCalled()
    // ActorController(user_message, intent, tools, attempts, context, …) → ctx is arg[4].
    const context = actorController.mock.calls[0][4] as string
    expect(context).toContain('ENABLED SERVERS')
    // Real gateway server name + a tool, not the `neo4j` namespace.
    expect(context).toContain('neo4j-cypher')
    expect(context).toContain('read_neo4j_cypher')
  })

  it('usesCodeMode detects the real (nested) code-mode pattern graph', async () => {
    // Exercises the real combinators (router → routes → chain) populating
    // `children` + the actorCritic loop's `dynamicToolPattern` marker. This is
    // what `agentUsesCodeMode` (registry) runs to keep the Tools panel active.
    const { codeModeAgent } = await import('../../lib/harness-client/agents/code-mode.server')
    const { usesCodeMode } = await import('../../lib/harness-patterns/pattern-capabilities')

    const patterns = await codeModeAgent.createPatterns('test-session')
    expect(usesCodeMode(patterns)).toBe(true)
  })
})
