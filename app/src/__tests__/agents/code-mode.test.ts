/**
 * Code Mode Agent — E2E-shaped (Issue #12 / #28 row 1.3)
 *
 * Drives the dedicated code-mode agent through router → routes(chain(actorCritic, synth))
 * with mocked LLM + MCP. Asserts:
 *  - pattern_enter sequence covers router → code-mode-loop → code-mode-synth
 *  - the gateway's `code-mode` factory is called, the cache invalidation hook
 *    fires (Synthesize sees only actor-side events, no critic_result leak)
 *  - direct-response branch (Router needs_tool=false) skips the loop entirely
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mockAction, mockFinalAction, mockCriticResult } from '../mocks/baml'
import { mockCallTool, mockListTools } from '../mocks/mcp'

const mockToolSets = {
  code: ['mcp-find', 'mcp-add', 'code-mode', 'mcp-exec', 'Return'],
  all: [] as string[],
}
mockToolSets.all = [...mockToolSets.code]

vi.mock('../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

const callToolMock = mockCallTool({
  responses: {
    'mcp-find': { servers: ['neo4j-cypher', 'fetch'] },
    'mcp-add': { ok: true },
    'code-mode': { tool_name: 'code-mode-graph-search' },
    'code-mode-graph-search': { nodes: [{ name: 'planning-agent', degree: 12 }] },
  },
})

vi.mock('../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: callToolMock,
  listTools: mockListTools(mockToolSets.all),
}))

const actorController = vi.fn()
const critic = vi.fn()
const router = vi.fn()
const synthesize = vi.fn()

vi.mock('../../../baml_client', () => ({
  b: {
    LoopController: vi.fn(async () => mockFinalAction()),
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

vi.mock('../../lib/harness-patterns/tools.server', () => ({
  Tools: vi.fn(async () => mockToolSets),
  ToolsFrom: vi.fn(() => mockToolSets),
}))

// The code-mode agent dynamically imports `loadSession` inside its
// toolNamesProvider closure to avoid a top-level circular import with the
// agent registry. Tests that exercise the allowlist branch override this
// mock per-test via vi.mocked(loadSession).mockResolvedValueOnce(...).
const loadSessionMock = vi.fn(
  async () => null as null | { serializedContext: string; agentId: string },
)
vi.mock('../../lib/harness-client/session.server', () => ({
  loadSession: loadSessionMock,
}))

// Default to "no userId scope" so the existing tests (which don't care about
// the allowlist) flow through the closure's null guard. Tests that need it
// override per-test.
const getRequestUserIdMock = vi.fn(() => null as string | null)
vi.mock('../../lib/harness-client/request-user.server', () => ({
  getRequestUserId: getRequestUserIdMock,
  runWithUserId: (_uid: string, fn: () => Promise<unknown>) => fn(),
  getRequestSessionId: vi.fn(() => null),
  runWithRequestContext: (_c: unknown, fn: () => Promise<unknown>) => fn(),
}))

describe('code-mode agent — router → routes(chain(actorCritic, synth))', () => {
  beforeEach(() => {
    vi.clearAllMocks()

    router.mockResolvedValue({
      intent: 'Find the most connected node and search the web for it',
      needs_tool: true,
      route: 'code_mode',
      response: '',
    })

    // Three actor attempts: find servers → create code-mode tool → invoke it.
    actorController
      .mockResolvedValueOnce(
        mockAction({
          reasoning: 'Discover available gateway servers.',
          tool_name: 'mcp-find',
          tool_args: '{}',
        }),
      )
      .mockResolvedValueOnce(
        mockAction({
          reasoning: 'Create a code-mode tool bound to neo4j and fetch.',
          tool_name: 'code-mode',
          tool_args: JSON.stringify({ name: 'graph-search', servers: ['neo4j-cypher', 'fetch'] }),
        }),
      )
      .mockResolvedValueOnce(
        mockAction({
          reasoning: 'Invoke the registered tool with a query script.',
          tool_name: 'code-mode-graph-search', // matches dynamicToolPattern /^code-mode-/
          tool_args: '{"script":"return ok;"}',
        }),
      )

    // First two attempts (mcp-find, code-mode factory) are setup steps — critic
    // says "not done yet" so the loop continues to the next actor call. On the
    // third attempt the actor invokes the registered tool; the critic accepts
    // the result (post-P0 Return-from-critic: the loop exits when the critic
    // says `is_sufficient: true`, never when the actor calls "Return").
    critic
      .mockResolvedValueOnce(
        mockCriticResult({ is_sufficient: false, explanation: 'Need to create code-mode tool' }),
      )
      .mockResolvedValueOnce(
        mockCriticResult({ is_sufficient: false, explanation: 'Need to call generated tool' }),
      )
      .mockResolvedValue(mockCriticResult({ is_sufficient: true }))
    synthesize.mockResolvedValue('Most connected node is planning-agent.')
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('runs the factory workflow and synthesizes from actor events only', async () => {
    const { codeModeAgent } = await import('../../lib/harness-client/examples/code-mode.server')
    const { harness } = await import('../../lib/harness-patterns/harness.server')

    const patterns = await codeModeAgent.createPatterns('test-session')
    const agent = harness(...patterns)

    const result = await agent('Find the most connected node and search the web for it.')

    expect(result.status).not.toBe('error')
    expect(result.response).toContain('planning-agent')

    expect(router).toHaveBeenCalledTimes(1)

    // Pattern lifecycle covers the router and inner chain (loop + synth).
    const enterEvents = result.context.events.filter((e) => e.type === 'pattern_enter')
    const enteredIds = enterEvents.map((e) => e.patternId)
    expect(enteredIds.some((id) => id === 'code-mode-loop')).toBe(true)
    expect(enteredIds.some((id) => id === 'code-mode-synth')).toBe(true)

    // Factory was invoked.
    const codeModeCalls = callToolMock.mock.calls.filter(([tool]) => tool === 'code-mode')
    expect(codeModeCalls.length).toBe(1)
    expect((codeModeCalls[0][1] as { name?: string }).name).toBe('graph-search')

    // compactExecution's view was filtered: when Synthesize was called, the turns
    // it received describe only actor-side tool events, no critic verdicts.
    // (`viewConfig.eventTypes` excludes 'critic_result'.)
    //
    // BAML signature: Synthesize(userMessage, intent, turns, hasError, errorMessage).
    expect(synthesize).toHaveBeenCalledTimes(1)
    const synthCallArgs = synthesize.mock.calls[0]
    const turnsArg = synthCallArgs[2] as unknown[]
    const turnsJson = JSON.stringify(turnsArg)
    expect(turnsJson.includes('is_sufficient')).toBe(false) // critic_result never leaked

    // Regression for the chain() scope-reuse bug (hallucination-codemode-3.json):
    // Events emitted inside the loop must carry the loop's patternId, not the
    // chain's auto-generated id. Without this, the synth's `fromLastPattern`
    // view filter excludes the actor's tool events, and the synth fabricates
    // a response over an empty turns array.
    const actorActionEvents = result.context.events.filter((e) => e.type === 'controller_action')
    expect(actorActionEvents.length).toBeGreaterThan(0)
    expect(actorActionEvents.every((e) => e.patternId === 'code-mode-loop')).toBe(true)
    // And the synth's view did surface non-empty turns.
    expect(Array.isArray(turnsArg)).toBe(true)
    expect(turnsArg.length).toBeGreaterThan(0)
  })

  it('skips the loop on direct-response (Router needs_tool=false)', async () => {
    router.mockResolvedValue({
      intent: 'Greeting',
      needs_tool: false,
      route: null,
      response: 'Hi! I orchestrate MCP tools via code-mode.',
    })

    const { codeModeAgent } = await import('../../lib/harness-client/examples/code-mode.server')
    const { harness } = await import('../../lib/harness-patterns/harness.server')

    const patterns = await codeModeAgent.createPatterns('test-session')
    const agent = harness(...patterns)

    const result = await agent('Hello, what can you do?')

    expect(actorController).not.toHaveBeenCalled()
    expect(callToolMock.mock.calls.filter(([t]) => t === 'code-mode').length).toBe(0)
    expect(result.response).toContain('I orchestrate MCP tools')
  })
})

describe('code-mode agent — retry budget + per-conversation allowlist', () => {
  beforeEach(() => {
    // Full reset (not just clearAllMocks): the previous describe's "needs_tool=false"
    // test queues 3 actor/critic Once-values it never consumes, and vi.clearAllMocks
    // leaves those queues intact — they'd pollute our actor queue here.
    actorController.mockReset()
    critic.mockReset()
    router.mockReset()
    synthesize.mockReset()
    callToolMock.mockClear()
    loadSessionMock.mockReset()
    loadSessionMock.mockResolvedValue(null)
    getRequestUserIdMock.mockReset()
    getRequestUserIdMock.mockReturnValue(null)
    router.mockResolvedValue({
      intent: 'multi-step',
      needs_tool: true,
      route: 'code_mode',
      response: '',
    })
    synthesize.mockResolvedValue('Done.')
  })

  afterEach(() => {
    vi.resetModules()
    // Restore shared module-level state mutated by individual tests so the
    // ordering doesn't leak between cases. NOTE: mockListTools captured a
    // reference to mockToolSets.all at module load; we must mutate the
    // existing array in place rather than reassign, otherwise the captured
    // reference still points at the previous test's array.
    mockToolSets.all.length = 0
    mockToolSets.all.push(...mockToolSets.code)
    getRequestUserIdMock.mockReturnValue(null)
  })

  it('survives more than 3 non-final turns (maxRetries: 8 vs default 3)', async () => {
    // Five setup/exploration actor turns, then the default (mockResolvedValue)
    // flips to a real tool action that the critic eventually accepts. Default
    // maxRetries=3 (settings.ts:18) would emit "Max retries (3) exceeded" at
    // turn 3. With maxRetries: 8 on the code-mode loop, the loop reaches the
    // turn where the critic returns is_sufficient: true (post-P0: only the
    // critic can exit the loop).
    actorController
      .mockResolvedValueOnce(mockAction({ tool_name: 'mcp-find', tool_args: '{}' }))
      .mockResolvedValueOnce(mockAction({ tool_name: 'mcp-find', tool_args: '{}' }))
      .mockResolvedValueOnce(mockAction({ tool_name: 'mcp-add', tool_args: '{"name":"memory"}' }))
      .mockResolvedValueOnce(
        mockAction({ tool_name: 'mcp-add', tool_args: '{"name":"web_search"}' }),
      )
      .mockResolvedValue(
        mockAction({
          tool_name: 'code-mode',
          tool_args: JSON.stringify({ name: 'graph-search', servers: ['neo4j-cypher'] }),
        }),
      )

    critic
      .mockResolvedValueOnce(mockCriticResult({ is_sufficient: false, explanation: 'keep going' }))
      .mockResolvedValueOnce(mockCriticResult({ is_sufficient: false, explanation: 'keep going' }))
      .mockResolvedValueOnce(mockCriticResult({ is_sufficient: false, explanation: 'keep going' }))
      .mockResolvedValueOnce(mockCriticResult({ is_sufficient: false, explanation: 'keep going' }))
      .mockResolvedValue(mockCriticResult({ is_sufficient: true }))
    synthesize.mockResolvedValue('All steps complete.')

    const { codeModeAgent } = await import('../../lib/harness-client/examples/code-mode.server')
    const { harness } = await import('../../lib/harness-patterns/harness.server')

    const patterns = await codeModeAgent.createPatterns('test-session')
    const agent = harness(...patterns)
    const result = await agent('Do a multi-step thing.')

    // No "Max retries exceeded" — the regression that motivated maxRetries: 8.
    const retryExhausted = result.context.events.filter(
      (e) => e.type === 'error' && /Max retries/.test((e.data as { error?: string }).error ?? ''),
    )
    expect(retryExhausted).toEqual([])
    expect(actorController.mock.calls.length).toBeGreaterThan(3)
    expect(result.response).toContain('All steps complete.')
  })

  it('passes the per-conversation allowlist to the actor', async () => {
    // Gateway exposes the meta-tools plus the user's extras. Mutate in place
    // — mockListTools captured the array reference at module load.
    mockToolSets.all.push('read_neo4j_cypher', 'search')

    // Pretend we're inside a runWithUserId scope.
    getRequestUserIdMock.mockReturnValue('user-1')

    // Persisted conversation context with a user-curated allowlist on data.
    loadSessionMock.mockResolvedValue({
      serializedContext: JSON.stringify({
        sessionId: 'test-session',
        input: 'do thing',
        status: 'running',
        createdAt: 0,
        events: [],
        data: { codeModeAllowedTools: ['read_neo4j_cypher', 'search'] },
      }),
      agentId: 'code-mode',
    })

    // Post-P0: actor exits via critic, not via Return. Use a real tool action
    // and let the critic say sufficient after one turn.
    actorController.mockResolvedValue(
      mockAction({ tool_name: 'code-mode', tool_args: '{"name":"x","servers":["x"]}' }),
    )
    critic.mockResolvedValue(mockCriticResult({ is_sufficient: true }))

    const { codeModeAgent } = await import('../../lib/harness-client/examples/code-mode.server')
    const { harness } = await import('../../lib/harness-patterns/harness.server')

    const patterns = await codeModeAgent.createPatterns('test-session')
    const agent = harness(...patterns)
    await agent('do thing')

    // The actor receives ToolDescription[] at arg index 2 of ActorController:
    // (user_message, intent, tools, attempts, ...). The allowlist union
    // (meta-tools ∪ user picks) must be present.
    expect(actorController).toHaveBeenCalledTimes(1)
    const toolsArg = actorController.mock.calls[0][2] as Array<{ name: string }>
    const toolNames = toolsArg.map((t) => t.name)
    expect(toolNames).toEqual(
      expect.arrayContaining([
        'mcp-find',
        'mcp-add',
        'code-mode',
        'mcp-exec',
        'read_neo4j_cypher',
        'search',
      ]),
    )
  })
})
