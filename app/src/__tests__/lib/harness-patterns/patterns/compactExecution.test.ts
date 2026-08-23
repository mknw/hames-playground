/**
 * compactExecution Pattern Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock server-only imports
vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

// Mock BAML client
vi.mock('../../../../../baml_client', () => ({
  b: {
    Synthesize: vi.fn(async () => 'Synthesized response from BAML'),
  },
}))

// Mock Collector — must be a real class so `new Collector()` works
vi.mock('@boundaryml/baml', () => {
  class MockCollector {
    last = {
      rawLlmResponse: 'Raw response',
      usage: { inputTokens: 100, outputTokens: 50 },
      calls: [{ httpRequest: { body: { messages: [] } } }],
    }
    constructor(_name?: string) {}
  }
  return { Collector: MockCollector }
})

describe('compactExecution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should export compactExecution function', async () => {
    const { compactExecution } =
      await import('../../../../lib/harness-patterns/patterns/compactExecution.server')
    expect(compactExecution).toBeDefined()
    expect(typeof compactExecution).toBe('function')
  })

  it('should create a ConfiguredPattern with name and config', async () => {
    const { compactExecution } =
      await import('../../../../lib/harness-patterns/patterns/compactExecution.server')

    const pattern = compactExecution({
      mode: 'message',
      patternId: 'test-compactExecution',
    })

    expect(pattern.name).toBe('compactExecution')
    expect(pattern.config.patternId).toBe('test-compactExecution')
    expect(pattern.fn).toBeDefined()
  })

  describe('modes', () => {
    it('should support message mode', async () => {
      const { compactExecution } =
        await import('../../../../lib/harness-patterns/patterns/compactExecution.server')

      const pattern = compactExecution({ mode: 'message' })
      expect(pattern.name).toBe('compactExecution')
    })

    it('should support response mode', async () => {
      const { compactExecution } =
        await import('../../../../lib/harness-patterns/patterns/compactExecution.server')

      const pattern = compactExecution({ mode: 'response' })
      expect(pattern.name).toBe('compactExecution')
    })

    it('should support thread mode', async () => {
      const { compactExecution } =
        await import('../../../../lib/harness-patterns/patterns/compactExecution.server')

      const pattern = compactExecution({ mode: 'thread' })
      expect(pattern.name).toBe('compactExecution')
    })
  })

  describe('custom synthesis function', () => {
    it('should use custom synthesis function when provided', async () => {
      const { compactExecution } =
        await import('../../../../lib/harness-patterns/patterns/compactExecution.server')
      const { createScope } = await import('../../../../lib/harness-patterns/context.server')
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

      const customSynthesize = vi.fn(async () => 'Custom synthesized response')

      const pattern = compactExecution({
        mode: 'message',
        synthesize: customSynthesize,
      })

      const scope = createScope('test', { response: 'original response' })
      const mockContext = {
        sessionId: 'test',
        createdAt: Date.now(),
        events: [
          {
            type: 'user_message' as const,
            ts: Date.now(),
            patternId: 'harness',
            data: { content: 'test query' },
          },
        ],
        status: 'running' as const,
        data: {},
        input: 'test query',
      }
      const view = createEventView(mockContext)

      const result = await pattern.fn(scope, view)

      expect(customSynthesize).toHaveBeenCalled()
      expect(result.data.synthesizedResponse).toBe('Custom synthesized response')
    })
  })

  describe('skipIfHasResponse', () => {
    it('should skip synthesis if response exists and skipIfHasResponse is true', async () => {
      const { compactExecution } =
        await import('../../../../lib/harness-patterns/patterns/compactExecution.server')
      const { createScope } = await import('../../../../lib/harness-patterns/context.server')
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

      const customSynthesize = vi.fn(async () => 'New response')

      const pattern = compactExecution({
        mode: 'message',
        synthesize: customSynthesize,
        skipIfHasResponse: true,
      })

      const scope = createScope('test', { synthesizedResponse: 'existing response' })
      const mockContext = {
        sessionId: 'test',
        createdAt: Date.now(),
        events: [],
        status: 'running' as const,
        data: {},
        input: 'test',
      }
      const view = createEventView(mockContext)

      const result = await pattern.fn(scope, view)

      expect(customSynthesize).not.toHaveBeenCalled()
      expect(result.data.synthesizedResponse).toBe('existing response')
    })
  })
})

describe('compactExecution execution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should track assistant_message event', async () => {
    const { compactExecution } =
      await import('../../../../lib/harness-patterns/patterns/compactExecution.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const pattern = compactExecution({
      mode: 'message',
      trackHistory: 'assistant_message',
      synthesize: async () => 'Test response',
    })

    const scope = createScope('test', {})
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        {
          type: 'user_message' as const,
          ts: Date.now(),
          patternId: 'harness',
          data: { content: 'test' },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'test',
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)

    expect(result.events).toHaveLength(1)
    expect(result.events[0].type).toBe('assistant_message')
    expect((result.events[0].data as { content: string }).content).toBe('Test response')
  })

  it('should call default synthesis with BAML when no custom function provided', async () => {
    const { compactExecution } =
      await import('../../../../lib/harness-patterns/patterns/compactExecution.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    // No custom synthesize function — should use defaultSynthesize → b.Synthesize mock
    const pattern = compactExecution({
      mode: 'message',
      trackHistory: true,
    })

    const scope = createScope('test', {})
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        {
          type: 'user_message' as const,
          ts: Date.now(),
          patternId: 'harness',
          data: { content: 'test query' },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'test query',
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)

    // Should have used the BAML mock's return value
    expect(result.data.synthesizedResponse).toBe('Synthesized response from BAML')
    expect(result.events.filter((e) => e.type === 'assistant_message')).toHaveLength(1)
  })

  it('should handle response mode', async () => {
    const { compactExecution } =
      await import('../../../../lib/harness-patterns/patterns/compactExecution.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const pattern = compactExecution({
      mode: 'response',
      synthesize: async (input) => `Response mode: ${input.response}`,
    })

    const scope = createScope('test', { response: 'my data' })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        {
          type: 'user_message' as const,
          ts: Date.now(),
          patternId: 'harness',
          data: { content: 'test' },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'test',
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)

    expect(result.data.synthesizedResponse).toBe('Response mode: my data')
  })

  it('should handle thread mode with loop history from events', async () => {
    const { compactExecution } =
      await import('../../../../lib/harness-patterns/patterns/compactExecution.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const pattern = compactExecution({
      mode: 'thread',
      synthesize: async (input) =>
        `Thread mode with ${input.loopHistory?.iterations.length ?? 0} iterations`,
    })

    const scope = createScope('test', {})
    // Put controller_action and tool_result events into context so compactExecution
    // can reconstruct loop history from the event stream (not data.loopHistory)
    const now = Date.now()
    const mockContext = {
      sessionId: 'test',
      createdAt: now,
      events: [
        { type: 'user_message' as const, ts: now, patternId: 'harness', data: { content: 'test' } },
        {
          type: 'pattern_enter' as const,
          ts: now,
          patternId: 'web-search',
          data: { pattern: 'simpleLoop' },
        },
        {
          type: 'controller_action' as const,
          ts: now + 1,
          patternId: 'web-search',
          data: {
            action: {
              tool_name: 'search',
              tool_args: '{"q":"test"}',
              reasoning: 'Search for results',
              status: 'success',
              is_final: false,
            },
          },
        },
        {
          type: 'tool_result' as const,
          ts: now + 2,
          patternId: 'web-search',
          data: {
            tool: 'search',
            result: { items: [] },
            success: true,
          },
        },
        {
          type: 'pattern_exit' as const,
          ts: now + 3,
          patternId: 'web-search',
          data: { status: 'completed' },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'test',
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)

    expect(result.data.synthesizedResponse).toBe('Thread mode with 1 iterations')
  })

  it('should handle thread mode falling back to response mode when no history', async () => {
    const { compactExecution } =
      await import('../../../../lib/harness-patterns/patterns/compactExecution.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const pattern = compactExecution({
      mode: 'thread',
      synthesize: async (input) => `Mode: ${input.mode}, Response: ${input.response}`,
    })

    const scope = createScope('test', { response: 'fallback response' })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        {
          type: 'user_message' as const,
          ts: Date.now(),
          patternId: 'harness',
          data: { content: 'test' },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'test',
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)

    // Should fall back to response mode
    expect(result.data.synthesizedResponse).toContain('response')
  })

  it('should handle errors gracefully', async () => {
    const { compactExecution } =
      await import('../../../../lib/harness-patterns/patterns/compactExecution.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const pattern = compactExecution({
      mode: 'message',
      synthesize: async () => {
        throw new Error('Synthesis failed')
      },
    })

    const scope = createScope('test', {})
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        {
          type: 'user_message' as const,
          ts: Date.now(),
          patternId: 'harness',
          data: { content: 'test' },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'test',
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)

    const errorEvents = result.events.filter((e) => e.type === 'error')
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(errorEvents[0].data)).toContain('Synthesis failed')
  })

  it('thread mode: keeps a bare tool_result with no preceding controller_action (the retriever)', async () => {
    // Regression: the retriever emits a single tool_result and NO
    // controller_action. The old reconstruction only attached a tool_result to
    // an existing iteration (created by a controller_action), so the result was
    // dropped → loopHistory had 0 iterations → Synthesize got nothing → the
    // compactExecution answered from nothing ("after the retriever, nothing happens").
    const { compactExecution } =
      await import('../../../../lib/harness-patterns/patterns/compactExecution.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    let captured: import('../../../../lib/harness-patterns/types').CompactExecutionInput | undefined
    const pattern = compactExecution({
      mode: 'thread',
      synthesize: async (input) => {
        captured = input
        return `iters=${input.loopHistory?.iterations.length ?? 0}`
      },
    })

    const scope = createScope('test', {})
    const now = Date.now()
    const matches = [
      { backend: 'redis', id: 'doc:0', content: 'Harness patterns are covered in §3.' },
    ]
    const mockContext = {
      sessionId: 'test',
      createdAt: now,
      events: [
        {
          type: 'user_message' as const,
          ts: now,
          patternId: 'harness',
          data: { content: 'which sections cover harness patterns?' },
        },
        {
          type: 'pattern_enter' as const,
          ts: now + 1,
          patternId: 'retriever',
          data: { pattern: 'retriever' },
        },
        {
          type: 'tool_result' as const,
          ts: now + 2,
          patternId: 'retriever',
          data: {
            tool: 'retriever',
            result: { matches, backends: ['redis'], query: 'harness patterns' },
            success: true,
          },
        },
        {
          type: 'pattern_exit' as const,
          ts: now + 3,
          patternId: 'retriever',
          data: { status: 'completed' },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'which sections cover harness patterns?',
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)

    // The bare tool_result becomes a standalone turn carrying the matches.
    expect(captured?.loopHistory?.iterations).toHaveLength(1)
    expect(captured?.loopHistory?.iterations[0].result).toEqual({
      matches,
      backends: ['redis'],
      query: 'harness patterns',
    })
    expect(captured?.loopHistory?.iterations[0].action.tool_name).toBe('retriever')
    expect(result.data.synthesizedResponse).toBe('iters=1')
  })

  it('thread mode: a multi-call turn pairs ALL its tool_results with the one controller_action', async () => {
    // A batch action owns 1 + additional_calls.length results. Before the
    // counter-based pairing, results 2..N fell into the "no preceding action"
    // branch and fabricated zero-reasoning synthetic iterations.
    const { compactExecution } =
      await import('../../../../lib/harness-patterns/patterns/compactExecution.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    let captured: import('../../../../lib/harness-patterns/types').CompactExecutionInput | undefined
    const pattern = compactExecution({
      mode: 'thread',
      synthesize: async (input) => {
        captured = input
        return `iters=${input.loopHistory?.iterations.length ?? 0}`
      },
    })

    const scope = createScope('test', {})
    const now = Date.now()
    const batchAction = {
      reasoning: 'two lookups',
      tool_name: 'web_search',
      tool_args: '{"q":"a"}',
      additional_calls: [
        { tool_name: 'read_neo4j_cypher', tool_args: '{"query":"MATCH (n) RETURN n"}' },
      ],
      status: 'running',
      is_final: false,
    }
    const mockContext = {
      sessionId: 'test',
      createdAt: now,
      events: [
        { type: 'user_message' as const, ts: now, patternId: 'harness', data: { content: 'q' } },
        {
          type: 'pattern_enter' as const,
          ts: now + 1,
          patternId: 'loop',
          data: { pattern: 'simpleLoop' },
        },
        {
          type: 'controller_action' as const,
          ts: now + 2,
          patternId: 'loop',
          data: { action: batchAction, turn: 0 },
        },
        {
          type: 'tool_call' as const,
          ts: now + 3,
          patternId: 'loop',
          data: { callId: 'tc1', batchId: 'b1', tool: 'web_search', args: { q: 'a' } },
        },
        {
          type: 'tool_call' as const,
          ts: now + 4,
          patternId: 'loop',
          data: { callId: 'tc2', batchId: 'b1', tool: 'read_neo4j_cypher', args: {} },
        },
        {
          type: 'tool_result' as const,
          ts: now + 5,
          patternId: 'loop',
          data: {
            callId: 'tc1',
            batchId: 'b1',
            tool: 'web_search',
            result: ['hit'],
            success: true,
          },
        },
        {
          type: 'tool_result' as const,
          ts: now + 6,
          patternId: 'loop',
          data: {
            callId: 'tc2',
            batchId: 'b1',
            tool: 'read_neo4j_cypher',
            result: null,
            success: false,
            error: 'timeout',
          },
        },
        {
          type: 'pattern_exit' as const,
          ts: now + 7,
          patternId: 'loop',
          data: { status: 'completed' },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'q',
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)

    // ONE iteration, not one real + one synthetic
    expect(captured?.loopHistory?.iterations).toHaveLength(1)
    const iter = captured!.loopHistory!.iterations[0]
    expect(iter.action.tool_name).toBe('web_search')
    expect(iter.action.reasoning).toBe('two lookups')
    // both results attached, keyed by batch position, failure marked
    expect(iter.result).toEqual({
      '1': { tool: 'web_search', result: ['hit'] },
      '2': { tool: 'read_neo4j_cypher', __error: 'timeout' },
    })
    expect(result.data.synthesizedResponse).toBe('iters=1')
  })

  it('should build input from events for thread mode', async () => {
    const { compactExecution } =
      await import('../../../../lib/harness-patterns/patterns/compactExecution.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const pattern = compactExecution({
      mode: 'thread',
      synthesize: async (input) => `Iterations: ${input.loopHistory?.iterations.length ?? 0}`,
    })

    const scope = createScope('test', {})
    const ts = Date.now()
    const mockContext = {
      sessionId: 'test',
      createdAt: ts,
      events: [
        { type: 'user_message' as const, ts, patternId: 'harness', data: { content: 'test' } },
        { type: 'pattern_enter' as const, ts: ts + 1, patternId: 'loop', data: {} },
        {
          type: 'controller_action' as const,
          ts: ts + 2,
          patternId: 'loop',
          data: {
            action: {
              tool_name: 'search',
              tool_args: '{}',
              reasoning: 'test',
              status: '',
              is_final: false,
            },
          },
        },
        {
          type: 'tool_result' as const,
          ts: ts + 3,
          patternId: 'loop',
          data: { result: { items: ['a', 'b'] } },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'test',
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)

    // Should have built loop history from events
    expect(result.data.synthesizedResponse).toContain('Iterations')
  })
})

// ---------------------------------------------------------------------------
// Regression: large tool results must survive into the compactExecution's turns.
//
// .harness-logs/neo4j-no-results.json — two read_neo4j_cypher turns returned
// ~58KB/~65KB of rows, then the loop's `Return`. The synth trimmed against
// `getContextWindow('SynthesizerFallback')`, which wasn't in
// MODEL_CONTEXT_WINDOWS → 16K default → budget ~12K tokens, so trimToFit
// dropped BOTH data turns and kept only the `Return` (result: null). The synth
// then truthfully reported "returned null". Fix: trim against the client the
// call actually uses (resolveClientForRole('compactExecution') → SynthesizerAnthropic =
// 200K by default), so the data reaches the synth. b.Synthesize is mocked — no
// real LLM call / tokens.
// ---------------------------------------------------------------------------
describe('compactExecution — context-window trimming regression', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps large multi-turn tool results in the turns passed to Synthesize', async () => {
    const { compactExecution } =
      await import('../../../../lib/harness-patterns/patterns/compactExecution.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')
    const { b } = await import('../../../../../baml_client')

    // Two large cypher results (>49KB each → would each blow the old 12K-token
    // budget) plus the loop's Return, all under the loop's patternId.
    const big0 = { rows: [{ name: 'NODE_REDIS_DEG17', degree: 17, blob: 'R'.repeat(60_000) }] }
    const big1 = { rows: [{ name: 'NODE_SCHEMA_DEG12', degree: 12, blob: 'S'.repeat(60_000) }] }
    const ts = Date.now()
    const mockContext = {
      sessionId: 'test',
      createdAt: ts,
      events: [
        {
          type: 'user_message' as const,
          ts,
          patternId: 'harness',
          data: { content: 'Sort nodes by centrality' },
        },
        {
          type: 'pattern_enter' as const,
          ts: ts + 1,
          patternId: 'neo4j-query',
          data: { pattern: 'simpleLoop' },
        },
        {
          type: 'controller_action' as const,
          ts: ts + 2,
          patternId: 'neo4j-query',
          data: {
            action: {
              tool_name: 'read_neo4j_cypher',
              tool_args: '{}',
              reasoning: '',
              status: 'success',
              is_final: false,
            },
          },
        },
        {
          type: 'tool_result' as const,
          ts: ts + 3,
          patternId: 'neo4j-query',
          data: { tool: 'read_neo4j_cypher', result: big0, success: true },
        },
        {
          type: 'controller_action' as const,
          ts: ts + 4,
          patternId: 'neo4j-query',
          data: {
            action: {
              tool_name: 'read_neo4j_cypher',
              tool_args: '{}',
              reasoning: '',
              status: 'success',
              is_final: false,
            },
          },
        },
        {
          type: 'tool_result' as const,
          ts: ts + 5,
          patternId: 'neo4j-query',
          data: { tool: 'read_neo4j_cypher', result: big1, success: true },
        },
        {
          type: 'controller_action' as const,
          ts: ts + 6,
          patternId: 'neo4j-query',
          data: {
            action: {
              tool_name: 'Return',
              tool_args: '## answer',
              reasoning: '',
              status: 'success',
              is_final: false,
            },
          },
        },
        {
          type: 'pattern_exit' as const,
          ts: ts + 7,
          patternId: 'neo4j-query',
          data: { status: 'completed' },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'Sort nodes by centrality',
    }

    // Default synthesis (no custom fn) → defaultSynthesize → b.Synthesize + trimToFit.
    const pattern = compactExecution({ mode: 'thread', patternId: 'response-synth' })
    const scope = createScope('test', {})
    const view = createEventView(mockContext)

    await pattern.fn(scope, view)

    const synthMock = vi.mocked(b.Synthesize)
    expect(synthMock).toHaveBeenCalledTimes(1)
    // Synthesize(userMessage, intent, turns, hasError, errorMessage) → turns is arg[2].
    const turns = synthMock.mock.calls[0][2] as unknown[]
    const turnsJson = JSON.stringify(turns)
    // Both large results survive into the synth's view (pre-fix: only the
    // Return/null turn remained and neither marker was present).
    expect(turnsJson).toContain('NODE_REDIS_DEG17')
    expect(turnsJson).toContain('NODE_SCHEMA_DEG12')
  })

  it('resolves the trim window from the real client, not the missing Fallback key', async () => {
    const { getContextWindow } =
      await import('../../../../lib/harness-patterns/token-budget.server')
    const { resolveClientForRole } = await import('../../../../lib/harness-patterns/clients.server')

    // The keys that were missing (→ 16K default → over-trim).
    expect(getContextWindow('SynthesizerAnthropic')).toBe(200_000)
    expect(getContextWindow('SynthesizerFallback')).toBe(32_768)

    // Default (Anthropic-only) → declared client; not the Fallback label.
    expect(resolveClientForRole('compactExecution')).toBe('SynthesizerAnthropic')
    expect(resolveClientForRole('controller')).toBe('ControllerAnthropic')

    // Under mixed chains → the Fallback client.
    const prev = process.env.USE_MIXED_CHAINS
    process.env.USE_MIXED_CHAINS = '1'
    try {
      expect(resolveClientForRole('compactExecution')).toBe('SynthesizerFallback')
    } finally {
      if (prev === undefined) delete process.env.USE_MIXED_CHAINS
      else process.env.USE_MIXED_CHAINS = prev
    }
  })
})

/**
 * SA-H1 / SA-H4 — what the answer-writer is actually shown.
 *
 * Both findings are about `Synthesize` receiving something that isn't true:
 * an error from a turn that already ended (so it apologises forever), and a
 * terminal `Return` presented as a tool that succeeded and returned nothing
 * (so, under the template's FIDELITY rule, it hedges over results that were
 * complete).
 */
describe('compactExecution synth input fidelity', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function harness() {
    const { compactExecution } =
      await import('../../../../lib/harness-patterns/patterns/compactExecution.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')
    return { compactExecution, createScope, createEventView }
  }

  type Ev = { type: string; ts: number; patternId: string; data: unknown }
  function ctxOf(events: Ev[], input = 'q') {
    return {
      sessionId: 'test',
      createdAt: events[0]?.ts ?? 1,
      events: events as never,
      status: 'running' as const,
      data: {},
      input,
    }
  }

  /** One successful turn of a loop called `loop`, offset from `t`. */
  function goodTurn(t: number): Ev[] {
    return [
      { type: 'pattern_enter', ts: t, patternId: 'loop', data: {} },
      {
        type: 'controller_action',
        ts: t + 1,
        patternId: 'loop',
        data: {
          action: {
            reasoning: 'look it up',
            tool_name: 'search',
            tool_args: '{"q":"x"}',
            status: 'Searching',
            is_final: false,
          },
        },
      },
      {
        type: 'tool_result',
        ts: t + 2,
        patternId: 'loop',
        data: { callId: 'tc1', tool: 'search', result: ['the real answer'], success: true },
      },
    ]
  }

  it('does not apologise on turn 2 for an error that belonged to turn 1', async () => {
    const { compactExecution, createScope, createEventView } = await harness()
    let captured: import('../../../../lib/harness-patterns/types').CompactExecutionInput | undefined
    const pattern = compactExecution({
      mode: 'thread',
      patternId: 'synth',
      synthesize: async (input) => {
        captured = input
        return 'ok'
      },
    })

    // Turn 1 failed; turn 2's tool calls all succeeded. Events persist across
    // `continueSession`, and the loop's patternId is the SAME every turn — so a
    // pattern-scoped read still sees turn 1's error. Only a turn window expires it.
    const events: Ev[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'turn 1' } },
      { type: 'pattern_enter', ts: 2, patternId: 'loop', data: {} },
      {
        type: 'error',
        ts: 3,
        patternId: 'loop',
        data: { error: 'Max turns (8) exceeded', severity: 'recoverable' },
      },
      { type: 'pattern_exit', ts: 4, patternId: 'loop', data: { status: 'completed' } },
      { type: 'user_message', ts: 10, patternId: 'harness', data: { content: 'turn 2' } },
      ...goodTurn(11),
    ]

    await pattern.fn(createScope('test', {}), createEventView(ctxOf(events, 'turn 2')))

    expect(captured?.hasError).toBe(false)
    expect(captured?.errorMessage).toBeUndefined()
    // The good turn's results still reach the answer-writer.
    expect(JSON.stringify(captured?.loopHistory?.iterations)).toContain('the real answer')
  })

  it('still reports an error from the turn it is answering', async () => {
    const { compactExecution, createScope, createEventView } = await harness()
    let captured: import('../../../../lib/harness-patterns/types').CompactExecutionInput | undefined
    const pattern = compactExecution({
      mode: 'thread',
      patternId: 'synth',
      synthesize: async (input) => {
        captured = input
        return 'ok'
      },
    })

    const events: Ev[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'turn 1' } },
      ...goodTurn(2),
      { type: 'user_message', ts: 10, patternId: 'harness', data: { content: 'turn 2' } },
      ...goodTurn(11),
      { type: 'error', ts: 20, patternId: 'loop', data: { error: 'gateway unreachable' } },
    ]

    await pattern.fn(createScope('test', {}), createEventView(ctxOf(events, 'turn 2')))

    expect(captured?.hasError).toBe(true)
    expect(captured?.errorMessage).toBe('gateway unreachable')
  })

  it('honours a wider window when the caller asked for one', async () => {
    const { compactExecution, createScope, createEventView } = await harness()
    let captured: import('../../../../lib/harness-patterns/types').CompactExecutionInput | undefined
    const pattern = compactExecution({
      mode: 'thread',
      patternId: 'synth',
      viewConfig: { fromLast: false, fromLastNTurns: 2 },
      synthesize: async (input) => {
        captured = input
        return 'ok'
      },
    })

    const events: Ev[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'turn 1' } },
      { type: 'error', ts: 2, patternId: 'loop', data: { error: 'two turns ago' } },
      { type: 'user_message', ts: 10, patternId: 'harness', data: { content: 'turn 2' } },
      ...goodTurn(11),
    ]
    const view = createEventView(
      ctxOf(events, 'turn 2'),
      { fromLast: false, fromLastNTurns: 2 },
      'synth',
    )

    await pattern.fn(createScope('test', {}), view)

    expect(captured?.hasError).toBe(true)
    expect(captured?.errorMessage).toBe('two turns ago')
  })

  it('drops the terminal Return turn instead of passing it off as a success', async () => {
    const { compactExecution, createScope, createEventView } = await harness()
    const { b } = await import('../../../../../baml_client')

    const events: Ev[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'q' } },
      ...goodTurn(2),
      // simpleLoop emits NO tool_result for the terminal Return (#149), so the
      // reconstruction used to hand Synthesize `Tool: Return / Result: null`
      // with `success: true` — a fabricated success as the answer-writer's
      // LAST and most salient input.
      {
        type: 'controller_action',
        ts: 6,
        patternId: 'loop',
        data: {
          action: {
            reasoning: 'found it',
            tool_name: 'Return',
            tool_args: 'brief summary of what I did',
            is_final: true,
          },
        },
      },
      { type: 'pattern_exit', ts: 7, patternId: 'loop', data: { status: 'completed' } },
    ]

    const pattern = compactExecution({ mode: 'thread', patternId: 'synth' })
    await pattern.fn(createScope('test', {}), createEventView(ctxOf(events)))

    const turns = vi.mocked(b.Synthesize).mock.calls[0][2] as Array<{
      tool_call?: { tool?: string }
      tool_result?: { tool?: string; result?: string; success?: boolean }
    }>
    expect(turns).toHaveLength(1)
    expect(turns[0].tool_result?.tool).toBe('search')
    expect(turns[0].tool_result?.result).toContain('the real answer')
    // No Return turn, and no null result dressed up as a success, anywhere.
    const json = JSON.stringify(turns)
    expect(json).not.toContain('Return')
    expect(json).not.toContain('"result":"null"')
    // The Return prose was never the deliverable (#149) — it must not leak either.
    expect(json).not.toContain('brief summary of what I did')
  })

  it('drops an action whose tool_result never arrived, but keeps a real null result', async () => {
    const { compactExecution, createScope, createEventView } = await harness()
    let captured: import('../../../../lib/harness-patterns/types').CompactExecutionInput | undefined
    const pattern = compactExecution({
      mode: 'thread',
      patternId: 'synth',
      synthesize: async (input) => {
        captured = input
        return 'ok'
      },
    })

    const events: Ev[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'q' } },
      { type: 'pattern_enter', ts: 2, patternId: 'loop', data: {} },
      // A tool that legitimately returns null — it HAS a paired tool_result, so
      // its turn survives: "the store holds nothing" is a real finding.
      {
        type: 'controller_action',
        ts: 3,
        patternId: 'loop',
        data: {
          action: { reasoning: '', tool_name: 'lookup', tool_args: '{}', is_final: false },
        },
      },
      {
        type: 'tool_result',
        ts: 4,
        patternId: 'loop',
        data: { callId: 'tc1', tool: 'lookup', result: null, success: true },
      },
      // The loop died mid-turn: an action with no result at all.
      {
        type: 'controller_action',
        ts: 5,
        patternId: 'loop',
        data: {
          action: { reasoning: '', tool_name: 'orphan', tool_args: '{}', is_final: false },
        },
      },
    ]

    await pattern.fn(createScope('test', {}), createEventView(ctxOf(events)))

    const iterations = captured?.loopHistory?.iterations ?? []
    expect(iterations.map((i) => i.action.tool_name)).toEqual(['lookup'])
    expect(iterations[0].result).toBeNull()
  })

  it('falls back to response mode when nothing real is left to report', async () => {
    const { compactExecution, createScope, createEventView } = await harness()
    let captured: import('../../../../lib/harness-patterns/types').CompactExecutionInput | undefined
    const pattern = compactExecution({
      mode: 'thread',
      patternId: 'synth',
      synthesize: async (input) => {
        captured = input
        return 'ok'
      },
    })

    const events: Ev[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'q' } },
      { type: 'pattern_enter', ts: 2, patternId: 'loop', data: {} },
      {
        type: 'controller_action',
        ts: 3,
        patternId: 'loop',
        data: {
          action: {
            reasoning: '',
            tool_name: 'Return',
            tool_args: 'nothing to do',
            is_final: true,
          },
        },
      },
      { type: 'pattern_exit', ts: 4, patternId: 'loop', data: { status: 'completed' } },
    ]

    await pattern.fn(createScope('test', {}), createEventView(ctxOf(events)))

    // A Return-only trace has no loop history worth the name; the existing
    // no-history path takes over rather than shipping an empty thread.
    expect(captured?.loopHistory).toBeUndefined()
    expect(captured?.mode).toBe('response')
  })
})
