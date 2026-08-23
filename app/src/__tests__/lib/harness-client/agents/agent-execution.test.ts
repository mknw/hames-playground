/**
 * Agent Execution Tests
 *
 * Tests that actually execute patterns and evaluator functions
 * to achieve full code coverage.
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

// Mock assert.server
vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

// MCP mock
const callToolMock = mockCallTool({
  responses: {
    get_neo4j_schema: { nodes: ['Person'], relationships: ['KNOWS'] },
    read_graph: {
      entities: [
        { name: 'Class1', entityType: 'Class' },
        { name: 'Class2', entityType: 'Class' },
      ],
      relations: [],
    },
  },
})

vi.mock('../../../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: callToolMock,
  listTools: mockListTools(mockToolSets.all),
}))

// BAML mock
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

vi.mock('../../../../lib/harness-patterns/tools.server', () => ({
  Tools: vi.fn(async () => mockToolSets),
  ToolsFrom: vi.fn(async () => mockToolSets),
}))

// ============================================================================
// Helper Types
// ============================================================================

interface Pattern {
  name: string
  fn: (scope: unknown, view: unknown) => Promise<unknown>
  config: { patternId?: string }
}

interface Scope {
  id: string
  data: Record<string, unknown>
  events: unknown[]
}

interface ToolResultEvent {
  type: 'tool_result'
  ts: number
  patternId: string
  data: unknown
}

function createMockScope(data: Record<string, unknown> = {}): Scope {
  return {
    id: 'test-scope',
    data: { input: 'test query about react hooks', ...data },
    events: [],
  }
}

function createMockViewWithCandidates(candidates: Array<{ patternId: string; data: unknown }>) {
  const events: ToolResultEvent[] = candidates.map((c, i) => ({
    type: 'tool_result' as const,
    ts: Date.now() + i,
    patternId: c.patternId,
    data: c.data,
  }))

  return {
    fromAll: () => ({
      ofType: (type: string) => ({
        get: () => (type === 'tool_result' ? events : []),
      }),
    }),
    fromLastPattern: () => ({
      ofType: () => ({
        get: () => [],
        first: () => null,
        last: () => null,
      }),
    }),
    lastUserMessage: () => 'test query about react hooks',
    allEvents: () => events,
  }
}

// ============================================================================
// Multi-Source Research Evaluator Execution Tests
// ============================================================================

describe('Multi-Source Research Evaluator Execution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterEach(async () => {
    vi.resetModules()
  })

  it('should score based on content length and relevance', async () => {
    const { multiSourceResearchAgent } =
      await import('../../../../lib/harness-client/agents/multi-source-research.server')
    const patterns = (await multiSourceResearchAgent.createPatterns('test-session')) as Pattern[]
    const judgePattern = patterns.find((p) => p.config.patternId === 'quality-judge')!

    const scope = createMockScope({ input: 'python flask tutorial' })
    const view = createMockViewWithCandidates([
      {
        patternId: 'web-search',
        // >100 chars and contains query terms
        data: 'This is a comprehensive python flask tutorial that covers all the basics of python and flask. It includes many examples and code snippets for learning flask development.',
      },
      {
        patternId: 'github-search',
        // <100 chars
        data: 'Short content',
      },
    ])

    await judgePattern.fn(scope, view)

    const rankings = (scope as Scope).data.rankings as Array<{
      source: string
      score: number
      reason: string
    }>
    expect(rankings).toBeDefined()
    expect(rankings.length).toBe(2)
    // Web search should score higher
    expect(rankings[0].score).toBeGreaterThan(rankings[1].score)
  })

  it('should handle candidates with only content length', async () => {
    const { multiSourceResearchAgent } =
      await import('../../../../lib/harness-client/agents/multi-source-research.server')
    const patterns = (await multiSourceResearchAgent.createPatterns('test-session')) as Pattern[]
    const judgePattern = patterns.find((p) => p.config.patternId === 'quality-judge')!

    const scope = createMockScope({ input: 'xyz123' }) // No matching terms
    const view = createMockViewWithCandidates([
      {
        patternId: 'web-search',
        data: 'a'.repeat(150), // >100 chars but no relevant terms
      },
    ])

    await judgePattern.fn(scope, view)

    const rankings = (scope as Scope).data.rankings as Array<{ source: string; reason: string }>
    expect(rankings).toBeDefined()
    expect(rankings[0].reason).toContain('substantial')
  })

  it('should give correct reason for limited content', async () => {
    const { multiSourceResearchAgent } =
      await import('../../../../lib/harness-client/agents/multi-source-research.server')
    const patterns = (await multiSourceResearchAgent.createPatterns('test-session')) as Pattern[]
    const judgePattern = patterns.find((p) => p.config.patternId === 'quality-judge')!

    const scope = createMockScope({ input: 'test' })
    const view = createMockViewWithCandidates([
      {
        patternId: 'web-search',
        data: 'short', // <100 chars
      },
    ])

    await judgePattern.fn(scope, view)

    const rankings = (scope as Scope).data.rankings as Array<{ source: string; reason: string }>
    expect(rankings).toBeDefined()
    expect(rankings[0].reason).toBe('Limited content')
  })

  it('should select best candidate', async () => {
    const { multiSourceResearchAgent } =
      await import('../../../../lib/harness-client/agents/multi-source-research.server')
    const patterns = (await multiSourceResearchAgent.createPatterns('test-session')) as Pattern[]
    const judgePattern = patterns.find((p) => p.config.patternId === 'quality-judge')!

    const scope = createMockScope({ input: 'test query' })
    const goodContent =
      'This is a substantial test query response with lots of relevant test content about the query topic.'
    const view = createMockViewWithCandidates([
      { patternId: 'web-search', data: 'short' },
      { patternId: 'github-search', data: goodContent },
    ])

    await judgePattern.fn(scope, view)

    // Best should be github-search
    expect((scope as Scope).data.response).toBeDefined()
  })
})
