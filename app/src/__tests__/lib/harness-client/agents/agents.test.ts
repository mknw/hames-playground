/**
 * Agent Harness Tests
 *
 * Tests for all agent harnesses in the agents directory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockFinalAction, mockCriticResult } from '../../../mocks/baml'
import { mockCallTool, mockListTools } from '../../../mocks/mcp'
import { AGENT_ACCENTS } from '../../../../lib/agent-palette'

// ============================================================================
// Mock Setup
// ============================================================================

const mockToolSets = {
  neo4j: ['read_neo4j_cypher', 'write_neo4j_cypher', 'get_neo4j_schema', 'Return'],
  web: ['search', 'fetch', 'fetch_content', 'Return'],
  memory: [
    'create_entities',
    'create_relations',
    'add_observations',
    'delete_entities',
    'delete_relations',
    'delete_observations',
    'open_nodes',
    'search_nodes',
    'read_graph',
    'Return',
  ],
  github: [
    'get_issue',
    'list_issues',
    'create_issue',
    'search_code',
    'search_repositories',
    'get_pull_request',
    'Return',
  ],
  context7: ['resolve-library-id', 'get-library-docs', 'Return'],
  filesystem: [
    'read_text_file',
    'write_file',
    'edit_file',
    'list_directory',
    'directory_tree',
    'search_files',
    'search_files_content',
    'Return',
  ],
  redis: [
    'get',
    'set',
    'hset',
    'hget',
    'expire',
    'json_get',
    'json_set',
    'vector_search_hash',
    'Return',
  ],
  all: [] as string[],
}

mockToolSets.all = [
  ...new Set([
    ...mockToolSets.neo4j,
    ...mockToolSets.web,
    ...mockToolSets.memory,
    ...mockToolSets.github,
    ...mockToolSets.context7,
    ...mockToolSets.filesystem,
    ...mockToolSets.redis,
  ]),
]

// Mock assert.server for all harness files
vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

// Create mocks that we can access and modify
const callToolMock = mockCallTool({
  responses: {
    get_neo4j_schema: { nodes: ['Person'], relationships: ['KNOWS'] },
    read_graph: { entities: [], relations: [] },
    json_get: { data: 'cached value' },
    hset: 'OK',
    expire: true,
    vector_search_hash: [],
  },
})

// Mock MCP client
vi.mock('../../../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: callToolMock,
  listTools: mockListTools(mockToolSets.all),
}))

// Mock BAML client
vi.mock('../../../../../baml_client', () => ({
  b: {
    LoopController: vi.fn(async () => mockFinalAction()),
    ActorController: vi.fn(async () => mockFinalAction()),
    Critic: vi.fn(async () => mockCriticResult()),
    Router: vi.fn(async () => ({
      intent: 'test',
      needs_tool: true,
      route: 'neo4j',
      response: '',
    })),
    Synthesize: vi.fn(async () => 'Synthesized response'),
  },
}))

// Mock Collector — must be a real class so `new Collector()` works
vi.mock('@boundaryml/baml', () => {
  class MockCollector {
    last = {
      rawLlmResponse: 'Raw response',
      usage: { inputTokens: 100, outputTokens: 50 },
      calls: [{ httpRequest: { body: {} } }],
    }
    constructor(_name?: string) {}
  }
  return { Collector: MockCollector }
})

// Mock Tools function
vi.mock('../../../../lib/harness-patterns/tools.server', () => ({
  Tools: vi.fn(async () => mockToolSets),
  ToolsFrom: vi.fn(async () => mockToolSets),
}))

// ============================================================================
// Helper Functions
// ============================================================================

interface AgentConfig {
  id: string
  name: string
  description: string
  icon: string
  accent: string
  servers: string[]
  createPatterns: (sessionId: string) => Promise<unknown[]>
}

function validateAgentConfig(config: AgentConfig) {
  expect(config.id).toBeDefined()
  expect(config.id).toMatch(/^[a-z0-9-]+$/)
  expect(config.name).toBeDefined()
  expect(config.name.length).toBeGreaterThan(0)
  expect(config.description).toBeDefined()
  expect(config.icon).toBeDefined()
  // Every agent must claim a real accent family — a typo'd token would
  // silently render zinc via accentColor()'s fallback.
  expect(Object.keys(AGENT_ACCENTS)).toContain(config.accent)
  expect(config.servers).toBeInstanceOf(Array)
  expect(config.createPatterns).toBeDefined()
  expect(typeof config.createPatterns).toBe('function')
}

interface Pattern {
  name: string
  fn: (scope: unknown, view: unknown) => Promise<unknown>
  config: { patternId?: string }
}

async function validatePatterns(config: AgentConfig): Promise<Pattern[]> {
  const patterns = (await config.createPatterns('test-session')) as Pattern[]

  expect(patterns).toBeInstanceOf(Array)
  expect(patterns.length).toBeGreaterThan(0)

  const patternIds = new Set<string>()

  for (const pattern of patterns) {
    expect(pattern.name).toBeDefined()
    expect(pattern.fn).toBeDefined()
    expect(pattern.config).toBeDefined()
    expect(pattern.config.patternId).toBeDefined()

    // Check for unique pattern IDs
    expect(patternIds.has(pattern.config.patternId!)).toBe(false)
    patternIds.add(pattern.config.patternId!)
  }

  return patterns
}

// ============================================================================
// Tests
// ============================================================================

describe('Agent Harnesses', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    vi.resetModules()
  })

  describe('defaultAgent', () => {
    it('should have valid config', async () => {
      const { defaultAgent } = await import('../../../../lib/harness-client/agents/default.server')
      validateAgentConfig(defaultAgent)
      expect(defaultAgent.id).toBe('default')
      expect(defaultAgent.servers).toContain('neo4j-cypher')
    })

    it('should create valid patterns', async () => {
      const { defaultAgent } = await import('../../../../lib/harness-client/agents/default.server')
      const patterns = await validatePatterns(defaultAgent)

      // Should have router and compactExecution
      const patternNames = patterns.map((p) => p.name)
      expect(patternNames).toContain('router')
      expect(patternNames).toContain('compactExecution')
    })

    it('should have unique pattern IDs', async () => {
      const { defaultAgent } = await import('../../../../lib/harness-client/agents/default.server')
      const patterns = (await defaultAgent.createPatterns('test-session')) as Pattern[]
      const ids = patterns.map((p) => p.config.patternId)
      const uniqueIds = new Set(ids)
      expect(uniqueIds.size).toBe(ids.length)
    })
  })

  describe('generalAgent', () => {
    it('should have valid config', async () => {
      const { generalAgent } = await import('../../../../lib/harness-client/agents/general.server')
      validateAgentConfig(generalAgent)
      expect(generalAgent.id).toBe('general')
      expect(generalAgent.servers).toContain('neo4j-cypher')
    })

    it('should create a planner → simpleLoop → compactExecution chain', async () => {
      const { generalAgent } = await import('../../../../lib/harness-client/agents/general.server')
      const patterns = await validatePatterns(generalAgent)

      expect(patterns.map((p) => p.name)).toEqual(['planner', 'simpleLoop', 'compactExecution'])
    })
  })

  describe('codeModeAgent', () => {
    it('should have valid config', async () => {
      const { codeModeAgent } =
        await import('../../../../lib/harness-client/agents/code-mode.server')
      validateAgentConfig(codeModeAgent)
      expect(codeModeAgent.id).toBe('code-mode')
    })

    it('should create patterns: router + routes(chain(loop, synth))', async () => {
      const { codeModeAgent } =
        await import('../../../../lib/harness-client/agents/code-mode.server')
      const patterns = await validatePatterns(codeModeAgent)

      const names = patterns.map((p) => p.name)
      // Two top-level patterns: router + routes.
      expect(patterns.length).toBe(2)
      expect(names).toContain('router')
      // The routes name embeds the route key.
      expect(names.some((n) => n.includes('code_mode'))).toBe(true)
    })
  })

  describe('sandboxSessionAgent', () => {
    it('should have valid config', async () => {
      const { sandboxSessionAgent } =
        await import('../../../../lib/harness-client/agents/sandbox-session.server')
      validateAgentConfig(sandboxSessionAgent)
      expect(sandboxSessionAgent.id).toBe('sandbox-session')
    })

    it('should create patterns: compactIntent → withSandbox(actorCritic) → compactExecution', async () => {
      const { sandboxSessionAgent } =
        await import('../../../../lib/harness-client/agents/sandbox-session.server')
      const patterns = await validatePatterns(sandboxSessionAgent)

      const names = patterns.map((p) => p.name)
      expect(patterns.length).toBe(3)
      // #83: compactIntent runs first so the router-less actor gets a
      // self-contained brief instead of a bare back-reference.
      expect(names[0]).toBe('compactIntent')
      expect(patterns[0].config.patternId).toBe('sandbox-session-intent')
      expect(names[1]).toContain('withSandbox')
      expect(names[1]).toContain('actorCritic')
      expect(names[2]).toBe('compactExecution')
    })
  })

  describe('flavouredSandboxAgent', () => {
    it('should have valid config', async () => {
      const { flavouredSandboxAgent } =
        await import('../../../../lib/harness-client/agents/flavoured-sandbox.server')
      validateAgentConfig(flavouredSandboxAgent)
      expect(flavouredSandboxAgent.id).toBe('flavoured-sandbox')
    })

    it('should create patterns: router + routes(flavoured sandboxes) + compactExecution', async () => {
      const { flavouredSandboxAgent } =
        await import('../../../../lib/harness-client/agents/flavoured-sandbox.server')
      const patterns = await validatePatterns(flavouredSandboxAgent)

      const names = patterns.map((p) => p.name)
      expect(patterns.length).toBe(3)
      expect(names).toContain('router')
      // The routes name embeds the route keys (basic|image_processing|data|office).
      expect(
        names.some(
          (n) => n.includes('routes') && n.includes('image_processing') && n.includes('office'),
        ),
      ).toBe(true)
      expect(names[2]).toBe('compactExecution')
    })

    it('exposes the durable-workspace capability (persistent flavours use syncWorkspace)', async () => {
      const { flavouredSandboxAgent } =
        await import('../../../../lib/harness-client/agents/flavoured-sandbox.server')
      const { harnessUsesSyncWorkspace } = await import('../../../../lib/harness-patterns')
      const patterns = await flavouredSandboxAgent.createPatterns('test-session')
      expect(
        harnessUsesSyncWorkspace(patterns as Parameters<typeof harnessUsesSyncWorkspace>[0]),
      ).toBe(true)
    })
  })

  describe('multiSourceResearchAgent', () => {
    it('should have valid config', async () => {
      const { multiSourceResearchAgent } =
        await import('../../../../lib/harness-client/agents/multi-source-research.server')
      validateAgentConfig(multiSourceResearchAgent)
      expect(multiSourceResearchAgent.id).toBe('multi-source-research')
    })

    it('should create valid patterns', async () => {
      const { multiSourceResearchAgent } =
        await import('../../../../lib/harness-client/agents/multi-source-research.server')
      const patterns = await validatePatterns(multiSourceResearchAgent)

      // Should have parallel, judge, compactExecution
      expect(patterns.length).toBe(3)
    })
  })
})

// ============================================================================
// Judge Evaluator Tests
// ============================================================================

describe('Judge Evaluators', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    vi.resetModules()
  })

  describe('multiSourceResearchAgent judgeEvaluator', () => {
    it('should have quality judge pattern', async () => {
      const { multiSourceResearchAgent } =
        await import('../../../../lib/harness-client/agents/multi-source-research.server')
      const patterns = (await multiSourceResearchAgent.createPatterns('test-session')) as Pattern[]

      const judgePattern = patterns.find((p) => p.config.patternId === 'quality-judge')
      expect(judgePattern).toBeDefined()
    })

    it('should have parallel research pattern', async () => {
      const { multiSourceResearchAgent } =
        await import('../../../../lib/harness-client/agents/multi-source-research.server')
      const patterns = (await multiSourceResearchAgent.createPatterns('test-session')) as Pattern[]

      const parallelPattern = patterns.find((p) => p.config.patternId === 'parallel-research')
      expect(parallelPattern).toBeDefined()
    })
  })
})

// ============================================================================
// Cross-Agent Tests
// ============================================================================

describe('Agent Consistency', () => {
  it('all agents should have unique IDs', async () => {
    // Import all agents statically
    const { defaultAgent } = await import('../../../../lib/harness-client/agents/default.server')
    const { codeModeAgent } = await import('../../../../lib/harness-client/agents/code-mode.server')
    const { sandboxSessionAgent } =
      await import('../../../../lib/harness-client/agents/sandbox-session.server')
    const { multiSourceResearchAgent } =
      await import('../../../../lib/harness-client/agents/multi-source-research.server')

    const ids = [
      defaultAgent.id,
      codeModeAgent.id,
      sandboxSessionAgent.id,
      multiSourceResearchAgent.id,
    ]

    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(ids.length)
  })

  it('all agents should contain compactExecution pattern', async () => {
    const { defaultAgent } = await import('../../../../lib/harness-client/agents/default.server')
    const { multiSourceResearchAgent } =
      await import('../../../../lib/harness-client/agents/multi-source-research.server')

    const agents = [defaultAgent, multiSourceResearchAgent]

    for (const config of agents) {
      const patterns = (await config.createPatterns('test-session')) as Pattern[]
      // All agents should contain a compactExecution pattern somewhere in the chain
      const hasCompactExecution = patterns.some((p) => p.name === 'compactExecution')
      expect(hasCompactExecution).toBe(true)
    }
  })
})

/**
 * SA-M1 — a compactExecution's `viewConfig` must not hide the user's question.
 *
 * `ViewConfig`'s pattern scope is IMPLICIT: declare `eventTypes` and nothing
 * else and you silently get `fromLast` — the immediately preceding pattern
 * only. The user's message is tracked at the harness level (patternId
 * 'harness'), so it was filtered out and `Synthesize` ran with an empty
 * USER MESSAGE: the answer-writer had the tool results but not the question.
 * `general.server.ts` is the shape the others now follow.
 */
describe('compactExecution view scope — the user message must survive', () => {
  interface Node {
    name: string
    config: { patternId?: string; viewConfig?: Record<string, unknown> }
    children?: Node[]
  }

  /** Depth-first walk — the synth can sit inside routes(chain(...)). */
  function findSynth(nodes: Node[]): Node | undefined {
    for (const n of nodes) {
      if (n.name === 'compactExecution') return n
      const inner = n.children ? findSynth(n.children) : undefined
      if (inner) return inner
    }
    return undefined
  }

  async function synthOf(agentId: 'sandbox-session' | 'code-mode'): Promise<Node> {
    // Static imports: a template-literal specifier defeats Vite's analysis.
    const agent =
      agentId === 'sandbox-session'
        ? (await import('../../../../lib/harness-client/agents/sandbox-session.server'))
            .sandboxSessionAgent
        : (await import('../../../../lib/harness-client/agents/code-mode.server')).codeModeAgent
    const patterns = (await agent.createPatterns('test-session')) as unknown as Node[]
    const synth = findSynth(patterns)
    expect(synth, `no compactExecution found in ${agentId}`).toBeDefined()
    return synth!
  }

  /** The question, as the harness records it, plus one loop event beside it. */
  function ctxWith(loopPatternId: string) {
    return {
      sessionId: 'sess',
      createdAt: 1,
      events: [
        { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'why is it slow?' } },
        { type: 'pattern_enter', ts: 2, patternId: loopPatternId, data: {} },
        {
          type: 'tool_result',
          ts: 3,
          patternId: loopPatternId,
          data: { tool: 'run', success: true, result: 'ok' },
        },
      ] as never,
      status: 'running' as const,
      data: {},
      input: 'why is it slow?',
    }
  }

  it.each([
    ['sandbox-session', 'sandbox-session-loop'],
    ['code-mode', 'code-mode-loop'],
  ] as const)('%s: the synth still sees the question', async (agentId, loopId) => {
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')
    const synth = await synthOf(agentId)

    // Mirrors compactExecution's own read: `view.fromAll().ofType('user_message')`.
    const view = createEventView(ctxWith(loopId), synth.config.viewConfig, synth.config.patternId)
    const msg = view.fromAll().ofType('user_message').last(1).get()[0]

    expect((msg?.data as { content?: string })?.content).toBe('why is it slow?')
    // 'harness' has to be named explicitly — the default scope is what hid it.
    expect(synth.config.viewConfig?.fromPatterns).toContain('harness')
    expect(synth.config.viewConfig?.fromPatterns).toContain(loopId)
    // ...and the loop's own events are still in scope, or there is nothing to
    // synthesize from.
    expect(view.fromAll().ofType('tool_result').count()).toBe(1)
  })
})
