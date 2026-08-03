/**
 * synthesizer Pattern Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock server-only imports
vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn()
}))

// Mock BAML client
vi.mock('../../../../../baml_client', () => ({
  b: {
    Synthesize: vi.fn(async () => 'Synthesized response from BAML')
  }
}))

// Mock Collector — must be a real class so `new Collector()` works
vi.mock('@boundaryml/baml', () => {
  class MockCollector {
    last = {
      rawLlmResponse: 'Raw response',
      usage: { inputTokens: 100, outputTokens: 50 },
      calls: [{ httpRequest: { body: { messages: [] } } }]
    }
    constructor(_name?: string) {}
  }
  return { Collector: MockCollector }
})

describe('synthesizer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should export synthesizer function', async () => {
    const { synthesizer } = await import('../../../../lib/harness-patterns/patterns/synthesizer.server')
    expect(synthesizer).toBeDefined()
    expect(typeof synthesizer).toBe('function')
  })

  it('should create a ConfiguredPattern with name and config', async () => {
    const { synthesizer } = await import('../../../../lib/harness-patterns/patterns/synthesizer.server')

    const pattern = synthesizer({
      mode: 'message',
      patternId: 'test-synthesizer'
    })

    expect(pattern.name).toBe('synthesizer')
    expect(pattern.config.patternId).toBe('test-synthesizer')
    expect(pattern.fn).toBeDefined()
  })

  describe('modes', () => {
    it('should support message mode', async () => {
      const { synthesizer } = await import('../../../../lib/harness-patterns/patterns/synthesizer.server')

      const pattern = synthesizer({ mode: 'message' })
      expect(pattern.name).toBe('synthesizer')
    })

    it('should support response mode', async () => {
      const { synthesizer } = await import('../../../../lib/harness-patterns/patterns/synthesizer.server')

      const pattern = synthesizer({ mode: 'response' })
      expect(pattern.name).toBe('synthesizer')
    })

    it('should support thread mode', async () => {
      const { synthesizer } = await import('../../../../lib/harness-patterns/patterns/synthesizer.server')

      const pattern = synthesizer({ mode: 'thread' })
      expect(pattern.name).toBe('synthesizer')
    })
  })

  describe('custom synthesis function', () => {
    it('should use custom synthesis function when provided', async () => {
      const { synthesizer } = await import('../../../../lib/harness-patterns/patterns/synthesizer.server')
      const { createScope } = await import('../../../../lib/harness-patterns/context.server')
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

      const customSynthesize = vi.fn(async () => 'Custom synthesized response')

      const pattern = synthesizer({
        mode: 'message',
        synthesize: customSynthesize
      })

      const scope = createScope('test', { response: 'original response' })
      const mockContext = {
        sessionId: 'test',
        createdAt: Date.now(),
        events: [
          { type: 'user_message' as const, ts: Date.now(), patternId: 'harness', data: { content: 'test query' } }
        ],
        status: 'running' as const,
        data: {},
        input: 'test query'
      }
      const view = createEventView(mockContext)

      const result = await pattern.fn(scope, view)

      expect(customSynthesize).toHaveBeenCalled()
      expect(result.data.synthesizedResponse).toBe('Custom synthesized response')
    })
  })

  describe('skipIfHasResponse', () => {
    it('should skip synthesis if response exists and skipIfHasResponse is true', async () => {
      const { synthesizer } = await import('../../../../lib/harness-patterns/patterns/synthesizer.server')
      const { createScope } = await import('../../../../lib/harness-patterns/context.server')
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

      const customSynthesize = vi.fn(async () => 'New response')

      const pattern = synthesizer({
        mode: 'message',
        synthesize: customSynthesize,
        skipIfHasResponse: true
      })

      const scope = createScope('test', { synthesizedResponse: 'existing response' })
      const mockContext = {
        sessionId: 'test',
        createdAt: Date.now(),
        events: [],
        status: 'running' as const,
        data: {},
        input: 'test'
      }
      const view = createEventView(mockContext)

      const result = await pattern.fn(scope, view)

      expect(customSynthesize).not.toHaveBeenCalled()
      expect(result.data.synthesizedResponse).toBe('existing response')
    })
  })
})

describe('synthesizer execution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should track assistant_message event', async () => {
    const { synthesizer } = await import('../../../../lib/harness-patterns/patterns/synthesizer.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const pattern = synthesizer({
      mode: 'message',
      trackHistory: 'assistant_message',
      synthesize: async () => 'Test response'
    })

    const scope = createScope('test', {})
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        { type: 'user_message' as const, ts: Date.now(), patternId: 'harness', data: { content: 'test' } }
      ],
      status: 'running' as const,
      data: {},
      input: 'test'
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)

    expect(result.events).toHaveLength(1)
    expect(result.events[0].type).toBe('assistant_message')
    expect((result.events[0].data as { content: string }).content).toBe('Test response')
  })

  it('should call default synthesis with BAML when no custom function provided', async () => {
    const { synthesizer } = await import('../../../../lib/harness-patterns/patterns/synthesizer.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    // No custom synthesize function — should use defaultSynthesize → b.Synthesize mock
    const pattern = synthesizer({
      mode: 'message',
      trackHistory: true
    })

    const scope = createScope('test', {})
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        { type: 'user_message' as const, ts: Date.now(), patternId: 'harness', data: { content: 'test query' } }
      ],
      status: 'running' as const,
      data: {},
      input: 'test query'
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)

    // Should have used the BAML mock's return value
    expect(result.data.synthesizedResponse).toBe('Synthesized response from BAML')
    expect(result.events.filter(e => e.type === 'assistant_message')).toHaveLength(1)
  })

  it('should handle response mode', async () => {
    const { synthesizer } = await import('../../../../lib/harness-patterns/patterns/synthesizer.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const pattern = synthesizer({
      mode: 'response',
      synthesize: async (input) => `Response mode: ${input.response}`
    })

    const scope = createScope('test', { response: 'my data' })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        { type: 'user_message' as const, ts: Date.now(), patternId: 'harness', data: { content: 'test' } }
      ],
      status: 'running' as const,
      data: {},
      input: 'test'
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)

    expect(result.data.synthesizedResponse).toBe('Response mode: my data')
  })

  it('should handle thread mode with loop history from events', async () => {
    const { synthesizer } = await import('../../../../lib/harness-patterns/patterns/synthesizer.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const pattern = synthesizer({
      mode: 'thread',
      synthesize: async (input) => `Thread mode with ${input.loopHistory?.iterations.length ?? 0} iterations`
    })

    const scope = createScope('test', {})
    // Put controller_action and tool_result events into context so synthesizer
    // can reconstruct loop history from the event stream (not data.loopHistory)
    const now = Date.now()
    const mockContext = {
      sessionId: 'test',
      createdAt: now,
      events: [
        { type: 'user_message' as const, ts: now, patternId: 'harness', data: { content: 'test' } },
        { type: 'pattern_enter' as const, ts: now, patternId: 'web-search', data: { pattern: 'simpleLoop' } },
        { type: 'controller_action' as const, ts: now + 1, patternId: 'web-search', data: {
          action: { tool_name: 'search', tool_args: '{"q":"test"}', reasoning: 'Search for results', status: 'success', is_final: false }
        }},
        { type: 'tool_result' as const, ts: now + 2, patternId: 'web-search', data: {
          tool: 'search', result: { items: [] }, success: true
        }},
        { type: 'pattern_exit' as const, ts: now + 3, patternId: 'web-search', data: { status: 'completed' } },
      ],
      status: 'running' as const,
      data: {},
      input: 'test'
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)

    expect(result.data.synthesizedResponse).toBe('Thread mode with 1 iterations')
  })

  it('should handle thread mode falling back to response mode when no history', async () => {
    const { synthesizer } = await import('../../../../lib/harness-patterns/patterns/synthesizer.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const pattern = synthesizer({
      mode: 'thread',
      synthesize: async (input) => `Mode: ${input.mode}, Response: ${input.response}`
    })

    const scope = createScope('test', { response: 'fallback response' })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        { type: 'user_message' as const, ts: Date.now(), patternId: 'harness', data: { content: 'test' } }
      ],
      status: 'running' as const,
      data: {},
      input: 'test'
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)

    // Should fall back to response mode
    expect(result.data.synthesizedResponse).toContain('response')
  })

  it('should handle errors gracefully', async () => {
    const { synthesizer } = await import('../../../../lib/harness-patterns/patterns/synthesizer.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const pattern = synthesizer({
      mode: 'message',
      synthesize: async () => {
        throw new Error('Synthesis failed')
      }
    })

    const scope = createScope('test', {})
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        { type: 'user_message' as const, ts: Date.now(), patternId: 'harness', data: { content: 'test' } }
      ],
      status: 'running' as const,
      data: {},
      input: 'test'
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)

    const errorEvents = result.events.filter(e => e.type === 'error')
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(errorEvents[0].data)).toContain('Synthesis failed')
  })

  it('thread mode: keeps a bare tool_result with no preceding controller_action (the retriever)', async () => {
    // Regression: the retriever emits a single tool_result and NO
    // controller_action. The old reconstruction only attached a tool_result to
    // an existing iteration (created by a controller_action), so the result was
    // dropped → loopHistory had 0 iterations → Synthesize got nothing → the
    // synthesizer answered from nothing ("after the retriever, nothing happens").
    const { synthesizer } = await import('../../../../lib/harness-patterns/patterns/synthesizer.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    let captured: import('../../../../lib/harness-patterns/types').SynthesizerInput | undefined
    const pattern = synthesizer({
      mode: 'thread',
      synthesize: async (input) => {
        captured = input
        return `iters=${input.loopHistory?.iterations.length ?? 0}`
      },
    })

    const scope = createScope('test', {})
    const now = Date.now()
    const matches = [{ backend: 'redis', id: 'doc:0', content: 'Harness patterns are covered in §3.' }]
    const mockContext = {
      sessionId: 'test',
      createdAt: now,
      events: [
        { type: 'user_message' as const, ts: now, patternId: 'harness', data: { content: 'which sections cover harness patterns?' } },
        { type: 'pattern_enter' as const, ts: now + 1, patternId: 'retriever', data: { pattern: 'retriever' } },
        { type: 'tool_result' as const, ts: now + 2, patternId: 'retriever', data: { tool: 'retriever', result: { matches, backends: ['redis'], query: 'harness patterns' }, success: true } },
        { type: 'pattern_exit' as const, ts: now + 3, patternId: 'retriever', data: { status: 'completed' } },
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
    const { synthesizer } = await import('../../../../lib/harness-patterns/patterns/synthesizer.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    let captured: import('../../../../lib/harness-patterns/types').SynthesizerInput | undefined
    const pattern = synthesizer({
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
      additional_calls: [{ tool_name: 'read_neo4j_cypher', tool_args: '{"query":"MATCH (n) RETURN n"}' }],
      status: 'running',
      is_final: false,
    }
    const mockContext = {
      sessionId: 'test',
      createdAt: now,
      events: [
        { type: 'user_message' as const, ts: now, patternId: 'harness', data: { content: 'q' } },
        { type: 'pattern_enter' as const, ts: now + 1, patternId: 'loop', data: { pattern: 'simpleLoop' } },
        { type: 'controller_action' as const, ts: now + 2, patternId: 'loop', data: { action: batchAction, turn: 0 } },
        { type: 'tool_call' as const, ts: now + 3, patternId: 'loop', data: { callId: 'tc1', batchId: 'b1', tool: 'web_search', args: { q: 'a' } } },
        { type: 'tool_call' as const, ts: now + 4, patternId: 'loop', data: { callId: 'tc2', batchId: 'b1', tool: 'read_neo4j_cypher', args: {} } },
        { type: 'tool_result' as const, ts: now + 5, patternId: 'loop', data: { callId: 'tc1', batchId: 'b1', tool: 'web_search', result: ['hit'], success: true } },
        { type: 'tool_result' as const, ts: now + 6, patternId: 'loop', data: { callId: 'tc2', batchId: 'b1', tool: 'read_neo4j_cypher', result: null, success: false, error: 'timeout' } },
        { type: 'pattern_exit' as const, ts: now + 7, patternId: 'loop', data: { status: 'completed' } },
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
    const { synthesizer } = await import('../../../../lib/harness-patterns/patterns/synthesizer.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const pattern = synthesizer({
      mode: 'thread',
      synthesize: async (input) => `Iterations: ${input.loopHistory?.iterations.length ?? 0}`
    })

    const scope = createScope('test', {})
    const ts = Date.now()
    const mockContext = {
      sessionId: 'test',
      createdAt: ts,
      events: [
        { type: 'user_message' as const, ts, patternId: 'harness', data: { content: 'test' } },
        { type: 'pattern_enter' as const, ts: ts + 1, patternId: 'loop', data: {} },
        { type: 'controller_action' as const, ts: ts + 2, patternId: 'loop', data: { action: { tool_name: 'search', tool_args: '{}', reasoning: 'test', status: '', is_final: false } } },
        { type: 'tool_result' as const, ts: ts + 3, patternId: 'loop', data: { result: { items: ['a', 'b'] } } }
      ],
      status: 'running' as const,
      data: {},
      input: 'test'
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)

    // Should have built loop history from events
    expect(result.data.synthesizedResponse).toContain('Iterations')
  })
})

// ---------------------------------------------------------------------------
// Regression: large tool results must survive into the synthesizer's turns.
//
// .harness-logs/neo4j-no-results.json — two read_neo4j_cypher turns returned
// ~58KB/~65KB of rows, then the loop's `Return`. The synth trimmed against
// `getContextWindow('SynthesizerFallback')`, which wasn't in
// MODEL_CONTEXT_WINDOWS → 16K default → budget ~12K tokens, so trimToFit
// dropped BOTH data turns and kept only the `Return` (result: null). The synth
// then truthfully reported "returned null". Fix: trim against the client the
// call actually uses (resolveClientForRole('synth') → SynthesizerAnthropic =
// 200K by default), so the data reaches the synth. b.Synthesize is mocked — no
// real LLM call / tokens.
// ---------------------------------------------------------------------------
describe('synthesizer — context-window trimming regression', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps large multi-turn tool results in the turns passed to Synthesize', async () => {
    const { synthesizer } = await import('../../../../lib/harness-patterns/patterns/synthesizer.server')
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
        { type: 'user_message' as const, ts, patternId: 'harness', data: { content: 'Sort nodes by centrality' } },
        { type: 'pattern_enter' as const, ts: ts + 1, patternId: 'neo4j-query', data: { pattern: 'simpleLoop' } },
        { type: 'controller_action' as const, ts: ts + 2, patternId: 'neo4j-query', data: { action: { tool_name: 'read_neo4j_cypher', tool_args: '{}', reasoning: '', status: 'success', is_final: false } } },
        { type: 'tool_result' as const, ts: ts + 3, patternId: 'neo4j-query', data: { tool: 'read_neo4j_cypher', result: big0, success: true } },
        { type: 'controller_action' as const, ts: ts + 4, patternId: 'neo4j-query', data: { action: { tool_name: 'read_neo4j_cypher', tool_args: '{}', reasoning: '', status: 'success', is_final: false } } },
        { type: 'tool_result' as const, ts: ts + 5, patternId: 'neo4j-query', data: { tool: 'read_neo4j_cypher', result: big1, success: true } },
        { type: 'controller_action' as const, ts: ts + 6, patternId: 'neo4j-query', data: { action: { tool_name: 'Return', tool_args: '## answer', reasoning: '', status: 'success', is_final: false } } },
        { type: 'pattern_exit' as const, ts: ts + 7, patternId: 'neo4j-query', data: { status: 'completed' } },
      ],
      status: 'running' as const,
      data: {},
      input: 'Sort nodes by centrality',
    }

    // Default synthesis (no custom fn) → defaultSynthesize → b.Synthesize + trimToFit.
    const pattern = synthesizer({ mode: 'thread', patternId: 'response-synth' })
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
    const { getContextWindow } = await import('../../../../lib/harness-patterns/token-budget.server')
    const { resolveClientForRole } = await import('../../../../lib/harness-patterns/clients.server')

    // The keys that were missing (→ 16K default → over-trim).
    expect(getContextWindow('SynthesizerAnthropic')).toBe(200_000)
    expect(getContextWindow('SynthesizerFallback')).toBe(32_768)

    // Default (Anthropic-only) → declared client; not the Fallback label.
    expect(resolveClientForRole('synth')).toBe('SynthesizerAnthropic')
    expect(resolveClientForRole('controller')).toBe('ControllerAnthropic')

    // Under mixed chains → the Fallback client.
    const prev = process.env.USE_MIXED_CHAINS
    process.env.USE_MIXED_CHAINS = '1'
    try {
      expect(resolveClientForRole('synth')).toBe('SynthesizerFallback')
    } finally {
      if (prev === undefined) delete process.env.USE_MIXED_CHAINS
      else process.env.USE_MIXED_CHAINS = prev
    }
  })
})
