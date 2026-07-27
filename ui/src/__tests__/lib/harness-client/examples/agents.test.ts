/**
 * Agent Harness Tests
 *
 * Tests for all agent harnesses in the examples directory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockFinalAction, mockCriticResult, mockAction } from '../../../mocks/baml'
import { mockCallTool, mockListTools, fixtures } from '../../../mocks/mcp'

// ============================================================================
// Mock Setup
// ============================================================================

const mockToolSets = {
  neo4j: ['read_neo4j_cypher', 'write_neo4j_cypher', 'get_neo4j_schema', 'Return'],
  web: ['search', 'fetch', 'fetch_content', 'Return'],
  memory: [
    'create_entities', 'create_relations', 'add_observations',
    'delete_entities', 'delete_relations', 'delete_observations',
    'open_nodes', 'search_nodes', 'read_graph', 'Return'
  ],
  github: [
    'get_issue', 'list_issues', 'create_issue', 'search_code',
    'search_repositories', 'get_pull_request', 'Return'
  ],
  context7: ['resolve-library-id', 'get-library-docs', 'Return'],
  filesystem: [
    'read_text_file', 'write_file', 'edit_file', 'list_directory',
    'directory_tree', 'search_files', 'search_files_content', 'Return'
  ],
  redis: ['get', 'set', 'hset', 'hget', 'expire', 'json_get', 'json_set', 'vector_search_hash', 'Return'],
  all: [] as string[]
}

mockToolSets.all = [
  ...new Set([
    ...mockToolSets.neo4j,
    ...mockToolSets.web,
    ...mockToolSets.memory,
    ...mockToolSets.github,
    ...mockToolSets.context7,
    ...mockToolSets.filesystem,
    ...mockToolSets.redis
  ])
]

// Mock assert.server for all harness files
vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn()
}))

// Create mocks that we can access and modify
const callToolMock = mockCallTool({
  responses: {
    get_neo4j_schema: { nodes: ['Person'], relationships: ['KNOWS'] },
    read_graph: { entities: [], relations: [] },
    json_get: { data: 'cached value' },
    hset: 'OK',
    expire: true,
    vector_search_hash: []
  }
})

// Mock MCP client
vi.mock('../../../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: callToolMock,
  listTools: mockListTools(mockToolSets.all)
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
      response: ''
    })),
    Synthesize: vi.fn(async () => 'Synthesized response')
  }
}))

// Mock Collector — must be a real class so `new Collector()` works
vi.mock('@boundaryml/baml', () => {
  class MockCollector {
    last = {
      rawLlmResponse: 'Raw response',
      usage: { inputTokens: 100, outputTokens: 50 },
      calls: [{ httpRequest: { body: {} } }]
    }
    constructor(_name?: string) {}
  }
  return { Collector: MockCollector }
})

// Mock Tools function
vi.mock('../../../../lib/harness-patterns/tools.server', () => ({
  Tools: vi.fn(async () => mockToolSets),
  ToolsFrom: vi.fn(async () => mockToolSets)
}))

// ============================================================================
// Helper Functions
// ============================================================================

interface AgentConfig {
  id: string
  name: string
  description: string
  icon: string
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
  const patterns = await config.createPatterns('test-session') as Pattern[]

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

// Mock scope factory
function createMockScope(data: Record<string, unknown> = {}) {
  return {
    id: 'test-scope',
    data: { input: 'test query', ...data },
    events: [] as unknown[],
  }
}

// Mock view factory
function createMockView() {
  return {
    fromLastPattern: () => ({
      ofType: () => ({
        get: () => [],
        first: () => null,
        last: () => null
      })
    }),
    lastUserMessage: () => 'test query',
    allEvents: () => []
  }
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
      const { defaultAgent } = await import('../../../../lib/harness-client/examples/default.server')
      validateAgentConfig(defaultAgent)
      expect(defaultAgent.id).toBe('default')
      expect(defaultAgent.servers).toContain('neo4j-cypher')
    })

    it('should create valid patterns', async () => {
      const { defaultAgent } = await import('../../../../lib/harness-client/examples/default.server')
      const patterns = await validatePatterns(defaultAgent)

      // Should have router and synthesizer
      const patternNames = patterns.map(p => p.name)
      expect(patternNames).toContain('router')
      expect(patternNames).toContain('synthesizer')
    })

    it('should have unique pattern IDs', async () => {
      const { defaultAgent } = await import('../../../../lib/harness-client/examples/default.server')
      const patterns = await defaultAgent.createPatterns('test-session') as Pattern[]
      const ids = patterns.map(p => p.config.patternId)
      const uniqueIds = new Set(ids)
      expect(uniqueIds.size).toBe(ids.length)
    })
  })

  describe('codeModeAgent', () => {
    it('should have valid config', async () => {
      const { codeModeAgent } = await import('../../../../lib/harness-client/examples/code-mode.server')
      validateAgentConfig(codeModeAgent)
      expect(codeModeAgent.id).toBe('code-mode')
    })

    it('should create patterns: router + routes(chain(loop, synth))', async () => {
      const { codeModeAgent } = await import('../../../../lib/harness-client/examples/code-mode.server')
      const patterns = await validatePatterns(codeModeAgent)

      const names = patterns.map(p => p.name)
      // Two top-level patterns: router + routes.
      expect(patterns.length).toBe(2)
      expect(names).toContain('router')
      // The routes name embeds the route key.
      expect(names.some(n => n.includes('code_mode'))).toBe(true)
    })
  })

  describe('sandboxSessionAgent', () => {
    it('should have valid config', async () => {
      const { sandboxSessionAgent } = await import('../../../../lib/harness-client/examples/sandbox-session.server')
      validateAgentConfig(sandboxSessionAgent)
      expect(sandboxSessionAgent.id).toBe('sandbox-session')
    })

    it('should create patterns: compactIntent → withSandbox(actorCritic) → synthesizer', async () => {
      const { sandboxSessionAgent } = await import('../../../../lib/harness-client/examples/sandbox-session.server')
      const patterns = await validatePatterns(sandboxSessionAgent)

      const names = patterns.map(p => p.name)
      expect(patterns.length).toBe(3)
      // #83: compactIntent runs first so the router-less actor gets a
      // self-contained brief instead of a bare back-reference.
      expect(names[0]).toBe('compactIntent')
      expect(patterns[0].config.patternId).toBe('sandbox-session-intent')
      expect(names[1]).toContain('withSandbox')
      expect(names[1]).toContain('actorCritic')
      expect(names[2]).toBe('synthesizer')
    })
  })

  describe('flavouredSandboxAgent', () => {
    it('should have valid config', async () => {
      const { flavouredSandboxAgent } = await import('../../../../lib/harness-client/examples/flavoured-sandbox.server')
      validateAgentConfig(flavouredSandboxAgent)
      expect(flavouredSandboxAgent.id).toBe('flavoured-sandbox')
    })

    it('should create patterns: router + routes(flavoured sandboxes) + synthesizer', async () => {
      const { flavouredSandboxAgent } = await import('../../../../lib/harness-client/examples/flavoured-sandbox.server')
      const patterns = await validatePatterns(flavouredSandboxAgent)

      const names = patterns.map(p => p.name)
      expect(patterns.length).toBe(3)
      expect(names).toContain('router')
      // The routes name embeds the route keys (basic|image_processing|data|office).
      expect(names.some(n => n.includes('routes') && n.includes('image_processing') && n.includes('office'))).toBe(true)
      expect(names[2]).toBe('synthesizer')
    })

    it('exposes the durable-workspace capability (persistent flavours use syncWorkspace)', async () => {
      const { flavouredSandboxAgent } = await import('../../../../lib/harness-client/examples/flavoured-sandbox.server')
      const { harnessUsesSyncWorkspace } = await import('../../../../lib/harness-patterns')
      const patterns = await flavouredSandboxAgent.createPatterns('test-session')
      expect(harnessUsesSyncWorkspace(patterns as Parameters<typeof harnessUsesSyncWorkspace>[0])).toBe(true)
    })
  })

  describe('conversationalMemoryAgent', () => {
    it('should have valid config', async () => {
      const { conversationalMemoryAgent } = await import('../../../../lib/harness-client/examples/conversational-memory.server')
      validateAgentConfig(conversationalMemoryAgent)
      expect(conversationalMemoryAgent.id).toBe('conversational-memory')
      expect(conversationalMemoryAgent.servers).toContain('memory')
    })

    it('should create valid patterns', async () => {
      const { conversationalMemoryAgent } = await import('../../../../lib/harness-client/examples/conversational-memory.server')
      const patterns = await validatePatterns(conversationalMemoryAgent)

      // Should include session tracker, router, memory writer, synthesizer
      expect(patterns.length).toBeGreaterThanOrEqual(4)
    })

    it('should include session tracking pattern', async () => {
      const { conversationalMemoryAgent } = await import('../../../../lib/harness-client/examples/conversational-memory.server')
      const patterns = await conversationalMemoryAgent.createPatterns('test-session') as Pattern[]
      const hasSessionTracker = patterns.some(p => p.config.patternId === 'session-tracker')
      expect(hasSessionTracker).toBe(true)
    })

    it('should execute session tracker pattern', async () => {
      const { conversationalMemoryAgent } = await import('../../../../lib/harness-client/examples/conversational-memory.server')
      const patterns = await conversationalMemoryAgent.createPatterns('test-session') as Pattern[]
      const sessionTracker = patterns.find(p => p.config.patternId === 'session-tracker')

      expect(sessionTracker).toBeDefined()

      const scope = createMockScope({ sessionId: 'test-session', turnCount: 0 })
      const view = createMockView()

      // Execute the pattern
      const result = await sessionTracker!.fn(scope, view)

      // Should have incremented turn count
      expect((result as typeof scope).data.turnCount).toBe(1)
    })

    it('should handle redis failure gracefully in session tracker', async () => {
      const { conversationalMemoryAgent } = await import('../../../../lib/harness-client/examples/conversational-memory.server')
      const patterns = await conversationalMemoryAgent.createPatterns('test-session') as Pattern[]
      const sessionTracker = patterns.find(p => p.config.patternId === 'session-tracker')

      // Make callTool fail for this test
      callToolMock.mockRejectedValueOnce(new Error('Redis not available'))

      const scope = createMockScope({ sessionId: 'test-session' })
      const view = createMockView()

      // Should not throw
      const result = await sessionTracker!.fn(scope, view)
      expect(result).toBeDefined()
    })
  })

  describe('multiSourceResearchAgent', () => {
    it('should have valid config', async () => {
      const { multiSourceResearchAgent } = await import('../../../../lib/harness-client/examples/multi-source-research.server')
      validateAgentConfig(multiSourceResearchAgent)
      expect(multiSourceResearchAgent.id).toBe('multi-source-research')
    })

    it('should create valid patterns', async () => {
      const { multiSourceResearchAgent } = await import('../../../../lib/harness-client/examples/multi-source-research.server')
      const patterns = await validatePatterns(multiSourceResearchAgent)

      // Should have parallel, judge, synthesizer
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
      const { multiSourceResearchAgent } = await import('../../../../lib/harness-client/examples/multi-source-research.server')
      const patterns = await multiSourceResearchAgent.createPatterns('test-session') as Pattern[]

      const judgePattern = patterns.find(p => p.config.patternId === 'quality-judge')
      expect(judgePattern).toBeDefined()
    })

    it('should have parallel research pattern', async () => {
      const { multiSourceResearchAgent } = await import('../../../../lib/harness-client/examples/multi-source-research.server')
      const patterns = await multiSourceResearchAgent.createPatterns('test-session') as Pattern[]

      const parallelPattern = patterns.find(p => p.config.patternId === 'parallel-research')
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
    const { defaultAgent } = await import('../../../../lib/harness-client/examples/default.server')
    const { codeModeAgent } = await import('../../../../lib/harness-client/examples/code-mode.server')
    const { conversationalMemoryAgent } = await import('../../../../lib/harness-client/examples/conversational-memory.server')
    const { multiSourceResearchAgent } = await import('../../../../lib/harness-client/examples/multi-source-research.server')

    const ids = [
      defaultAgent.id,
      codeModeAgent.id,
      conversationalMemoryAgent.id,
      multiSourceResearchAgent.id
    ]

    const uniqueIds = new Set(ids)
    expect(uniqueIds.size).toBe(ids.length)
  })

  it('all agents should contain synthesizer pattern', async () => {
    const { defaultAgent } = await import('../../../../lib/harness-client/examples/default.server')
    const { conversationalMemoryAgent } = await import('../../../../lib/harness-client/examples/conversational-memory.server')
    const { multiSourceResearchAgent } = await import('../../../../lib/harness-client/examples/multi-source-research.server')

    const agents = [
      defaultAgent,
      conversationalMemoryAgent,
      multiSourceResearchAgent
    ]

    for (const config of agents) {
      const patterns = await config.createPatterns('test-session') as Pattern[]
      // All agents should contain a synthesizer pattern somewhere in the chain
      const hasSynthesizer = patterns.some(p => p.name === 'synthesizer')
      expect(hasSynthesizer).toBe(true)
    }
  })
})
