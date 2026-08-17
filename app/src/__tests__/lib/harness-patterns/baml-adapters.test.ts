/**
 * BAML Adapters Tests
 *
 * Tests for controller and critic adapters that bridge patterns with BAML.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import { mockFinalAction, mockCriticResult } from '../../mocks/baml'
import { mockListTools } from '../../mocks/mcp'

// These tests target the production mixed-provider fallback chain in
// `baml_src/clients.baml` (RouterFallback / ControllerFallback / etc.) and
// assert behavior like "fall back to GroqGPT120B on BamlValidationError".
// The runtime default is Anthropic-only routing (see `clients.server.ts`),
// which short-circuits the manual Groq fallback — so the tests must opt
// back into the mixed chain explicitly.
beforeAll(() => {
  process.env.USE_MIXED_CHAINS = '1'
})
afterAll(() => {
  delete process.env.USE_MIXED_CHAINS
})

// Mock server-only imports
vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

// Mock MCP listTools
vi.mock('../../../lib/harness-patterns/mcp-client.server', () => ({
  listTools: mockListTools(['read_neo4j_cypher', 'write_neo4j_cypher', 'Return']),
}))

// Mock BAML client
const mockLoopController = vi.fn()
const mockActorController = vi.fn()
const mockCritic = vi.fn()
const mockResultDescribe = vi.fn()
const mockResultDescribeBatch = vi.fn()
const mockPlanner = vi.fn()

vi.mock('../../../../baml_client', () => ({
  b: {
    LoopController: mockLoopController,
    ActorController: mockActorController,
    Critic: mockCritic,
    ResultDescribe: (...args: unknown[]) => mockResultDescribe(...args),
    ResultDescribeBatch: (...args: unknown[]) => mockResultDescribeBatch(...args),
    Planner: (...args: unknown[]) => mockPlanner(...args),
  },
}))

describe('createLoopControllerAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoopController.mockResolvedValue(mockFinalAction())
  })

  it('should create a controller function', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createLoopControllerAdapter(['read_neo4j_cypher', 'Return'])
    expect(controller).toBeDefined()
    expect(typeof controller).toBe('function')
  })

  it('should return action and llmCall data', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createLoopControllerAdapter(['read_neo4j_cypher', 'Return'])

    const result = await controller('user message', 'intent', '[]', 0)

    expect(result.action).toBeDefined()
    expect(result.action.is_final).toBe(true)
  })

  it('should call LoopController with correct parameters', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createLoopControllerAdapter(
      ['read_neo4j_cypher', 'Return'],
      'Custom context',
    )

    await controller('user message', 'test intent', '[]', 0)

    expect(mockLoopController).toHaveBeenCalled()
    const [userMsg, intent] = mockLoopController.mock.calls[0]
    expect(userMsg).toBe('user message')
    expect(intent).toBe('test intent')
  })

  it('should pass contextPrefix as context when no schema', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createLoopControllerAdapter(['Return'], 'Domain instructions here')

    await controller('msg', 'intent', '[]', 0)

    // context is 5th arg to LoopController
    const [, , , , context] = mockLoopController.mock.calls[0]
    expect(context).toBe('Domain instructions here')
  })

  it('should combine contextPrefix and schema in context', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createLoopControllerAdapter(['Return'], 'Domain instructions')

    // schema is the 5th arg to the controller adapter
    await controller('msg', 'intent', '[]', 0, 'Node: Person, Company')

    const [, , , , context] = mockLoopController.mock.calls[0]
    expect(context).toContain('Domain instructions')
    expect(context).toContain('GRAPH SCHEMA:')
    expect(context).toContain('Node: Person, Company')
  })

  it('sends planContext as its own BAML argument, never merged into context (#27)', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createLoopControllerAdapter(['Return'], 'Domain instructions')

    // planContext is the 10th (trailing, optional) arg — appended, never
    // inserted, so existing positional args keep their slots.
    await controller(
      'msg',
      'intent',
      '[]',
      0,
      'Node: Person',
      undefined,
      undefined,
      undefined,
      undefined,
      'PLAN (from previous step):\n1. Look it up.',
    )

    const [, , , , context, , , , planContext] = mockLoopController.mock.calls[0]
    // `context` is the agent-static half and sits inside the prompt's tier-1
    // cache marker: a per-question plan in there re-writes the tool-catalog
    // cache on every run (#122). It must carry ONLY schema + contextPrefix.
    expect(context).toContain('Domain instructions')
    expect(context).toContain('GRAPH SCHEMA:')
    expect(context).not.toContain('PLAN (from previous step)')
    // The plan rides its own parameter, which the prompt renders in tier 2.
    expect(planContext).toContain('PLAN (from previous step)')
  })

  it('should pass undefined context when neither contextPrefix nor schema', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createLoopControllerAdapter(['Return'])

    await controller('msg', 'intent', '[]', 0)

    const [, , , , context] = mockLoopController.mock.calls[0]
    expect(context).toBeUndefined()
  })
})

describe('createActorControllerAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockActorController.mockResolvedValue(mockFinalAction())
  })

  it('should create a controller function', async () => {
    const { createActorControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createActorControllerAdapter(['code-mode', 'Return'])
    expect(controller).toBeDefined()
    expect(typeof controller).toBe('function')
  })

  it('should return action and llmCall data', async () => {
    const { createActorControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createActorControllerAdapter(['code-mode', 'Return'])

    const result = await controller('user message', 'intent', ['code-mode'], [])

    expect(result.action).toBeDefined()
    expect(result.action.is_final).toBe(true)
  })

  it('should prepend planContext ahead of its own contextPrefix (#27)', async () => {
    const { createActorControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createActorControllerAdapter({
      toolNames: ['code-mode'],
      contextPrefix: 'Factory protocol notes',
    })

    await controller(
      'msg',
      'intent',
      ['code-mode'],
      [],
      undefined,
      1,
      3,
      undefined,
      'PLAN (from previous step):\n1. Write the script.',
    )

    // context is the 5th arg to ActorController
    const [, , , , context] = mockActorController.mock.calls[0]
    expect(context.indexOf('PLAN')).toBeLessThan(context.indexOf('Factory protocol notes'))
  })
})

describe('createPlannerAdapter', () => {
  const PLAN = { reasoning: 'graph first', plan: '1. Query the graph.', n_steps: 1 }

  beforeEach(() => {
    vi.clearAllMocks()
    mockPlanner.mockResolvedValue(PLAN)
  })

  it('returns the plan and passes the resolved tool catalog + context', async () => {
    const { createPlannerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const plannerFn = createPlannerAdapter(['read_neo4j_cypher'])
    const result = await plannerFn('msg', 'intent', undefined, 'Node: Person')

    expect(result.plan).toEqual(PLAN)
    const [userMessage, intent, tools, context] = mockPlanner.mock.calls[0]
    expect(userMessage).toBe('msg')
    expect(intent).toBe('intent')
    expect((tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['read_neo4j_cypher'])
    expect(context).toBe('Node: Person')
  })

  it('propagates a non-recoverable failure as an LLMCallError', async () => {
    const { createPlannerAdapter, LLMCallError } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    mockPlanner.mockRejectedValue(new Error('planner unavailable'))
    const plannerFn = createPlannerAdapter(['read_neo4j_cypher'])

    await expect(plannerFn('msg', 'intent')).rejects.toBeInstanceOf(LLMCallError)
    // No retry for a plain failure — the retry path is truncation/empty only.
    expect(mockPlanner).toHaveBeenCalledTimes(1)
  })

  it('reports the tool count the model was actually shown', async () => {
    const { createPlannerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    // 'ghost_tool' resolves to no description, so the model sees 2 of 3 names.
    const plannerFn = createPlannerAdapter([
      'read_neo4j_cypher',
      'write_neo4j_cypher',
      'ghost_tool',
    ])
    const result = await plannerFn('msg', 'intent')

    const [, , tools] = mockPlanner.mock.calls[0]
    expect(result.toolCount).toBe((tools as unknown[]).length)
    expect(result.toolCount).toBe(2)
  })

  it('stays on PlannerAnthropic even under USE_MIXED_CHAINS (#27 review)', async () => {
    // The whole file runs with USE_MIXED_CHAINS=1. The controllers swap to
    // ControllerFallback here — the planner must NOT: that chain's Groq
    // gpt-oss-120b is the documented structured-output failure, and unlike the
    // controllers the planner carries no Groq→Groq escalation to survive it.
    const { createPlannerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    await createPlannerAdapter(['read_neo4j_cypher'])('msg', 'intent')

    const opts = mockPlanner.mock.calls[0][4] as { client?: string }
    expect(opts.client).toBe('PlannerAnthropic')
  })
})

describe('createCriticAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCritic.mockResolvedValue(mockCriticResult())
  })

  it('should create a critic function', async () => {
    const { createCriticAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const critic = createCriticAdapter()
    expect(critic).toBeDefined()
    expect(typeof critic).toBe('function')
  })

  it('should return result and llmCall data', async () => {
    const { createCriticAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const critic = createCriticAdapter()

    const result = await critic('intent', [])

    expect(result.result).toBeDefined()
    expect(result.result.is_sufficient).toBe(true)
  })
})

describe('domain-specific adapters', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoopController.mockResolvedValue(mockFinalAction())
  })

  it('should create Neo4j controller', async () => {
    const { createNeo4jController } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createNeo4jController(['read_neo4j_cypher', 'Return'])
    expect(controller).toBeDefined()

    await controller('query', 'intent', '[]', 0)
    expect(mockLoopController).toHaveBeenCalled()
  })

  it('should create web search controller', async () => {
    const { createWebSearchController } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createWebSearchController(['search', 'fetch', 'Return'])
    expect(controller).toBeDefined()

    await controller('search query', 'intent', '[]', 0)
    expect(mockLoopController).toHaveBeenCalled()
  })

  it('should create memory controller', async () => {
    const { createMemoryController } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createMemoryController(['create_entities', 'Return'])
    expect(controller).toBeDefined()

    await controller('store this', 'intent', '[]', 0)
    expect(mockLoopController).toHaveBeenCalled()
  })

  it('should create Context7 controller', async () => {
    const { createContext7Controller } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createContext7Controller(['resolve-library-id', 'Return'])
    expect(controller).toBeDefined()

    await controller('look up docs', 'intent', '[]', 0)
    expect(mockLoopController).toHaveBeenCalled()
  })

  it('should create GitHub controller', async () => {
    const { createGitHubController } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createGitHubController(['search_code', 'Return'])
    expect(controller).toBeDefined()

    await controller('find code', 'intent', '[]', 0)
    expect(mockLoopController).toHaveBeenCalled()
  })

  it('should create filesystem controller', async () => {
    const { createFilesystemController } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createFilesystemController(['read_file', 'Return'])
    expect(controller).toBeDefined()

    await controller('read file', 'intent', '[]', 0)
    expect(mockLoopController).toHaveBeenCalled()
  })

  it('should create Redis controller', async () => {
    const { createRedisController } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createRedisController(['redis_get', 'Return'])
    expect(controller).toBeDefined()

    await controller('get key', 'intent', '[]', 0)
    expect(mockLoopController).toHaveBeenCalled()
  })

  it('should create database controller', async () => {
    const { createDatabaseController } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createDatabaseController(['query', 'Return'])
    expect(controller).toBeDefined()

    await controller('run query', 'intent', '[]', 0)
    expect(mockLoopController).toHaveBeenCalled()
  })
})

describe('parseResultsToTurns', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoopController.mockResolvedValue(mockFinalAction())
  })

  it('should handle empty previous_results', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createLoopControllerAdapter(['Return'])

    // Empty string should result in empty turns
    await controller('user message', 'intent', '', 0)
    expect(mockLoopController).toHaveBeenCalled()
  })

  it('should handle empty array previous_results', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createLoopControllerAdapter(['Return'])

    await controller('user message', 'intent', '[]', 0)
    expect(mockLoopController).toHaveBeenCalled()
  })

  it('should handle array of results', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createLoopControllerAdapter(['Return'])

    const results = JSON.stringify([{ data: 'result1' }, { data: 'result2' }])

    await controller('user message', 'intent', results, 2)
    expect(mockLoopController).toHaveBeenCalled()

    // The turns should be passed to LoopController
    const calls = mockLoopController.mock.calls[0]
    expect(calls).toBeDefined()
  })

  it('should handle invalid JSON in previous_results', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createLoopControllerAdapter(['Return'])

    // Invalid JSON should not throw, should result in empty turns
    await controller('user message', 'intent', 'not valid json', 0)
    expect(mockLoopController).toHaveBeenCalled()
  })

  it('should handle non-array JSON in previous_results', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createLoopControllerAdapter(['Return'])

    // Object instead of array should result in empty turns
    await controller('user message', 'intent', '{"key": "value"}', 0)
    expect(mockLoopController).toHaveBeenCalled()
  })
})

describe('extractLLMCallData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should extract all fields from a collector with full data', async () => {
    const { extractLLMCallData } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const collector = {
      last: {
        rawLlmResponse: '{"tool_name":"Return","is_final":true}',
        usage: { inputTokens: 150, outputTokens: 30, cachedInputTokens: 50 },
        calls: [
          {
            httpRequest: { body: '{"messages":[{"role":"user","content":"test"}]}' },
            provider: 'groq',
            clientName: 'GroqFast',
          },
        ],
      },
    }

    const result = extractLLMCallData(
      collector as any,
      'LoopController',
      { user_message: 'test' },
      Date.now() - 100,
      { is_final: true },
    )

    expect(result).toBeDefined()
    expect(result!.functionName).toBe('LoopController')
    expect(result!.variables).toEqual({ user_message: 'test' })
    expect(result!.rawOutput).toBe('{"tool_name":"Return","is_final":true}')
    expect(result!.rawInput).toBe('{"messages":[{"role":"user","content":"test"}]}')
    expect(result!.parsedOutput).toEqual({ is_final: true })
    // totalTokens = ALL tokens processed (fresh + cache read + write + out) —
    // semantics changed with #122 cache accounting (was fresh + out only).
    expect(result!.usage).toEqual({
      inputTokens: 150,
      outputTokens: 30,
      cachedInputTokens: 50,
      totalTokens: 230,
    })
    expect(result!.provider).toBe('groq')
    expect(result!.clientName).toBe('GroqFast')
    expect(result!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('should return undefined when collector has no last property', async () => {
    const { extractLLMCallData } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const collector = { last: undefined }

    const result = extractLLMCallData(collector as any, 'LoopController', {}, Date.now())

    expect(result).toBeUndefined()
  })

  it('should handle missing provider and clientName', async () => {
    const { extractLLMCallData } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const collector = {
      last: {
        rawLlmResponse: 'output',
        usage: { inputTokens: 10, outputTokens: 5 },
        calls: [{ httpRequest: { body: {} } }],
      },
    }

    const result = extractLLMCallData(collector as any, 'Synthesize', {}, Date.now())

    expect(result).toBeDefined()
    expect(result!.provider).toBeUndefined()
    expect(result!.clientName).toBeUndefined()
  })

  it('should handle httpRequest body as object', async () => {
    const { extractLLMCallData } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const bodyObj = { messages: [{ role: 'user', content: 'test' }] }
    const collector = {
      last: {
        rawLlmResponse: 'output',
        calls: [{ httpRequest: { body: bodyObj } }],
      },
    }

    const result = extractLLMCallData(collector as any, 'LoopController', {}, Date.now())

    expect(result).toBeDefined()
    expect(result!.rawInput).toBe(JSON.stringify(bodyObj, null, 2))
  })

  it('should handle missing usage data', async () => {
    const { extractLLMCallData } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const collector = {
      last: {
        rawLlmResponse: 'output',
        calls: [{ httpRequest: { body: '{}' } }],
      },
    }

    const result = extractLLMCallData(collector as any, 'LoopController', {}, Date.now())

    expect(result).toBeDefined()
    expect(result!.usage).toBeUndefined()
  })

  it('should handle missing calls array', async () => {
    const { extractLLMCallData } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const collector = {
      last: {
        rawLlmResponse: 'output',
      },
    }

    const result = extractLLMCallData(collector as any, 'LoopController', {}, Date.now())

    expect(result).toBeDefined()
    expect(result!.rawInput).toBeUndefined()
    expect(result!.provider).toBeUndefined()
    expect(result!.clientName).toBeUndefined()
  })

  it('should call body.text() when httpRequest.body is an HttpBody class instance', async () => {
    const { extractLLMCallData } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    // Mirrors @boundaryml/baml's HttpBody: class instance with no enumerable own
    // props — JSON.stringify would yield "{}", which is the regression we're guarding against
    const bodyText = '{"messages":[{"role":"user","content":"hello"}]}'
    const httpBody = Object.create({ text: () => bodyText, json: () => JSON.parse(bodyText) })

    const collector = {
      last: {
        rawLlmResponse: 'output',
        calls: [
          {
            httpRequest: { body: httpBody },
            selected: true,
            provider: 'openrouter',
            clientName: 'OpenRouterNemotron120B',
          },
        ],
      },
    }

    const result = extractLLMCallData(collector as never, 'LoopController', {}, Date.now())

    expect(result).toBeDefined()
    expect(result!.rawInput).toBe(bodyText)
    expect(result!.rawInput).not.toBe('{}')
    expect(result!.provider).toBe('openrouter')
    expect(result!.clientName).toBe('OpenRouterNemotron120B')
  })

  it('should prefer the selected call when fallbacks produce multiple entries', async () => {
    const { extractLLMCallData } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const failedBody = Object.create({ text: () => 'FAILED_BODY' })
    const goodBody = Object.create({ text: () => 'GOOD_BODY' })

    const collector = {
      last: {
        rawLlmResponse: 'output',
        calls: [
          {
            httpRequest: { body: failedBody },
            selected: false,
            provider: 'groq',
            clientName: 'GroqFast',
          },
          {
            httpRequest: { body: goodBody },
            selected: true,
            provider: 'openai',
            clientName: 'OpenAIGPT5',
          },
        ],
      },
    }

    const result = extractLLMCallData(collector as never, 'LoopController', {}, Date.now())

    expect(result!.rawInput).toBe('GOOD_BODY')
    expect(result!.clientName).toBe('OpenAIGPT5')
  })

  it('should populate promptTemplate with the Jinja template (placeholders intact)', async () => {
    const { extractLLMCallData } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const collector = {
      last: {
        rawLlmResponse: 'output',
        calls: [
          { httpRequest: { body: '{"messages":[{"role":"user","content":"INTENT: hello"}]}' } },
        ],
      },
    }

    const result = extractLLMCallData(
      collector as never,
      'LoopController',
      { user_message: 'hello' },
      Date.now(),
    )

    expect(result).toBeDefined()
    // Raw prompt = the BAML template with placeholders intact
    expect(result!.promptTemplate).toBeDefined()
    expect(result!.promptTemplate).toMatch(/\{\{\s*intent\s*\}\}/)
    // Parsed prompt = the rendered HTTP body containing substituted content
    expect(result!.rawInput).toContain('INTENT: hello')
    // The two must not be the same string
    expect(result!.promptTemplate).not.toBe(result!.rawInput)
  })
})

describe('describeToolResultOp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should return summary from ResultDescribe', async () => {
    const { describeToolResultOp } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    mockResultDescribe.mockResolvedValue('Found 3 nodes in the graph.')

    const result = await describeToolResultOp(
      'read_neo4j_cypher',
      '{"query":"MATCH (n) RETURN n"}',
      'Need to list nodes',
      '[{name:"A"},{name:"B"},{name:"C"}]',
    )

    expect(result).toBe('Found 3 nodes in the graph.')
    // 5th arg is the BAML options override (`{ client: 'DescribeFallback' }`)
    // added under USE_MIXED_CHAINS=1 — see `clientOverrideFor`.
    expect(mockResultDescribe).toHaveBeenCalledWith(
      'read_neo4j_cypher',
      '{"query":"MATCH (n) RETURN n"}',
      'Need to list nodes',
      '[{name:"A"},{name:"B"},{name:"C"}]',
      expect.objectContaining({ client: 'DescribeFallback' }),
    )
  })

  it('should return empty string on failure', async () => {
    const { describeToolResultOp } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    mockResultDescribe.mockRejectedValue(new Error('Model unavailable'))

    const result = await describeToolResultOp('search', '{}', '', 'data')

    expect(result).toBe('')
  })
})

describe('describeToolResultsBatchOp', () => {
  const items = [
    { id: '1', tool: 'search', toolArgs: '{"q":"a"}', reasoning: 'find a', result: 'A' },
    { id: '2', tool: 'fetch', toolArgs: '{"url":"b"}', reasoning: '', result: 'B' },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('maps each echoed id to its summary and renames args for BAML', async () => {
    const { describeToolResultsBatchOp } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    mockResultDescribeBatch.mockResolvedValue({
      summaries: [
        { id: '2', summary: 'Fetched B.' },
        { id: '1', summary: 'Found A.' },
      ],
    })

    const byId = await describeToolResultsBatchOp(items)

    expect(byId.get('1')).toBe('Found A.')
    expect(byId.get('2')).toBe('Fetched B.')
    // `toolArgs` is renamed to the BAML class's snake_case `tool_args`
    expect(mockResultDescribeBatch).toHaveBeenCalledWith(
      [
        { id: '1', tool: 'search', tool_args: '{"q":"a"}', reasoning: 'find a', result: 'A' },
        { id: '2', tool: 'fetch', tool_args: '{"url":"b"}', reasoning: '', result: 'B' },
      ],
      // 2nd arg is the client override added under USE_MIXED_CHAINS=1
      expect.objectContaining({ client: 'DescribeFallback' }),
    )
  })

  it('omits ids the model dropped or answered blank', async () => {
    const { describeToolResultsBatchOp } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    mockResultDescribeBatch.mockResolvedValue({
      summaries: [{ id: '1', summary: '   ' }],
    })

    const byId = await describeToolResultsBatchOp(items)

    // Blank trims to nothing → treated as unanswered, same as the missing '2'
    expect(byId.size).toBe(0)
  })

  it('discards summaries for ids that were never requested', async () => {
    const { describeToolResultsBatchOp } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    mockResultDescribeBatch.mockResolvedValue({
      summaries: [
        { id: '1', summary: 'Found A.' },
        { id: '9', summary: 'Summary of a tool that was never in the batch.' },
      ],
    })

    const byId = await describeToolResultsBatchOp(items)

    expect([...byId.keys()]).toEqual(['1'])
  })

  it('returns an empty map on failure so the caller can retry per item', async () => {
    const { describeToolResultsBatchOp } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    mockResultDescribeBatch.mockRejectedValue(new Error('Model unavailable'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const byId = await describeToolResultsBatchOp(items)

    expect(byId.size).toBe(0)
    // Logged, not swallowed: an always-failing batch is an N+1 cost regression
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('falling back per item'))
    warn.mockRestore()
  })

  it('makes no call at all for an empty batch', async () => {
    const { describeToolResultsBatchOp } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const byId = await describeToolResultsBatchOp([])

    expect(byId.size).toBe(0)
    expect(mockResultDescribeBatch).not.toHaveBeenCalled()
  })
})

describe('LoopController BamlValidationError fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should fall back to GroqGPT120B on BamlValidationError', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    // First call throws BamlValidationError, second call (GroqGPT120B) succeeds
    mockLoopController
      .mockRejectedValueOnce(
        new BamlValidationError('Invalid JSON output', 'raw output', 'msg', 'detailed'),
      )
      .mockResolvedValueOnce(mockFinalAction('Recovered'))

    const controller = createLoopControllerAdapter(['Return'])
    const result = await controller('user message', 'intent', '[]', 0)

    expect(result.action).toBeDefined()
    expect(result.action.is_final).toBe(true)
    expect(mockLoopController).toHaveBeenCalledTimes(2)
    // Second call should use GroqGPT120B client override. Options ride after
    // the 9 data params (plan_context is 9th since #27's cache split).
    const secondCallOptions =
      mockLoopController.mock.calls[1][9] ?? mockLoopController.mock.calls[1][8]
    expect(secondCallOptions).toEqual(expect.objectContaining({ client: 'GroqGPT120B' }))
  })

  it('should fall back to GroqFast when both primary and GroqGPT120B fail', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    // All three calls fail with BamlValidationError until GroqFast succeeds
    mockLoopController
      .mockRejectedValueOnce(new BamlValidationError('Invalid JSON', 'raw1', 'msg', 'detailed'))
      .mockRejectedValueOnce(new BamlValidationError('Still invalid', 'raw2', 'msg', 'detailed'))
      .mockResolvedValueOnce(mockFinalAction('Final recovery'))

    const controller = createLoopControllerAdapter(['Return'])
    const result = await controller('user message', 'intent', '[]', 0)

    expect(result.action).toBeDefined()
    expect(result.action.is_final).toBe(true)
    expect(mockLoopController).toHaveBeenCalledTimes(3)
    // Third call should use GroqFast client override. Same slot shift as above.
    const thirdCallOptions =
      mockLoopController.mock.calls[2][9] ?? mockLoopController.mock.calls[2][8]
    expect(thirdCallOptions).toEqual(expect.objectContaining({ client: 'GroqFast' }))
  })

  it('should propagate non-BamlValidationError errors', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    mockLoopController.mockRejectedValue(new Error('Network timeout'))

    const controller = createLoopControllerAdapter(['Return'])

    await expect(controller('user message', 'intent', '[]', 0)).rejects.toThrow('Network timeout')
    expect(mockLoopController).toHaveBeenCalledTimes(1)
  })

  it('should propagate non-BamlValidationError from GroqGPT120B fallback', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    mockLoopController
      .mockRejectedValueOnce(new BamlValidationError('Invalid JSON', 'raw', 'msg', 'detailed'))
      .mockRejectedValueOnce(new Error('GroqGPT120B network error'))

    const controller = createLoopControllerAdapter(['Return'])

    await expect(controller('user message', 'intent', '[]', 0)).rejects.toThrow(
      'GroqGPT120B network error',
    )
    expect(mockLoopController).toHaveBeenCalledTimes(2)
  })
})

describe('priorResults parameter passing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoopController.mockResolvedValue(mockFinalAction())
  })

  it('should pass priorResults as 6th argument to LoopController', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createLoopControllerAdapter(['Return'])

    const priorResults = [{ ref_id: 'ev-abc', tool: 'search', summary: 'Found 3 results' }]

    await controller('user message', 'intent', '[]', 0, undefined, undefined, priorResults)

    expect(mockLoopController).toHaveBeenCalled()
    // LoopController args: user_message, intent, tools, turns, context, priorResults
    const [, , , , , passedPrior] = mockLoopController.mock.calls[0]
    expect(passedPrior).toEqual(priorResults)
  })

  it('should pass undefined priorResults when not provided', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createLoopControllerAdapter(['Return'])

    await controller('user message', 'intent', '[]', 0)

    expect(mockLoopController).toHaveBeenCalled()
    const [, , , , , passedPrior] = mockLoopController.mock.calls[0]
    expect(passedPrior).toBeUndefined()
  })
})

describe('fewShots parameter passing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoopController.mockResolvedValue(mockFinalAction())
  })

  it('should pass fewShots as 7th argument to LoopController', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createLoopControllerAdapter(['Return'])

    const fewShots = [
      {
        user: 'Find concept by name',
        reasoning: 'Direct property lookup',
        tool: 'read_neo4j_cypher',
        args: '{"query":"MATCH (c:Concept {name:$n}) RETURN c","params":{"n":"Redis"}}',
      },
    ]

    await controller('msg', 'intent', '[]', 0, undefined, undefined, undefined, fewShots)

    expect(mockLoopController).toHaveBeenCalled()
    // LoopController args: user_message, intent, tools, turns, context, priorResults, fewShots
    const [, , , , , , passedShots] = mockLoopController.mock.calls[0]
    expect(passedShots).toEqual(fewShots)
  })

  it('should pass undefined fewShots when not provided', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createLoopControllerAdapter(['Return'])

    await controller('msg', 'intent', '[]', 0)

    const [, , , , , , passedShots] = mockLoopController.mock.calls[0]
    expect(passedShots).toBeUndefined()
  })
})

describe('dedupByRefId', () => {
  it('drops duplicates, first occurrence wins', async () => {
    const { dedupByRefId } = await import('../../../lib/harness-patterns/baml-adapters.server')
    const out = dedupByRefId([
      { ref_id: 'a', tool: 'x', summary: 'first' },
      { ref_id: 'b', tool: 'y', summary: 'b' },
      { ref_id: 'a', tool: 'x', summary: 'second' },
    ])
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ ref_id: 'a', tool: 'x', summary: 'first' })
    expect(out[1].ref_id).toBe('b')
  })

  it('returns empty array when input is empty', async () => {
    const { dedupByRefId } = await import('../../../lib/harness-patterns/baml-adapters.server')
    expect(dedupByRefId([])).toEqual([])
  })
})

describe('annotateExpansions', () => {
  it('sets expanded_in_turn to first turn whose expansions contain the ref_id', async () => {
    const { annotateExpansions } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const refs = [
      { ref_id: 'a', tool: 'x', summary: 's' },
      { ref_id: 'b', tool: 'y', summary: 's' },
      { ref_id: 'c', tool: 'z', summary: 's' },
    ]
    const turns = [
      { n: 0, expansions: [{ ref_id: 'b', content: 'B' }] },
      {
        n: 1,
        expansions: [
          { ref_id: 'a', content: 'A1' },
          { ref_id: 'b', content: 'B2' },
        ],
      },
      { n: 2, expansions: [{ ref_id: 'a', content: 'A2' }] },
    ]
    const out = annotateExpansions(refs, turns)
    expect(out[0].expanded_in_turn).toBe(1) // 'a' first appears at turn 1
    expect(out[1].expanded_in_turn).toBe(0) // 'b' first appears at turn 0
    // Unannotated refs get `null` explicitly (NOT undefined) so the BAML
    // MiniJinja template's `is none` test fires correctly. If we left the
    // field as undefined, MiniJinja's `is not none` would evaluate TRUE
    // (because undefined ≠ None), incorrectly rendering "(expanded in turn )"
    // and causing the LLM to hallucinate data instead of expanding it.
    expect(out[2].expanded_in_turn).toBeNull()
  })

  it('always sets expanded_in_turn (null when no turns have expansions)', async () => {
    const { annotateExpansions } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const refs = [{ ref_id: 'a', tool: 'x', summary: 's' }]
    const out = annotateExpansions(refs, [{ n: 0 }, { n: 1, expansions: [] }])
    expect(out[0].expanded_in_turn).toBeNull()
    // Field must be present in the object — NOT absent.
    expect('expanded_in_turn' in out[0]).toBe(true)
  })
})

// ============================================================================
// Failed LLM call capture (#31): adapters must wrap final-propagating
// failures in LLMCallError carrying promptTemplate, variables, and the
// best-effort HTTP body so the panel can render the same Prompt drill-down
// for failures as for successes.
// ============================================================================

describe('LLMCallError — failed LLM call capture', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('throws LLMCallError carrying promptTemplate and variables when LoopController fails', async () => {
    const { createLoopControllerAdapter, LLMCallError } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    // Non-BamlValidationError fails on first attempt (no adapter retry):
    // adapter must wrap in LLMCallError with the captured context. The
    // mock receives a fake collector — we simulate BAML populating it
    // before throwing (typical of parse failures arriving after the HTTP
    // response). httpRequest body mirrors the HttpBody class shape.
    // Note: the real `Collector.last` is a getter, so the test uses a
    // plain object that satisfies the structural shape.
    const bodyText = '{"messages":[{"role":"user","content":"INTENT: do thing"}]}'
    const httpBody = Object.create({ text: () => bodyText })
    const fakeCollector = {
      last: undefined as unknown as Record<string, unknown> | undefined,
    }
    mockLoopController.mockImplementation(async (..._args: unknown[]) => {
      const options = _args[_args.length - 1] as { collector?: typeof fakeCollector } | undefined
      if (options?.collector) {
        options.collector.last = {
          rawLlmResponse: 'malformed-json-from-llm',
          calls: [
            {
              httpRequest: { body: httpBody },
              provider: 'groq',
              clientName: 'GroqGPT120B',
            },
          ],
        }
      }
      throw new Error('Network down')
    })

    const controller = createLoopControllerAdapter(['Return'])

    let caught: unknown
    try {
      await controller('do thing', 'do thing', '[]', 0, undefined, fakeCollector as never)
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(LLMCallError)
    const err = caught as InstanceType<typeof LLMCallError>
    expect(err.message).toBe('Network down')
    expect(err.llmCall).toBeDefined()
    expect(err.llmCall.functionName).toBe('LoopController')
    expect(err.llmCall.variables).toEqual(
      expect.objectContaining({
        user_message: 'do thing',
        intent: 'do thing',
      }),
    )
    // promptTemplate must be populated from inlined BAML
    expect(err.llmCall.promptTemplate).toBeDefined()
    expect(err.llmCall.promptTemplate).toMatch(/\{\{\s*intent\s*\}\}/)
    // HTTP body captured before the failure
    expect(err.llmCall.rawInput).toBe('{"messages":[{"role":"user","content":"INTENT: do thing"}]}')
    // rawOutput captured (the malformed response) — equivalent to httpResponse
    expect(err.llmCall.rawOutput).toBe('malformed-json-from-llm')
    expect(err.llmCall.provider).toBe('groq')
    expect(err.llmCall.clientName).toBe('GroqGPT120B')
    // The original error is preserved as cause
    expect(err.cause).toBeInstanceOf(Error)
  })

  it('LLMCallError omits rawInput when the failure is pre-call (collector never recorded a call)', async () => {
    const { createLoopControllerAdapter, LLMCallError } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    // Pre-call failure: collector stays empty (no last entry). Adapter
    // should still throw LLMCallError with promptTemplate + variables;
    // rawInput / rawOutput are undefined.
    mockLoopController.mockRejectedValue(new Error('DNS lookup failed'))

    const controller = createLoopControllerAdapter(['Return'])
    const { Collector } = await import('@boundaryml/baml')
    const collector = new Collector('test')

    let caught: unknown
    try {
      await controller('msg', 'intent', '[]', 0, undefined, collector)
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(LLMCallError)
    const err = caught as InstanceType<typeof LLMCallError>
    expect(err.message).toBe('DNS lookup failed')
    expect(err.llmCall.functionName).toBe('LoopController')
    expect(err.llmCall.variables).toEqual(expect.objectContaining({ intent: 'intent' }))
    expect(err.llmCall.promptTemplate).toBeDefined()
    expect(err.llmCall.rawInput).toBeUndefined()
    expect(err.llmCall.rawOutput).toBeUndefined()
  })

  it('does NOT throw LLMCallError when a recovered fallback attempt succeeds', async () => {
    // The fallback chain only emits a propagating error on the final
    // failure. When attempt 1 fails with BamlValidationError but attempt
    // 2 (GroqGPT120B) succeeds, the adapter returns the success — no
    // LLMCallError is thrown and the recovered attempts don't surface
    // as red error events in the panel.
    const { createLoopControllerAdapter, LLMCallError } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    mockLoopController
      .mockRejectedValueOnce(new BamlValidationError('Invalid JSON', 'raw', 'msg', 'detailed'))
      .mockResolvedValueOnce(mockFinalAction('Recovered on attempt 2'))

    const controller = createLoopControllerAdapter(['Return'])

    // Should NOT throw: the recovered attempt produces a normal return.
    const result = await controller('user message', 'intent', '[]', 0)
    expect(result.action).toBeDefined()
    expect(result.action.is_final).toBe(true)
    // And just to assert the type: an LLMCallError did not slip through
    expect(result instanceof LLMCallError).toBe(false)
  })

  it('throws LLMCallError when ALL fallbacks (primary + GroqGPT120B + GroqFast) fail', async () => {
    // Only the final, propagating failure should produce an LLMCallError.
    // Here every fallback throws BamlValidationError, so the adapter
    // exhausts the chain and the propagating error from the last attempt
    // is wrapped.
    const { createLoopControllerAdapter, LLMCallError } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    mockLoopController
      .mockRejectedValueOnce(new BamlValidationError('attempt 1 invalid', 'r1', 'm1', 'd1'))
      .mockRejectedValueOnce(new BamlValidationError('attempt 2 invalid', 'r2', 'm2', 'd2'))
      .mockRejectedValueOnce(new BamlValidationError('attempt 3 invalid', 'r3', 'm3', 'd3'))

    const controller = createLoopControllerAdapter(['Return'])

    let caught: unknown
    try {
      await controller('msg', 'intent', '[]', 0)
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(LLMCallError)
    // BamlValidationError's .message is empty (constructor stashes args on
    // .prompt / .raw_output instead), so we just assert the wrapper class
    // and the call count rather than asserting on message content.
    expect((caught as InstanceType<typeof LLMCallError>).cause).toBeDefined()
    // All three attempts ran
    expect(mockLoopController).toHaveBeenCalledTimes(3)
  })

  it('throws LLMCallError from ActorController on BAML failure', async () => {
    const { createActorControllerAdapter, LLMCallError } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    mockActorController.mockRejectedValue(new Error('Provider 5xx'))

    const actor = createActorControllerAdapter(['code-mode'])
    const { Collector } = await import('@boundaryml/baml')

    let caught: unknown
    try {
      await actor('msg', 'intent', ['code-mode'], [], new Collector('test'))
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(LLMCallError)
    const err = caught as InstanceType<typeof LLMCallError>
    expect(err.llmCall.functionName).toBe('ActorController')
    expect(err.llmCall.promptTemplate).toBeDefined()
  })

  it('throws LLMCallError from Critic on BAML failure', async () => {
    const { createCriticAdapter, LLMCallError } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    mockCritic.mockRejectedValue(new Error('Critic timed out'))

    const critic = createCriticAdapter()
    const { Collector } = await import('@boundaryml/baml')

    let caught: unknown
    try {
      await critic('intent', [], new Collector('test'))
    } catch (e) {
      caught = e
    }

    expect(caught).toBeInstanceOf(LLMCallError)
    const err = caught as InstanceType<typeof LLMCallError>
    expect(err.llmCall.functionName).toBe('Critic')
    expect(err.llmCall.variables).toEqual(expect.objectContaining({ intent: 'intent' }))
  })
})

describe('extractFailureLLMCallData', () => {
  it('returns LLMCallData with promptTemplate and variables when collector is empty', async () => {
    const { extractFailureLLMCallData } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const result = extractFailureLLMCallData(
      undefined,
      'LoopController',
      { user_message: 'hi', intent: 'hi' },
      Date.now() - 50,
    )

    expect(result).toBeDefined()
    expect(result.functionName).toBe('LoopController')
    expect(result.variables).toEqual({ user_message: 'hi', intent: 'hi' })
    expect(result.promptTemplate).toBeDefined()
    expect(result.rawInput).toBeUndefined()
    expect(result.rawOutput).toBeUndefined()
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('returns the same shape as success when collector has captured a call', async () => {
    const { extractFailureLLMCallData } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const bodyText = '{"messages":[{"role":"user","content":"hello"}]}'
    const httpBody = Object.create({ text: () => bodyText })
    const collector = {
      last: {
        rawLlmResponse: 'partial-or-malformed',
        calls: [{ httpRequest: { body: httpBody }, provider: 'openai', clientName: 'OpenAIGPT5' }],
      },
    }

    const result = extractFailureLLMCallData(
      collector as never,
      'Synthesize',
      { userMessage: 'hello' },
      Date.now() - 100,
    )

    expect(result.functionName).toBe('Synthesize')
    expect(result.rawInput).toBe(bodyText)
    expect(result.rawOutput).toBe('partial-or-malformed')
    expect(result.provider).toBe('openai')
    expect(result.clientName).toBe('OpenAIGPT5')
    // parsedOutput is intentionally omitted on failures
    expect(result.parsedOutput).toBeUndefined()
  })
})

// Build-order step 3: when a `withSandbox` wrapper is active, the adapters
// prepend the sandbox's in-VM tool descriptions to the `tools` arg passed to
// the BAML function, so the actor sees them in its first-turn prompt without
// the caller threading them through `toolNames`. See docs/plan/sandbox.md →
// "How tools reach the controller".
describe('sandbox tool descriptions in prompt', () => {
  function fakeTransport() {
    return {
      vmId: 'sbx-1',
      toolNames: async () => ['sandbox_bash', 'sandbox_read'],
      listTools: async () => [
        {
          name: 'sandbox_bash',
          description: 'run a shell command',
          inputSchema: { type: 'object' },
        },
        { name: 'sandbox_read', description: 'read a file', inputSchema: { type: 'object' } },
      ],
      ownsTool: (n: string) => n === 'sandbox_bash' || n === 'sandbox_read',
      callTool: vi.fn(),
      close: async () => {},
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockLoopController.mockResolvedValue(mockFinalAction())
    mockActorController.mockResolvedValue(mockFinalAction())
  })

  it('prepends sandbox tools to LoopController prompt when scope is active', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { runWithSandbox } = await import('../../../lib/sandbox/scope.server')

    const controller = createLoopControllerAdapter(['read_neo4j_cypher', 'Return'])

    await runWithSandbox(fakeTransport(), () => controller('msg', 'intent', '[]', 0))

    // 3rd arg of LoopController is the `tools` array.
    const tools = mockLoopController.mock.calls[0][2] as Array<{ name: string }>
    const names = tools.map((t) => t.name)
    // Sandbox tools appear first (prepended).
    expect(names.slice(0, 2)).toEqual(['sandbox_bash', 'sandbox_read'])
    // Gateway-listed tools still present.
    expect(names).toContain('read_neo4j_cypher')
  })

  it('does not include sandbox tools when no scope is active (LoopController)', async () => {
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')

    const controller = createLoopControllerAdapter(['read_neo4j_cypher', 'Return'])
    await controller('msg', 'intent', '[]', 0)

    const tools = mockLoopController.mock.calls[0][2] as Array<{ name: string }>
    const names = tools.map((t) => t.name)
    expect(names).not.toContain('sandbox_bash')
    expect(names).not.toContain('sandbox_read')
  })

  it('prepends sandbox tools to ActorController prompt when scope is active', async () => {
    const { createActorControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { runWithSandbox } = await import('../../../lib/sandbox/scope.server')

    const controller = createActorControllerAdapter(['code-mode', 'Return'])

    await runWithSandbox(fakeTransport(), () => controller('msg', 'intent', [], []))

    // 3rd arg of ActorController is the `tools` array.
    const tools = mockActorController.mock.calls[0][2] as Array<{ name: string }>
    const names = tools.map((t) => t.name)
    expect(names.slice(0, 2)).toEqual(['sandbox_bash', 'sandbox_read'])
  })
})

// ============================================================================
// Stale-client data-loss signal (#154)
// ============================================================================

describe('warnIfCollectorEmpty', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoopController.mockResolvedValue(mockFinalAction())
    mockCritic.mockResolvedValue(mockCriticResult())
  })

  it('returns false and stays silent when no collector was passed', async () => {
    const { warnIfCollectorEmpty } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(warnIfCollectorEmpty(undefined, 'LoopController')).toBe(false)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('returns false and stays silent when the collector captured a call', async () => {
    const { warnIfCollectorEmpty } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { Collector } = await import('@boundaryml/baml')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // A Collector that saw a call — the shape this module reads is `.last`.
    const collector = Object.create(Collector.prototype) as InstanceType<typeof Collector>
    Object.defineProperty(collector, 'last', { get: () => ({ rawLlmResponse: 'ok' }) })

    expect(warnIfCollectorEmpty(collector, 'LoopController')).toBe(false)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('warns naming the BAML function when a collector came back empty', async () => {
    const { warnIfCollectorEmpty } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { Collector } = await import('@boundaryml/baml')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(warnIfCollectorEmpty(new Collector('test'), 'ActorController')).toBe(true)
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const message = warnSpy.mock.calls[0][0] as string
    expect(message).toContain('ActorController')
    expect(message).toContain('pnpm baml-generate')
    warnSpy.mockRestore()
  })

  it('fires on a SUCCESSFUL LoopController call whose collector stayed empty', async () => {
    // This is the #154 shape: a stale client drops the options object, so the
    // call succeeds while the collector never reaches BAML.
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { Collector } = await import('@boundaryml/baml')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const controller = createLoopControllerAdapter(['Return'])
    const result = await controller('msg', 'intent', '[]', 0, undefined, new Collector('test'))

    expect(result.action).toBeDefined()
    expect(result.llmCall).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0] as string).toContain('LoopController')
    warnSpy.mockRestore()
  })

  it('fires for Critic too, naming Critic', async () => {
    const { createCriticAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { Collector } = await import('@boundaryml/baml')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await createCriticAdapter()('intent', [], new Collector('test'))

    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0] as string).toContain('Critic')
    warnSpy.mockRestore()
  })

  it('stays silent on a FAILED call — an empty collector is legitimate there', async () => {
    // A pre-request failure (DNS, 5xx before a body) leaves the collector
    // empty for a benign reason, so the failure path must not cry wolf.
    const { createLoopControllerAdapter } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const { Collector } = await import('@boundaryml/baml')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    mockLoopController.mockRejectedValue(new Error('DNS lookup failed'))
    const controller = createLoopControllerAdapter(['Return'])

    await expect(
      controller('msg', 'intent', '[]', 0, undefined, new Collector('test')),
    ).rejects.toThrow('DNS lookup failed')

    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('extractPromptTemplates', () => {
  it('matches a signature whose comment contains a parenthesis', async () => {
    const { extractPromptTemplates } =
      await import('../../../lib/harness-patterns/baml-adapters.server')
    const source = `function Planner(
      user_message: string, // the ask (see #27)
    ) -> PlanResult {
      client PlannerAnthropic
      prompt #"plan it"#
    }`

    const cache: Record<string, string> = {}
    extractPromptTemplates(source, cache)

    expect(cache.Planner).toBe('plan it')
  })
})
