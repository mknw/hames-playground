// The composition root registers the harness client seam (tier policy, model
// tables, cost rates); these tests exercise scopes/rates/windows, so they run
// the same wiring a production turn takes.
import '../../../lib/inference/config.server'
/**
 * BAML Adapters Tests
 *
 * Tests for controller and critic adapters that bridge patterns with BAML.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockFinalAction, mockCriticResult } from '../../mocks/baml'

// Mock server-only imports
vi.mock('@hames/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

// Mock MCP listTools.
//
// The catalog is mutable so one test can model what `listTools` ACTUALLY does
// under a dead gateway: it degrades to the app-side tools rather than throwing
// (#278 F1). Every other test leaves it at the default three.
const mockCatalog = { names: ['read_neo4j_cypher', 'write_neo4j_cypher', 'Return'] }
const MOCK_CATALOG_DEFAULT = [...mockCatalog.names]
vi.mock('@hames/harness-patterns/mcp-client.server', () => ({
  listTools: vi.fn(async () =>
    mockCatalog.names.map((name) => ({ name, description: `Mock ${name} tool` })),
  ),
}))

// Mock BAML client
const mockLoopController = vi.fn()
const mockActorController = vi.fn()
const mockCritic = vi.fn()
const mockResultDescribe = vi.fn()
const mockResultDescribeBatch = vi.fn()
const mockPlanner = vi.fn()

vi.mock('@hames/harness-baml/baml_client', () => ({
  b: {
    LoopController: mockLoopController,
    ActorController: mockActorController,
    Critic: mockCritic,
    ResultDescribe: (...args: unknown[]) => mockResultDescribe(...args),
    ResultDescribeBatch: (...args: unknown[]) => mockResultDescribeBatch(...args),
    Planner: (...args: unknown[]) => mockPlanner(...args),
  },
}))

/**
 * Run `fn` with the self-hosted tier in force.
 *
 * Through the real `runWithInferenceTier` scope rather than by stubbing
 * `clientOverrideFor`: the claim under test is "this call site spreads whatever
 * the active tier says", and a stubbed override would prove only that the
 * stub was called. The endpoint values are fakes — nothing opens a socket, they
 * exist to satisfy the fail-closed check the scope runs before `fn`.
 */
async function withVerdaTier<T>(fn: () => Promise<T>): Promise<T> {
  const clients = await import('@hames/harness-baml/clients.server')
  // BOTH endpoints: the private tier is the 27B plus the 4B summarizer, and a
  // scope naming it without the second is refused outright (2026-08-26).
  const KEYS = ['VERDA_INFERENCE_ENDPOINT', 'VERDA_INFERENCE_API_KEY', 'SMALL_LLM_BASE_URL']
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  process.env.VERDA_INFERENCE_ENDPOINT = 'https://example.invalid/deployment/v1'
  process.env.VERDA_INFERENCE_API_KEY = 'test-key'
  process.env.SMALL_LLM_BASE_URL = 'https://example.invalid/small/v1'
  try {
    // The tier is a SLOT of the run frame since #374, and the fail-closed
    // reachability check the old opener made on the way in is now the
    // host-called `assertInferenceTier`. Both, in that order, is what a turn does.
    const { withRunFrame } = await import('@hames/harness-patterns/run-frame.server')
    clients.assertInferenceTier('verda')
    return await withRunFrame({ inference: { tier: 'verda' } }, fn)
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  }
}

describe('createLoopControllerAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoopController.mockResolvedValue(mockFinalAction())
  })

  it('should create a controller function', async () => {
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')

    const controller = createLoopControllerAdapter()
    expect(controller).toBeDefined()
    expect(typeof controller).toBe('function')
  })

  it('should return action and llmCall data', async () => {
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')

    const controller = createLoopControllerAdapter()

    const result = await controller('user message', 'intent', '[]', 0)

    expect(result.action).toBeDefined()
    expect(result.action.is_final).toBe(true)
  })

  it('should call LoopController with correct parameters', async () => {
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')

    const controller = createLoopControllerAdapter('Custom context')

    await controller('user message', 'test intent', '[]', 0)

    expect(mockLoopController).toHaveBeenCalled()
    const [userMsg, intent] = mockLoopController.mock.calls[0]
    expect(userMsg).toBe('user message')
    expect(intent).toBe('test intent')
  })

  it('should pass contextPrefix as context when no schema', async () => {
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')

    const controller = createLoopControllerAdapter('Domain instructions here')

    await controller('msg', 'intent', '[]', 0)

    // context is 5th arg to LoopController
    const [, , , , context] = mockLoopController.mock.calls[0]
    expect(context).toBe('Domain instructions here')
  })

  it('should combine contextPrefix and schema in context', async () => {
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')

    const controller = createLoopControllerAdapter('Domain instructions')

    // schema is the 5th arg to the controller adapter
    await controller('msg', 'intent', '[]', 0, 'Node: Person, Company')

    const [, , , , context] = mockLoopController.mock.calls[0]
    expect(context).toContain('Domain instructions')
    expect(context).toContain('GRAPH SCHEMA:')
    expect(context).toContain('Node: Person, Company')
  })

  it('sends planContext as its own BAML argument, never merged into context (#27)', async () => {
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')

    const controller = createLoopControllerAdapter('Domain instructions')

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
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')

    const controller = createLoopControllerAdapter()

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
      await import('@hames/harness-baml/baml-adapters.server')

    const controller = createActorControllerAdapter(['code-mode', 'Return'])
    expect(controller).toBeDefined()
    expect(typeof controller).toBe('function')
  })

  it('should return action and llmCall data', async () => {
    const { createActorControllerAdapter } =
      await import('@hames/harness-baml/baml-adapters.server')

    const controller = createActorControllerAdapter(['code-mode', 'Return'])

    const result = await controller('user message', 'intent', ['code-mode'], [])

    expect(result.action).toBeDefined()
    expect(result.action.is_final).toBe(true)
  })

  it('should prepend planContext ahead of its own contextPrefix (#27)', async () => {
    const { createActorControllerAdapter } =
      await import('@hames/harness-baml/baml-adapters.server')

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
    const { createPlannerAdapter } = await import('@hames/harness-baml/baml-adapters.server')

    const plannerFn = createPlannerAdapter(['read_neo4j_cypher'])
    const result = await plannerFn('msg', 'intent', 'Node: Person')

    expect(result.plan).toEqual(PLAN)
    const [userMessage, intent, tools, context] = mockPlanner.mock.calls[0]
    expect(userMessage).toBe('msg')
    expect(intent).toBe('intent')
    expect((tools as Array<{ name: string }>).map((t) => t.name)).toEqual(['read_neo4j_cypher'])
    expect(context).toBe('Node: Person')
  })

  it('does not let a degraded catalog outlive the outage', async () => {
    // #278 F1, second order. The tool-description cache is module-level with no
    // expiry and no invalidation on recovery, and `listTools` degrades to the
    // app-side tools instead of throwing — so one read taken while the gateway
    // was unreachable used to pin an amputated catalog for the rest of the
    // PROCESS. The loop still held its allowlist, so nothing refused: the
    // controller was simply shown no tools, picked one it had never been
    // offered, and was rejected by the allowlist check. Found by scenario 9's
    // control case ("answers normally again once the gateway is back") once the
    // file drove `general`, whose planner reaches the catalog before the loop's
    // outage guard gets a chance to refuse.
    const health = await import('@hames/harness-patterns/gateway-health.server')
    const { createPlannerAdapter, invalidateToolDescriptions } =
      await import('@hames/harness-baml/baml-adapters.server')

    invalidateToolDescriptions()
    health.__resetGatewayHealth()
    health.markGatewayUnreachable('ECONNREFUSED 127.0.0.1:8811')
    // What the failure path returns: the app-side survivors, no gateway tools.
    mockCatalog.names = ['graph_me']

    await createPlannerAdapter(['read_neo4j_cypher'])('msg', 'intent')
    expect(mockPlanner.mock.calls[0][2], 'the degraded read showed a tool it did not have').toEqual(
      [],
    )

    health.markGatewayReachable()
    mockCatalog.names = [...MOCK_CATALOG_DEFAULT]
    const after = await createPlannerAdapter(['read_neo4j_cypher'])('msg', 'intent')

    expect(after.plan).toEqual(PLAN)
    expect(
      (mockPlanner.mock.calls[1][2] as Array<{ name: string }>).map((t) => t.name),
      'the catalog cached during the outage survived the recovery',
    ).toEqual(['read_neo4j_cypher'])

    health.__resetGatewayHealth()
    mockCatalog.names = [...MOCK_CATALOG_DEFAULT]
    invalidateToolDescriptions()
  })

  it('propagates a non-recoverable failure as an LLMCallError', async () => {
    const { createPlannerAdapter, LLMCallError } =
      await import('@hames/harness-baml/baml-adapters.server')

    mockPlanner.mockRejectedValue(new Error('planner unavailable'))
    const plannerFn = createPlannerAdapter(['read_neo4j_cypher'])

    await expect(plannerFn('msg', 'intent')).rejects.toBeInstanceOf(LLMCallError)
    // No retry for a plain failure — the retry path is truncation/empty only.
    expect(mockPlanner).toHaveBeenCalledTimes(1)
  })

  it('reports the tool count the model was actually shown', async () => {
    const { createPlannerAdapter } = await import('@hames/harness-baml/baml-adapters.server')

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

  it("passes no client override — the planner runs on planner.baml's declared client", async () => {
    // Nothing swaps the planner's client at runtime any more (the
    // USE_MIXED_CHAINS override that used to pin it here is gone), so the
    // options bag must carry the collector and NOTHING else. A stray
    // `client` here would silently route the largest prompt in the repo
    // somewhere planner.baml never declared.
    const { createPlannerAdapter } = await import('@hames/harness-baml/baml-adapters.server')

    await createPlannerAdapter(['read_neo4j_cypher'])('msg', 'intent')

    const opts = mockPlanner.mock.calls[0][4] as { client?: string } | undefined
    expect(opts?.client).toBeUndefined()
  })
})

describe('createCriticAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCritic.mockResolvedValue(mockCriticResult())
  })

  it('should create a critic function', async () => {
    const { createCriticAdapter } = await import('@hames/harness-baml/baml-adapters.server')

    const critic = createCriticAdapter()
    expect(critic).toBeDefined()
    expect(typeof critic).toBe('function')
  })

  it('should return result and llmCall data', async () => {
    const { createCriticAdapter } = await import('@hames/harness-baml/baml-adapters.server')

    const critic = createCriticAdapter()

    const result = await critic('intent', [])

    expect(result.result).toBeDefined()
    expect(result.result.is_sufficient).toBe(true)
  })
})

describe('the tool list rides the seam (L14, #225 Lane B3)', () => {
  // The seven domain controller factories (`createNeo4jController` etc.) were
  // argument-only aliases, deleted once the tool list moved onto
  // `ControllerInput.tools` — what these tests pin instead is the property
  // that made the aliases pointless: the loop's allowlist is what the prompt
  // advertises, declared once, on the object seam.
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoopController.mockResolvedValue(mockFinalAction())
  })

  it("the object seam's `tools` is what reaches the BAML call", async () => {
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')

    const controller = createLoopControllerAdapter()
    await controller({
      userMessage: 'query',
      intent: 'intent',
      tools: ['read_neo4j_cypher', 'Return'],
      turns: [],
      turn: 0,
    })

    expect(mockLoopController).toHaveBeenCalled()
    // 3rd arg of LoopController is the `tools` array — filtered to input.tools.
    const advertised = (mockLoopController.mock.calls[0][2] as Array<{ name: string }>).map(
      (t) => t.name,
    )
    expect(advertised).toContain('read_neo4j_cypher')
    expect(advertised).not.toContain('write_neo4j_cypher')
  })

  it('the legacy positional form advertises nothing from the gateway (it predates the field)', async () => {
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')

    const controller = createLoopControllerAdapter()
    await controller('query', 'intent', '[]', 0)

    expect(mockLoopController).toHaveBeenCalled()
    const advertised = mockLoopController.mock.calls[0][2] as Array<{ name: string }>
    expect(advertised).toEqual([])
  })
})

describe('legacy positional form: previous_results parsing (Lane A4)', () => {
  // `parseResultsToTurns` was deleted with the string round-trip: its catch
  // silently returned `[]` on unparseable/non-array input, so a controller
  // handed garbage believed it was on turn 0 and quietly repeated its first
  // tool call. The legacy form — kept only for the adapter-level acceptance
  // tests — parses STRICTLY and throws. These tests pin the replacement of
  // the silent failure, not the silent failure itself.
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoopController.mockResolvedValue(mockFinalAction())
  })

  it('should handle empty array previous_results', async () => {
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')

    const controller = createLoopControllerAdapter()

    await controller('user message', 'intent', '[]', 0)
    expect(mockLoopController).toHaveBeenCalled()
  })

  it('should handle array of results', async () => {
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')

    const controller = createLoopControllerAdapter()

    const results = JSON.stringify([{ data: 'result1' }, { data: 'result2' }])

    await controller('user message', 'intent', results, 2)
    expect(mockLoopController).toHaveBeenCalled()

    // The turns should be passed to LoopController
    const calls = mockLoopController.mock.calls[0]
    expect(calls).toBeDefined()
  })

  it('THROWS on invalid JSON — the silent-[] catch is gone', async () => {
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')

    const controller = createLoopControllerAdapter()

    // Invalid JSON used to be swallowed into `[]` (turn 0, no history); now
    // the legacy shim throws loudly.
    await expect(controller('user message', 'intent', 'not valid json', 0)).rejects.toThrow()
    expect(mockLoopController).not.toHaveBeenCalled()
  })

  it('THROWS on non-array JSON — the silent-[] catch is gone', async () => {
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')

    const controller = createLoopControllerAdapter()

    // Object instead of array used to be swallowed into `[]`; now it throws.
    await expect(controller('user message', 'intent', '{"key": "value"}', 0)).rejects.toThrow()
    expect(mockLoopController).not.toHaveBeenCalled()
  })

  it('THROWS on an empty previous_results string — the silent-[] catch is gone', async () => {
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')

    const controller = createLoopControllerAdapter()

    await expect(controller('user message', 'intent', '', 0)).rejects.toThrow()
    expect(mockLoopController).not.toHaveBeenCalled()
  })
})

describe('extractLLMCallData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should extract all fields from a collector with full data', async () => {
    const { extractLLMCallData } = await import('@hames/harness-baml/baml-adapters.server')

    const collector = {
      last: {
        rawLlmResponse: '{"tool_name":"Return","is_final":true}',
        usage: { inputTokens: 150, outputTokens: 30, cachedInputTokens: 50 },
        calls: [
          {
            httpRequest: { body: '{"messages":[{"role":"user","content":"test"}]}' },
            provider: 'anthropic',
            clientName: 'AnthropicHaiku45',
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
    expect(result!.provider).toBe('anthropic')
    expect(result!.clientName).toBe('AnthropicHaiku45')
    expect(result!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('should return undefined when collector has no last property', async () => {
    const { extractLLMCallData } = await import('@hames/harness-baml/baml-adapters.server')

    const collector = { last: undefined }

    const result = extractLLMCallData(collector as any, 'LoopController', {}, Date.now())

    expect(result).toBeUndefined()
  })

  it('should handle missing provider and clientName', async () => {
    const { extractLLMCallData } = await import('@hames/harness-baml/baml-adapters.server')

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
    const { extractLLMCallData } = await import('@hames/harness-baml/baml-adapters.server')

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
    const { extractLLMCallData } = await import('@hames/harness-baml/baml-adapters.server')

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
    const { extractLLMCallData } = await import('@hames/harness-baml/baml-adapters.server')

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
    const { extractLLMCallData } = await import('@hames/harness-baml/baml-adapters.server')

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
            provider: 'anthropic',
            clientName: 'AnthropicSonnet5',
          },
        ],
      },
    }

    const result = extractLLMCallData(collector as never, 'LoopController', {}, Date.now())

    expect(result).toBeDefined()
    expect(result!.rawInput).toBe(bodyText)
    expect(result!.rawInput).not.toBe('{}')
    expect(result!.provider).toBe('anthropic')
    expect(result!.clientName).toBe('AnthropicSonnet5')
  })

  it('should prefer the selected call when fallbacks produce multiple entries', async () => {
    const { extractLLMCallData } = await import('@hames/harness-baml/baml-adapters.server')

    const failedBody = Object.create({ text: () => 'FAILED_BODY' })
    const goodBody = Object.create({ text: () => 'GOOD_BODY' })

    const collector = {
      last: {
        rawLlmResponse: 'output',
        calls: [
          {
            httpRequest: { body: failedBody },
            selected: false,
            provider: 'anthropic',
            clientName: 'AnthropicSonnet5NoThink',
          },
          {
            httpRequest: { body: goodBody },
            selected: true,
            provider: 'anthropic',
            clientName: 'AnthropicSonnet46NoThink',
          },
        ],
      },
    }

    const result = extractLLMCallData(collector as never, 'LoopController', {}, Date.now())

    expect(result!.rawInput).toBe('GOOD_BODY')
    expect(result!.clientName).toBe('AnthropicSonnet46NoThink')
  })

  it('should populate promptTemplate with the Jinja template (placeholders intact)', async () => {
    const { extractLLMCallData } = await import('@hames/harness-baml/baml-adapters.server')

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
    const { describeToolResultOp } = await import('@hames/harness-baml/baml-adapters.server')
    mockResultDescribe.mockResolvedValue('Found 3 nodes in the graph.')

    const result = await describeToolResultOp(
      'read_neo4j_cypher',
      '{"query":"MATCH (n) RETURN n"}',
      'Need to list nodes',
      '[{name:"A"},{name:"B"},{name:"C"}]',
    )

    expect(result).toBe('Found 3 nodes in the graph.')
    // OUTSIDE a verda scope the trailing options bag carries a collector and
    // NOTHING else — no `client` key, so the function runs the chain
    // `describe.baml` declares. The collector is not optional either: describe
    // is the repo's highest-frequency role, so an unaccounted describe call
    // biases the preview header's on-prem share by shrinking its denominator.
    expect(mockResultDescribe).toHaveBeenCalledWith(
      'read_neo4j_cypher',
      '{"query":"MATCH (n) RETURN n"}',
      'Need to list nodes',
      '[{name:"A"},{name:"B"},{name:"C"}]',
      expect.anything(),
    )
    expect(Object.keys(mockResultDescribe.mock.calls[0][4] as object)).toEqual(['collector'])
  })

  it('adds the client override inside a verda scope', async () => {
    // The 2026-08-26 half of the pair above. `clients-verda.test.ts` greps for
    // the literal ONCE PER ROLE, and describe has six call sites, so five could
    // lose their spread and stay green there; the e2e tier scenario only ever
    // exercises whichever describe path that turn happened to take. This is the
    // per-call-site check for the two that carry tool results.
    //
    // `LocalQwenSmall`, not `VerdaQwen` — the describe flip later the same day.
    // Asserting the specific client rather than "some override" is what makes
    // this the test that would catch summarization being sent to the 27B (or to
    // Anthropic) on a private-tier turn.
    const { describeToolResultOp } = await import('@hames/harness-baml/baml-adapters.server')
    mockResultDescribe.mockResolvedValue('ok')

    await withVerdaTier(() => describeToolResultOp('search', '{}', '', 'data'))

    expect(mockResultDescribe.mock.calls[0][4]).toMatchObject({ client: 'LocalQwenSmall' })
  })

  it('should return empty string on failure', async () => {
    const { describeToolResultOp } = await import('@hames/harness-baml/baml-adapters.server')
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
    const { describeToolResultsBatchOp } = await import('@hames/harness-baml/baml-adapters.server')
    mockResultDescribeBatch.mockResolvedValue({
      summaries: [
        { id: '2', summary: 'Fetched B.' },
        { id: '1', summary: 'Found A.' },
      ],
    })

    const byId = await describeToolResultsBatchOp(items)

    expect(byId.get('1')).toBe('Found A.')
    expect(byId.get('2')).toBe('Fetched B.')
    // `toolArgs` is renamed to the BAML class's snake_case `tool_args`; outside
    // a verda scope the trailing bag is the accounting collector only (see
    // `describeToolResultOp`).
    expect(mockResultDescribeBatch).toHaveBeenCalledWith(
      [
        { id: '1', tool: 'search', tool_args: '{"q":"a"}', reasoning: 'find a', result: 'A' },
        { id: '2', tool: 'fetch', tool_args: '{"url":"b"}', reasoning: '', result: 'B' },
      ],
      expect.anything(),
    )
    expect(Object.keys(mockResultDescribeBatch.mock.calls[0][1] as object)).toEqual(['collector'])
  })

  it('adds the client override inside a verda scope', async () => {
    // The BATCH path specifically. The e2e tier scenario cannot reach it — its
    // turns produce a single tool result, which routes to the single-item call
    // — so without this the busiest describe path would be pinned by nothing
    // but a per-role grep. It is also the call that carries the most user data
    // in one prompt (SD-10: several tool results, verbatim).
    const { describeToolResultsBatchOp } = await import('@hames/harness-baml/baml-adapters.server')
    mockResultDescribeBatch.mockResolvedValue({ summaries: [{ id: '1', summary: 'A.' }] })

    await withVerdaTier(() => describeToolResultsBatchOp(items))

    expect(mockResultDescribeBatch.mock.calls[0][1]).toMatchObject({ client: 'LocalQwenSmall' })
  })

  it('omits ids the model dropped or answered blank', async () => {
    const { describeToolResultsBatchOp } = await import('@hames/harness-baml/baml-adapters.server')
    mockResultDescribeBatch.mockResolvedValue({
      summaries: [{ id: '1', summary: '   ' }],
    })

    const byId = await describeToolResultsBatchOp(items)

    // Blank trims to nothing → treated as unanswered, same as the missing '2'
    expect(byId.size).toBe(0)
  })

  it('discards summaries for ids that were never requested', async () => {
    const { describeToolResultsBatchOp } = await import('@hames/harness-baml/baml-adapters.server')
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
    const { describeToolResultsBatchOp } = await import('@hames/harness-baml/baml-adapters.server')
    mockResultDescribeBatch.mockRejectedValue(new Error('Model unavailable'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const byId = await describeToolResultsBatchOp(items)

    expect(byId.size).toBe(0)
    // Logged, not swallowed: an always-failing batch is an N+1 cost regression
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('falling back per item'))
    warn.mockRestore()
  })

  it('makes no call at all for an empty batch', async () => {
    const { describeToolResultsBatchOp } = await import('@hames/harness-baml/baml-adapters.server')

    const byId = await describeToolResultsBatchOp([])

    expect(byId.size).toBe(0)
    expect(mockResultDescribeBatch).not.toHaveBeenCalled()
  })
})

describe('LoopController error propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('propagates a BamlValidationError in ONE call — no second-provider escalation', async () => {
    // There is no manual GroqGPT120B → GroqFast ladder any more: Anthropic is
    // the only provider, so a genuine structured-output failure is VISIBLE
    // rather than papered over by a re-invoke on a weaker model. (The
    // truncation / empty-completion retry is a different path and still fires
    // — see truncation-retry.test.ts.)
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    mockLoopController.mockRejectedValue(
      new BamlValidationError('Invalid JSON output', 'raw output', 'msg', 'detailed'),
    )

    const controller = createLoopControllerAdapter()

    await expect(controller('user message', 'intent', '[]', 0)).rejects.toThrow()
    expect(mockLoopController).toHaveBeenCalledTimes(1)
  })

  it('passes no client override on the primary call', async () => {
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')
    mockLoopController.mockResolvedValue(mockFinalAction('ok'))
    const { Collector } = await import('@boundaryml/baml')
    const collector = new Collector('test')

    await createLoopControllerAdapter()('msg', 'intent', '[]', 0, undefined, collector)

    // The options bag rides LAST, after the data params — read it off the END
    // rather than a fixed slot, so appending a trailing param (return_style,
    // #149) doesn't silently shift this assertion onto a data argument.
    const call = mockLoopController.mock.calls[0]
    const opts = call[call.length - 1] as { client?: string; collector?: unknown }
    expect(opts.collector).toBe(collector)
    expect(opts.client).toBeUndefined()
  })

  it('should propagate non-BamlValidationError errors', async () => {
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')

    mockLoopController.mockRejectedValue(new Error('Network timeout'))

    const controller = createLoopControllerAdapter()

    await expect(controller('user message', 'intent', '[]', 0)).rejects.toThrow('Network timeout')
    expect(mockLoopController).toHaveBeenCalledTimes(1)
  })
})

describe('priorResults parameter passing', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockLoopController.mockResolvedValue(mockFinalAction())
  })

  it('should pass priorResults as 6th argument to LoopController', async () => {
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')

    const controller = createLoopControllerAdapter()

    const priorResults = [{ ref_id: 'ev-abc', tool: 'search', summary: 'Found 3 results' }]

    await controller('user message', 'intent', '[]', 0, undefined, undefined, priorResults)

    expect(mockLoopController).toHaveBeenCalled()
    // LoopController args: user_message, intent, tools, turns, context, priorResults
    const [, , , , , passedPrior] = mockLoopController.mock.calls[0]
    expect(passedPrior).toEqual(priorResults)
  })

  it('should pass undefined priorResults when not provided', async () => {
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')

    const controller = createLoopControllerAdapter()

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
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')

    const controller = createLoopControllerAdapter()

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
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')

    const controller = createLoopControllerAdapter()

    await controller('msg', 'intent', '[]', 0)

    const [, , , , , , passedShots] = mockLoopController.mock.calls[0]
    expect(passedShots).toBeUndefined()
  })
})

describe('dedupByRefId', () => {
  it('drops duplicates, first occurrence wins', async () => {
    const { dedupByRefId } = await import('@hames/harness-patterns/patterns/simpleLoop.server')
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
    const { dedupByRefId } = await import('@hames/harness-patterns/patterns/simpleLoop.server')
    expect(dedupByRefId([])).toEqual([])
  })
})

describe('annotateExpansions', () => {
  it('sets expanded_in_turn to first turn whose expansions contain the ref_id', async () => {
    const { annotateExpansions } =
      await import('@hames/harness-patterns/patterns/simpleLoop.server')
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
      await import('@hames/harness-patterns/patterns/simpleLoop.server')
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
      await import('@hames/harness-baml/baml-adapters.server')

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
              provider: 'anthropic',
              clientName: 'AnthropicSonnet5NoThink',
            },
          ],
        }
      }
      throw new Error('Network down')
    })

    const controller = createLoopControllerAdapter()

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
    expect(err.llmCall.provider).toBe('anthropic')
    expect(err.llmCall.clientName).toBe('AnthropicSonnet5NoThink')
    // The original error is preserved as cause
    expect(err.cause).toBeInstanceOf(Error)
  })

  it('LLMCallError omits rawInput when the failure is pre-call (collector never recorded a call)', async () => {
    const { createLoopControllerAdapter, LLMCallError } =
      await import('@hames/harness-baml/baml-adapters.server')

    // Pre-call failure: collector stays empty (no last entry). Adapter
    // should still throw LLMCallError with promptTemplate + variables;
    // rawInput / rawOutput are undefined.
    mockLoopController.mockRejectedValue(new Error('DNS lookup failed'))

    const controller = createLoopControllerAdapter()
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

  it('wraps a structured-output failure as LLMCallError on the FIRST attempt', async () => {
    // With no second provider to escalate to, a BamlValidationError that is
    // neither a truncation nor an empty completion is wrapped and propagated
    // immediately — the panel gets the prompt/variables drill-down and the
    // failure stays visible instead of being retried on a weaker model.
    const { createLoopControllerAdapter, LLMCallError } =
      await import('@hames/harness-baml/baml-adapters.server')
    const { BamlValidationError } = await import('@boundaryml/baml')

    mockLoopController.mockRejectedValue(
      new BamlValidationError('attempt 1 invalid', 'r1', 'm1', 'd1'),
    )

    const controller = createLoopControllerAdapter()

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
    expect(mockLoopController).toHaveBeenCalledTimes(1)
  })

  it('throws LLMCallError from ActorController on BAML failure', async () => {
    const { createActorControllerAdapter, LLMCallError } =
      await import('@hames/harness-baml/baml-adapters.server')

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
      await import('@hames/harness-baml/baml-adapters.server')

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
    const { extractFailureLLMCallData } = await import('@hames/harness-baml/baml-adapters.server')

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
    const { extractFailureLLMCallData } = await import('@hames/harness-baml/baml-adapters.server')

    const bodyText = '{"messages":[{"role":"user","content":"hello"}]}'
    const httpBody = Object.create({ text: () => bodyText })
    const collector = {
      last: {
        rawLlmResponse: 'partial-or-malformed',
        calls: [
          { httpRequest: { body: httpBody }, provider: 'anthropic', clientName: 'AnthropicOpus4' },
        ],
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
    expect(result.provider).toBe('anthropic')
    expect(result.clientName).toBe('AnthropicOpus4')
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
      id: 'sandbox:sbx-1',
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
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockLoopController.mockResolvedValue(mockFinalAction())
    mockActorController.mockResolvedValue(mockFinalAction())
  })

  it('prepends sandbox tools to LoopController prompt when scope is active', async () => {
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')
    const { withRunFrame } = await import('@hames/harness-patterns/run-frame.server')

    const controller = createLoopControllerAdapter()

    await withRunFrame({ transports: [fakeTransport()] }, () =>
      controller({
        userMessage: 'msg',
        intent: 'intent',
        tools: ['read_neo4j_cypher', 'Return'],
        turns: [],
        turn: 0,
      }),
    )

    // 3rd arg of LoopController is the `tools` array.
    const tools = mockLoopController.mock.calls[0][2] as Array<{ name: string }>
    const names = tools.map((t) => t.name)
    // Sandbox tools appear first (prepended).
    expect(names.slice(0, 2)).toEqual(['sandbox_bash', 'sandbox_read'])
    // Gateway-listed tools still present.
    expect(names).toContain('read_neo4j_cypher')
  })

  it('does not include sandbox tools when no scope is active (LoopController)', async () => {
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')

    const controller = createLoopControllerAdapter()
    await controller({
      userMessage: 'msg',
      intent: 'intent',
      tools: ['read_neo4j_cypher', 'Return'],
      turns: [],
      turn: 0,
    })

    const tools = mockLoopController.mock.calls[0][2] as Array<{ name: string }>
    const names = tools.map((t) => t.name)
    expect(names).not.toContain('sandbox_bash')
    expect(names).not.toContain('sandbox_read')
  })

  it('lists a name owned by two nested scopes ONCE, from the innermost', async () => {
    // The prompt has to agree with dispatch: `callTool` sends `sandbox_bash` to
    // the innermost transport that owns it, so showing the outer one's
    // description beside it would document a machine the call never reaches.
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')
    const { withRunFrame, amendRunFrame } = await import('@hames/harness-patterns/run-frame.server')

    const scope = (id: string, description: string) => ({
      id,
      ownsTool: (n: string) => n === 'sandbox_bash',
      callTool: vi.fn(),
      listTools: async () => [
        { name: 'sandbox_bash', description, inputSchema: { type: 'object' } },
      ],
    })

    const controller = createLoopControllerAdapter()
    await withRunFrame({ transports: [scope('sandbox:outer', 'outer box')] }, () =>
      amendRunFrame({ transports: [scope('sandbox:inner', 'inner box')] }, () =>
        controller({ userMessage: 'msg', intent: 'intent', tools: ['Return'], turns: [], turn: 0 }),
      ),
    )

    const tools = mockLoopController.mock.calls[0][2] as Array<{
      name: string
      description: string
    }>
    expect(tools.filter((t) => t.name === 'sandbox_bash')).toHaveLength(1)
    expect(tools.find((t) => t.name === 'sandbox_bash')!.description).toBe('inner box')
  })

  it('prepends sandbox tools to ActorController prompt when scope is active', async () => {
    const { createActorControllerAdapter } =
      await import('@hames/harness-baml/baml-adapters.server')
    const { withRunFrame } = await import('@hames/harness-patterns/run-frame.server')

    const controller = createActorControllerAdapter(['code-mode', 'Return'])

    await withRunFrame({ transports: [fakeTransport()] }, () => controller('msg', 'intent', [], []))

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
    const { warnIfCollectorEmpty } = await import('@hames/harness-baml/baml-adapters.server')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(warnIfCollectorEmpty(undefined, 'LoopController')).toBe(false)
    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })

  it('returns false and stays silent when the collector captured a call', async () => {
    const { warnIfCollectorEmpty } = await import('@hames/harness-baml/baml-adapters.server')
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
    const { warnIfCollectorEmpty } = await import('@hames/harness-baml/baml-adapters.server')
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
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')
    const { Collector } = await import('@boundaryml/baml')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const controller = createLoopControllerAdapter()
    const result = await controller('msg', 'intent', '[]', 0, undefined, new Collector('test'))

    expect(result.action).toBeDefined()
    expect(result.llmCall).toBeUndefined()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0][0] as string).toContain('LoopController')
    warnSpy.mockRestore()
  })

  it('fires for Critic too, naming Critic', async () => {
    const { createCriticAdapter } = await import('@hames/harness-baml/baml-adapters.server')
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
    const { createLoopControllerAdapter } = await import('@hames/harness-baml/baml-adapters.server')
    const { Collector } = await import('@boundaryml/baml')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    mockLoopController.mockRejectedValue(new Error('DNS lookup failed'))
    const controller = createLoopControllerAdapter()

    await expect(
      controller('msg', 'intent', '[]', 0, undefined, new Collector('test')),
    ).rejects.toThrow('DNS lookup failed')

    expect(warnSpy).not.toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})

describe('extractPromptTemplates', () => {
  it('matches a signature whose comment contains a parenthesis', async () => {
    const { extractPromptTemplates } = await import('@hames/harness-baml/baml-adapters.server')
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
