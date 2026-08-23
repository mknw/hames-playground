/**
 * Evaluator and Rail Tests
 *
 * Tests for the internal evaluator functions and custom rails
 * defined within agent harnesses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockFinalAction, mockCriticResult } from '../../../mocks/baml'
import { mockCallTool, mockListTools } from '../../../mocks/mcp'

// ============================================================================
// Mock Setup
// ============================================================================

const mockToolSets = {
  neo4j: ['read_neo4j_cypher', 'write_neo4j_cypher', 'get_neo4j_schema', 'Return'],
  web: ['search', 'fetch', 'fetch_content', 'Return'],
  memory: ['create_entities', 'read_graph', 'Return'],
  github: ['search_code', 'Return'],
  context7: ['resolve-library-id', 'get-library-docs', 'Return'],
  filesystem: ['read_text_file', 'write_file', 'edit_file', 'Return'],
  redis: ['hset', 'expire', 'Return'],
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
// Helper Types
// ============================================================================

// ============================================================================
// Multi-Source Research Evaluator Tests
// ============================================================================

describe('Multi-Source Research judgeEvaluator', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    vi.resetModules()
  })

  it('should create parallel research with three sources', async () => {
    const { multiSourceResearchAgent } =
      await import('../../../../lib/harness-client/agents/multi-source-research.server')
    const patterns = await multiSourceResearchAgent.createPatterns('test-session')

    const parallelPattern = patterns.find(
      (p) => (p as { config: { patternId?: string } }).config.patternId === 'parallel-research',
    )
    expect(parallelPattern).toBeDefined()
  })

  it('should use quality judge for ranking', async () => {
    const { multiSourceResearchAgent } =
      await import('../../../../lib/harness-client/agents/multi-source-research.server')
    const patterns = await multiSourceResearchAgent.createPatterns('test-session')

    const judgePattern = patterns.find(
      (p) => (p as { config: { patternId?: string } }).config.patternId === 'quality-judge',
    )
    expect(judgePattern).toBeDefined()
  })

  it('should have compactExecution for final response', async () => {
    const { multiSourceResearchAgent } =
      await import('../../../../lib/harness-client/agents/multi-source-research.server')
    const patterns = await multiSourceResearchAgent.createPatterns('test-session')

    const synthPattern = patterns.find(
      (p) => (p as { config: { patternId?: string } }).config.patternId === 'research-synth',
    )
    expect(synthPattern).toBeDefined()
    expect((synthPattern as { name: string }).name).toBe('compactExecution')
  })
})
