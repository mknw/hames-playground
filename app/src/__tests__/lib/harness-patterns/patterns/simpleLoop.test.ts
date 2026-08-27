/**
 * simpleLoop Pattern Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockAction, mockFinalAction, mockBAMLClient } from '../../../mocks/baml'
import { mockCallTool, mockListTools, fixtures } from '../../../mocks/mcp'

// Mock server-only imports
vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

// Mock MCP client
const callToolMock = mockCallTool({
  responses: {
    read_neo4j_cypher: fixtures.neo4j.queryResult,
    Return: { response: 'Done' },
  },
})

const listToolsMock = mockListTools(['read_neo4j_cypher', 'Return'])

vi.mock('../../../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: callToolMock,
  listTools: listToolsMock,
}))

// Mock BAML client
vi.mock('../../../../../baml_client', () => ({
  b: mockBAMLClient({
    loopActions: [
      mockAction({ tool_name: 'read_neo4j_cypher', tool_args: '{"query":"MATCH (n) RETURN n"}' }),
      mockFinalAction('Query complete'),
    ],
  }),
}))

describe('simpleLoop', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should export simpleLoop function', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    expect(simpleLoop).toBeDefined()
    expect(typeof simpleLoop).toBe('function')
  })

  it('should create a ConfiguredPattern with name and config', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createLoopControllerAdapter } =
      await import('../../../../lib/harness-patterns/baml-adapters.server')

    const controller = createLoopControllerAdapter(['read_neo4j_cypher', 'Return'])
    const pattern = simpleLoop(controller, ['read_neo4j_cypher', 'Return'], {
      patternId: 'test-loop',
    })

    expect(pattern.name).toBe('simpleLoop')
    expect(pattern.config.patternId).toBe('test-loop')
    expect(pattern.fn).toBeDefined()
  })

  // The default itself is `DEFAULT_SETTINGS.maxToolTurns` — one declaration,
  // asserted through `estimateTurns` rather than against a literal here, so the
  // number can be raised on evidence in one place (#269 raised it 5 → 8). The
  // resolution rule and its clamp are pinned in `turn-budget.test.ts`.
  it('should take its default maxTurns from the request settings', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { DEFAULT_SETTINGS } = await import('../../../../lib/settings')
    const { createLoopControllerAdapter } =
      await import('../../../../lib/harness-patterns/baml-adapters.server')

    const controller = createLoopControllerAdapter(['Return'])
    const pattern = simpleLoop(controller, ['Return'])

    expect(pattern.name).toBe('simpleLoop')
    expect(pattern.estimateTurns?.(DEFAULT_SETTINGS)).toBe(DEFAULT_SETTINGS.maxToolTurns)
  })

  it('should handle custom maxTurns config', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createLoopControllerAdapter } =
      await import('../../../../lib/harness-patterns/baml-adapters.server')

    const controller = createLoopControllerAdapter(['Return'])
    const pattern = simpleLoop(controller, ['Return'], {
      maxTurns: 3,
      patternId: 'limited-loop',
    })

    expect(pattern.name).toBe('simpleLoop')
    expect(pattern.config.patternId).toBe('limited-loop')
  })

  it('passes config.fewShots through to the controller', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const mockController = vi.fn().mockResolvedValue({
      action: mockFinalAction('Done'),
      llmCall: undefined,
    })

    const fewShots = [
      {
        user: 'List all concepts',
        reasoning: 'plain MATCH',
        tool: 'read_neo4j_cypher',
        args: '{"query":"MATCH (c:Concept) RETURN c.name"}',
      },
    ]

    const pattern = simpleLoop(mockController, ['Return'], {
      patternId: 'shots-loop',
      fewShots,
    })

    const scope = createScope('shots-loop', { intent: 'q' })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        {
          type: 'user_message' as const,
          ts: Date.now(),
          patternId: 'harness',
          data: { content: 'q' },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'q',
    }
    const view = createEventView(mockContext)

    await pattern.fn(scope, view)

    // 8th positional arg of controller(...) is fewShots
    const args = mockController.mock.calls[0]
    expect(args[7]).toEqual(fewShots)
  })

  it('awaits onToolResult and uses returned data in the tool_result event', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const onToolResult = vi.fn().mockResolvedValue({ data: { enriched: true, original: 'kept' } })

    const mockController = vi
      .fn()
      .mockResolvedValueOnce({
        action: mockAction({
          tool_name: 'read_neo4j_cypher',
          tool_args: '{"query":"MATCH (n) RETURN n"}',
        }),
        llmCall: undefined,
      })
      .mockResolvedValueOnce({ action: mockFinalAction('done'), llmCall: undefined })

    const pattern = simpleLoop(mockController, ['read_neo4j_cypher', 'Return'], {
      patternId: 'hook',
      onToolResult,
    })

    const scope = createScope('hook', { intent: 'q' })
    const mockContext = {
      sessionId: 'hook',
      createdAt: Date.now(),
      events: [
        {
          type: 'user_message' as const,
          ts: Date.now(),
          patternId: 'harness',
          data: { content: 'q' },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'q',
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)

    expect(onToolResult).toHaveBeenCalledTimes(1)
    const [calledTool, calledResult, calledCtx] = onToolResult.mock.calls[0]
    expect(calledTool).toBe('read_neo4j_cypher')
    expect(typeof calledResult.success).toBe('boolean')
    expect(typeof calledCtx.callId).toBe('string')

    const toolResults = result.events.filter((e) => e.type === 'tool_result')
    expect(toolResults).toHaveLength(1)
    const data = toolResults[0].data as { result: { enriched: boolean; original: string } }
    expect(data.result.enriched).toBe(true)
    expect(data.result.original).toBe('kept')
  })

  it('does not abort the loop when onToolResult throws — logs an error and keeps original result', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const onToolResult = vi.fn().mockRejectedValue(new Error('enrichment exploded'))

    const mockController = vi
      .fn()
      .mockResolvedValueOnce({
        action: mockAction({
          tool_name: 'read_neo4j_cypher',
          tool_args: '{"query":"MATCH (n) RETURN n"}',
        }),
        llmCall: undefined,
      })
      .mockResolvedValueOnce({ action: mockFinalAction('done'), llmCall: undefined })

    const pattern = simpleLoop(mockController, ['read_neo4j_cypher', 'Return'], {
      patternId: 'hook-err',
      onToolResult,
    })

    const scope = createScope('hook-err', { intent: 'q' })
    const mockContext = {
      sessionId: 'hook-err',
      createdAt: Date.now(),
      events: [
        {
          type: 'user_message' as const,
          ts: Date.now(),
          patternId: 'harness',
          data: { content: 'q' },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'q',
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)

    // Original tool_result is preserved (mock callTool returns fixtures.neo4j.queryResult).
    const toolResults = result.events.filter((e) => e.type === 'tool_result')
    expect(toolResults).toHaveLength(1)
    expect((toolResults[0].data as { success: boolean }).success).toBe(true)

    // Hook failure surfaces as an error event, not a fatal abort.
    const errors = result.events.filter((e) => e.type === 'error')
    expect(errors.some((e) => JSON.stringify(e.data).includes('onToolResult hook failed'))).toBe(
      true,
    )

    // Controller still got called for the final 'Return' turn.
    expect(mockController).toHaveBeenCalledTimes(2)
  })
})

describe('simpleLoop execution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should track controller_action events', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    // Create a mock controller that returns final immediately
    const mockController = vi.fn().mockResolvedValue({
      action: mockFinalAction('Done'),
      llmCall: undefined,
    })

    const pattern = simpleLoop(mockController, ['Return'], {
      patternId: 'test',
      trackHistory: 'controller_action',
    })

    // Create mock scope and view
    const scope = createScope('test', { intent: 'test query' })
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

    // Execute pattern
    const result = await pattern.fn(scope, view)

    // Verify controller was called
    expect(mockController).toHaveBeenCalled()
    expect(result).toBeDefined()
  })

  it('should execute tool calls and track results', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    // Controller that calls a tool then returns final
    const mockController = vi
      .fn()
      .mockResolvedValueOnce({
        action: mockAction({
          tool_name: 'read_neo4j_cypher',
          tool_args: '{"query":"MATCH (n) RETURN n"}',
        }),
        llmCall: undefined,
      })
      .mockResolvedValueOnce({
        action: mockFinalAction('Query complete'),
        llmCall: undefined,
      })

    const pattern = simpleLoop(mockController, ['read_neo4j_cypher', 'Return'], {
      patternId: 'test',
      trackHistory: true,
    })

    const scope = createScope('test', { intent: 'test query' })
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

    // Should have tracked tool_call and tool_result events
    const toolCalls = result.events.filter((e) => e.type === 'tool_call')
    const toolResults = result.events.filter((e) => e.type === 'tool_result')
    expect(toolCalls.length).toBeGreaterThanOrEqual(1)
    expect(toolResults.length).toBeGreaterThanOrEqual(1)
  })

  it('should track error when tool not in allowed list', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const mockController = vi.fn().mockResolvedValue({
      action: mockAction({ tool_name: 'forbidden_tool', tool_args: '{}' }),
      llmCall: undefined,
    })

    const pattern = simpleLoop(mockController, ['allowed_tool'], {
      patternId: 'test',
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
    expect(JSON.stringify(errorEvents[0].data)).toContain('Tool not allowed')
  })

  it('should track error when tool_args JSON is invalid', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const mockController = vi.fn().mockResolvedValue({
      action: mockAction({ tool_name: 'read_neo4j_cypher', tool_args: 'not valid json' }),
      llmCall: undefined,
    })

    const pattern = simpleLoop(mockController, ['read_neo4j_cypher'], {
      patternId: 'test',
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
    expect(JSON.stringify(errorEvents[0].data)).toContain('Invalid tool_args JSON')
  })

  it('should track error when tool execution fails', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    // Override callTool to return failure
    callToolMock.mockResolvedValueOnce({
      success: false,
      data: null,
      error: 'Connection failed',
    })

    const mockController = vi.fn().mockResolvedValue({
      action: mockAction({ tool_name: 'read_neo4j_cypher', tool_args: '{"query":"test"}' }),
      llmCall: undefined,
    })

    const pattern = simpleLoop(mockController, ['read_neo4j_cypher'], {
      patternId: 'test',
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
    expect(JSON.stringify(errorEvents[0].data)).toContain('Connection failed')
  })

  it('should track error event when tool fails', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    // Override callTool to return failure
    callToolMock.mockResolvedValueOnce({
      success: false,
      data: null,
      error: 'Tool execution failed',
    })

    const mockController = vi.fn().mockResolvedValue({
      action: mockAction({ tool_name: 'read_neo4j_cypher', tool_args: '{"query":"test"}' }),
      llmCall: undefined,
    })

    const pattern = simpleLoop(mockController, ['read_neo4j_cypher'], {
      patternId: 'test',
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

    // Verify error is tracked as an event, not in scope.data
    const errorEvents = result.events.filter((e) => e.type === 'error')
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(errorEvents[0].data)).toContain('Tool execution failed')
  })

  it('should track error event when controller crashes', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const mockController = vi.fn().mockRejectedValue(new Error('Controller exception'))

    const pattern = simpleLoop(mockController, ['Return'], {
      patternId: 'test',
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

    // Verify error is tracked as an event, not in scope.data
    const errorEvents = result.events.filter((e) => e.type === 'error')
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(errorEvents[0].data)).toContain('Controller exception')
  })

  it('should handle controller errors gracefully', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const mockController = vi.fn().mockRejectedValue(new Error('Controller crashed'))

    const pattern = simpleLoop(mockController, ['Return'], {
      patternId: 'test',
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
    expect(JSON.stringify(errorEvents[0].data)).toContain('Controller crashed')
  })

  it('should track recoverable error event when maxTurns is reached without Return', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    // callTool always succeeds — no early break via tool failure
    callToolMock.mockResolvedValue({
      success: true,
      data: { ok: true },
    })

    // Controller never signals completion (no Return / is_final)
    const mockController = vi.fn().mockResolvedValue({
      action: mockAction({ tool_name: 'read_neo4j_cypher', tool_args: '{"query":"x"}' }),
      llmCall: undefined,
    })

    const pattern = simpleLoop(mockController, ['read_neo4j_cypher', 'Return'], {
      patternId: 'test',
      maxTurns: 3,
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

    // Controller was called exactly maxTurns times (loop never broke early)
    expect(mockController).toHaveBeenCalledTimes(3)

    // Loop should have tracked a recoverable exhaustion event
    const errorEvents = result.events.filter((e) => e.type === 'error')
    expect(errorEvents.length).toBe(1)
    const errData = errorEvents[0].data as { error: string; severity?: string; turn?: number }
    expect(errData.error).toMatch(/exhausted/i)
    expect(errData.error).toContain('3') // maxTurns mentioned
    expect(errData.severity).toBe('recoverable')
    // Partial results from completed turns should still exist as tool_result events
    const toolResults = result.events.filter((e) => e.type === 'tool_result')
    expect(toolResults.length).toBe(3)
  })

  it('should NOT track exhaustion error when controller signals Return', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    callToolMock.mockResolvedValue({ success: true, data: { ok: true } })

    const mockController = vi
      .fn()
      .mockResolvedValueOnce({
        action: mockAction({ tool_name: 'read_neo4j_cypher', tool_args: '{}' }),
        llmCall: undefined,
      })
      .mockResolvedValueOnce({
        action: mockFinalAction('Done'),
        llmCall: undefined,
      })

    const pattern = simpleLoop(mockController, ['read_neo4j_cypher', 'Return'], {
      patternId: 'test',
      maxTurns: 5,
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

    // Clean exit via Return — no error events should be tracked
    const errorEvents = result.events.filter((e) => e.type === 'error')
    expect(errorEvents.length).toBe(0)
  })

  it('should accumulate results across iterations', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    // Restore callTool to return success
    callToolMock.mockResolvedValue({
      success: true,
      data: { result: 'tool result' },
    })

    const mockController = vi
      .fn()
      .mockResolvedValueOnce({
        action: mockAction({ tool_name: 'read_neo4j_cypher', tool_args: '{}' }),
        llmCall: undefined,
      })
      .mockResolvedValueOnce({
        action: mockAction({ tool_name: 'read_neo4j_cypher', tool_args: '{}' }),
        llmCall: undefined,
      })
      .mockResolvedValueOnce({
        action: mockFinalAction('Done'),
        llmCall: undefined,
      })

    const pattern = simpleLoop(mockController, ['read_neo4j_cypher', 'Return'], {
      patternId: 'test',
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

    // Should have tool_result events from both iterations
    const toolResults = result.events.filter((e) => e.type === 'tool_result')
    expect(toolResults.length).toBe(2)
  })

  it('should build priorResults from prior turn tool_results', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const mockController = vi.fn().mockResolvedValue({
      action: mockFinalAction('Done'),
      llmCall: undefined,
    })

    const pattern = simpleLoop(mockController, ['Return'], {
      patternId: 'test',
      rememberPriorTurns: true,
      priorTurnCount: 3,
    })

    const scope = createScope('test', { intent: 'second query' })
    // Context with a prior turn that has tool_result events
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        {
          type: 'user_message' as const,
          ts: 1,
          patternId: 'harness',
          data: { content: 'first query' },
        },
        {
          type: 'tool_result' as const,
          ts: 2,
          patternId: 'p1',
          id: 'ev-prior1',
          data: {
            tool: 'read_neo4j_cypher',
            result: { nodes: ['A', 'B'] },
            success: true,
            summary: 'Found 2 nodes A and B.',
          },
        },
        {
          type: 'user_message' as const,
          ts: 3,
          patternId: 'harness',
          data: { content: 'second query' },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'second query',
    }
    const view = createEventView(mockContext)

    await pattern.fn(scope, view)

    expect(mockController).toHaveBeenCalled()
    // priorResults is the 7th argument (index 6)
    const priorResults = mockController.mock.calls[0][6]
    expect(priorResults).toBeDefined()
    expect(priorResults).toHaveLength(1)
    expect(priorResults[0].ref_id).toBe('ev-prior1')
    expect(priorResults[0].tool).toBe('read_neo4j_cypher')
    expect(priorResults[0].summary).toBe('Found 2 nodes A and B.')
  })

  it('should exclude hidden tool_results from priorResults', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const mockController = vi.fn().mockResolvedValue({
      action: mockFinalAction('Done'),
      llmCall: undefined,
    })

    const pattern = simpleLoop(mockController, ['Return'], {
      patternId: 'test',
      rememberPriorTurns: true,
    })

    const scope = createScope('test', { intent: 'query' })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        {
          type: 'user_message' as const,
          ts: 1,
          patternId: 'harness',
          data: { content: 'first query' },
        },
        {
          type: 'tool_result' as const,
          ts: 2,
          patternId: 'p1',
          id: 'ev-visible',
          data: { tool: 'search', result: 'visible', success: true },
        },
        {
          type: 'tool_result' as const,
          ts: 3,
          patternId: 'p1',
          id: 'ev-hidden',
          data: { tool: 'fetch', result: 'hidden', success: true, hidden: true },
        },
        {
          type: 'user_message' as const,
          ts: 4,
          patternId: 'harness',
          data: { content: 'second query' },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'second query',
    }
    const view = createEventView(mockContext)

    await pattern.fn(scope, view)

    const priorResults = mockController.mock.calls[0][6]
    expect(priorResults).toBeDefined()
    expect(priorResults).toHaveLength(1)
    expect(priorResults[0].ref_id).toBe('ev-visible')
  })

  it('should exclude archived tool_results from priorResults', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const mockController = vi.fn().mockResolvedValue({
      action: mockFinalAction('Done'),
      llmCall: undefined,
    })

    const pattern = simpleLoop(mockController, ['Return'], {
      patternId: 'test',
      rememberPriorTurns: true,
    })

    const scope = createScope('test', { intent: 'query' })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        {
          type: 'user_message' as const,
          ts: 1,
          patternId: 'harness',
          data: { content: 'first query' },
        },
        {
          type: 'tool_result' as const,
          ts: 2,
          patternId: 'p1',
          id: 'ev-ok',
          data: { tool: 'search', result: 'ok', success: true },
        },
        {
          type: 'tool_result' as const,
          ts: 3,
          patternId: 'p1',
          id: 'ev-arch',
          data: { tool: 'fetch', result: 'archived', success: true, archived: true },
        },
        {
          type: 'user_message' as const,
          ts: 4,
          patternId: 'harness',
          data: { content: 'second query' },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'second query',
    }
    const view = createEventView(mockContext)

    await pattern.fn(scope, view)

    const priorResults = mockController.mock.calls[0][6]
    expect(priorResults).toHaveLength(1)
    expect(priorResults[0].ref_id).toBe('ev-ok')
  })

  it('should not build priorResults when rememberPriorTurns is false', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const mockController = vi.fn().mockResolvedValue({
      action: mockFinalAction('Done'),
      llmCall: undefined,
    })

    const pattern = simpleLoop(mockController, ['Return'], {
      patternId: 'test',
      rememberPriorTurns: false,
    })

    const scope = createScope('test', { intent: 'query' })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        { type: 'user_message' as const, ts: 1, patternId: 'harness', data: { content: 'first' } },
        {
          type: 'tool_result' as const,
          ts: 2,
          patternId: 'p1',
          id: 'ev-prior',
          data: { tool: 'search', result: 'data', success: true },
        },
        { type: 'user_message' as const, ts: 3, patternId: 'harness', data: { content: 'second' } },
      ],
      status: 'running' as const,
      data: {},
      input: 'second',
    }
    const view = createEventView(mockContext)

    await pattern.fn(scope, view)

    // priorResults (7th arg) should be undefined
    const priorResults = mockController.mock.calls[0][6]
    expect(priorResults).toBeUndefined()
  })

  it('should use raw result preview when no summary for priorResults', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const mockController = vi.fn().mockResolvedValue({
      action: mockFinalAction('Done'),
      llmCall: undefined,
    })

    const longResult = 'x'.repeat(300)
    const pattern = simpleLoop(mockController, ['Return'], {
      patternId: 'test',
      rememberPriorTurns: true,
    })

    const scope = createScope('test', { intent: 'query' })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        { type: 'user_message' as const, ts: 1, patternId: 'harness', data: { content: 'first' } },
        {
          type: 'tool_result' as const,
          ts: 2,
          patternId: 'p1',
          id: 'ev-long',
          data: { tool: 'search', result: longResult, success: true },
        },
        { type: 'user_message' as const, ts: 3, patternId: 'harness', data: { content: 'second' } },
      ],
      status: 'running' as const,
      data: {},
      input: 'second',
    }
    const view = createEventView(mockContext)

    await pattern.fn(scope, view)

    const priorResults = mockController.mock.calls[0][6]
    expect(priorResults).toHaveLength(1)
    // Should be truncated to 200 chars + '...'
    expect(priorResults[0].summary.length).toBeLessThanOrEqual(204) // 200 + '...'
    expect(priorResults[0].summary).toContain('...')
  })

  it('should limit priorResults to priorTurnCount turns', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const mockController = vi.fn().mockResolvedValue({
      action: mockFinalAction('Done'),
      llmCall: undefined,
    })

    // priorTurnCount: 2 — include results from the last 2 user turns (turns 2+3)
    // Turn 1 results should be excluded
    const pattern = simpleLoop(mockController, ['Return'], {
      patternId: 'test',
      rememberPriorTurns: true,
      priorTurnCount: 2,
    })

    const scope = createScope('test', { intent: 'query' })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        // Turn 1 (oldest — should NOT be included with priorTurnCount=2)
        { type: 'user_message' as const, ts: 1, patternId: 'harness', data: { content: 'first' } },
        {
          type: 'tool_result' as const,
          ts: 2,
          patternId: 'p1',
          id: 'ev-turn1',
          data: { tool: 'search', result: 'old data', success: true },
        },
        // Turn 2 (prior — should be included)
        { type: 'user_message' as const, ts: 3, patternId: 'harness', data: { content: 'second' } },
        {
          type: 'tool_result' as const,
          ts: 4,
          patternId: 'p1',
          id: 'ev-turn2',
          data: { tool: 'fetch', result: 'recent data', success: true },
        },
        // Turn 3 (current — included in window but has no tool_results yet)
        { type: 'user_message' as const, ts: 5, patternId: 'harness', data: { content: 'third' } },
      ],
      status: 'running' as const,
      data: {},
      input: 'third',
    }
    const view = createEventView(mockContext)

    await pattern.fn(scope, view)

    const priorResults = mockController.mock.calls[0][6]
    expect(priorResults).toBeDefined()
    // Only ev-turn2 should be included (turn 2 is in window), ev-turn1 is outside
    expect(priorResults).toHaveLength(1)
    expect(priorResults[0].ref_id).toBe('ev-turn2')
  })

  it('should exclude failed tool_results from priorResults', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const mockController = vi.fn().mockResolvedValue({
      action: mockFinalAction('Done'),
      llmCall: undefined,
    })

    const pattern = simpleLoop(mockController, ['Return'], {
      patternId: 'test',
      rememberPriorTurns: true,
    })

    const scope = createScope('test', { intent: 'query' })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        { type: 'user_message' as const, ts: 1, patternId: 'harness', data: { content: 'first' } },
        {
          type: 'tool_result' as const,
          ts: 2,
          patternId: 'p1',
          id: 'ev-ok',
          data: { tool: 'search', result: 'good data', success: true },
        },
        {
          type: 'tool_result' as const,
          ts: 3,
          patternId: 'p1',
          id: 'ev-fail',
          data: { tool: 'fetch', result: null, success: false, error: 'timeout' },
        },
        { type: 'user_message' as const, ts: 4, patternId: 'harness', data: { content: 'second' } },
      ],
      status: 'running' as const,
      data: {},
      input: 'second',
    }
    const view = createEventView(mockContext)

    await pattern.fn(scope, view)

    const priorResults = mockController.mock.calls[0][6]
    // Only the successful result should be included
    expect(priorResults).toHaveLength(1)
    expect(priorResults[0].ref_id).toBe('ev-ok')
  })

  it('should not resolve refs to hidden tool_result events', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    // Controller requests a tool with a ref: to a hidden event
    const mockController = vi
      .fn()
      .mockResolvedValueOnce({
        action: mockAction({
          tool_name: 'read_neo4j_cypher',
          tool_args: '{"data":"ref:ev-hidden-ref"}',
        }),
        llmCall: undefined,
      })
      .mockResolvedValueOnce({
        action: mockFinalAction('Done'),
        llmCall: undefined,
      })

    callToolMock.mockResolvedValue({ success: true, data: { result: 'ok' } })

    const pattern = simpleLoop(mockController, ['read_neo4j_cypher', 'Return'], {
      patternId: 'test',
      trackHistory: true,
    })

    const scope = createScope('test', { intent: 'query' })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        { type: 'user_message' as const, ts: 1, patternId: 'harness', data: { content: 'query' } },
        {
          type: 'tool_result' as const,
          ts: 2,
          patternId: 'p1',
          id: 'ev-hidden-ref',
          data: { tool: 'search', result: 'secret data', success: true, hidden: true },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'query',
    }
    const view = createEventView(mockContext)

    await pattern.fn(scope, view)

    // callTool should have been called with the unresolved ref string (not expanded)
    expect(callToolMock).toHaveBeenCalledWith(
      'read_neo4j_cypher',
      expect.objectContaining({ data: 'ref:ev-hidden-ref' }),
    )
  })

  it('should resolve refs to visible tool_result events', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    // Controller requests a tool with a ref: to a visible event
    const mockController = vi
      .fn()
      .mockResolvedValueOnce({
        action: mockAction({
          tool_name: 'read_neo4j_cypher',
          tool_args: '{"data":"ref:ev-visible-ref"}',
        }),
        llmCall: undefined,
      })
      .mockResolvedValueOnce({
        action: mockFinalAction('Done'),
        llmCall: undefined,
      })

    callToolMock.mockResolvedValue({ success: true, data: { result: 'ok' } })

    const pattern = simpleLoop(mockController, ['read_neo4j_cypher', 'Return'], {
      patternId: 'test',
      trackHistory: true,
    })

    const scope = createScope('test', { intent: 'query' })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        { type: 'user_message' as const, ts: 1, patternId: 'harness', data: { content: 'query' } },
        {
          type: 'tool_result' as const,
          ts: 2,
          patternId: 'p1',
          id: 'ev-visible-ref',
          data: { tool: 'search', result: { nodes: ['A', 'B'] }, success: true },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'query',
    }
    const view = createEventView(mockContext)

    await pattern.fn(scope, view)

    // callTool should have been called with the expanded result data (not the ref string)
    expect(callToolMock).toHaveBeenCalledWith(
      'read_neo4j_cypher',
      expect.objectContaining({ data: { nodes: ['A', 'B'] } }),
    )
  })

  it('should not resolve refs to archived tool_result events', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const mockController = vi
      .fn()
      .mockResolvedValueOnce({
        action: mockAction({
          tool_name: 'read_neo4j_cypher',
          tool_args: '{"data":"ref:ev-archived-ref"}',
        }),
        llmCall: undefined,
      })
      .mockResolvedValueOnce({
        action: mockFinalAction('Done'),
        llmCall: undefined,
      })

    callToolMock.mockResolvedValue({ success: true, data: { result: 'ok' } })

    const pattern = simpleLoop(mockController, ['read_neo4j_cypher', 'Return'], {
      patternId: 'test',
      trackHistory: true,
    })

    const scope = createScope('test', { intent: 'query' })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        { type: 'user_message' as const, ts: 1, patternId: 'harness', data: { content: 'query' } },
        {
          type: 'tool_result' as const,
          ts: 2,
          patternId: 'p1',
          id: 'ev-archived-ref',
          data: { tool: 'search', result: 'archived data', success: true, archived: true },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'query',
    }
    const view = createEventView(mockContext)

    await pattern.fn(scope, view)

    // callTool should have been called with the unresolved ref string
    expect(callToolMock).toHaveBeenCalledWith(
      'read_neo4j_cypher',
      expect.objectContaining({ data: 'ref:ev-archived-ref' }),
    )
  })

  it('should include callId on tool_call and tool_result events', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    callToolMock.mockResolvedValue({
      success: true,
      data: { result: 'tool result' },
    })

    const mockController = vi
      .fn()
      .mockResolvedValueOnce({
        action: mockAction({ tool_name: 'read_neo4j_cypher', tool_args: '{}' }),
        llmCall: undefined,
      })
      .mockResolvedValueOnce({
        action: mockFinalAction('Done'),
        llmCall: undefined,
      })

    const pattern = simpleLoop(mockController, ['read_neo4j_cypher', 'Return'], {
      patternId: 'test',
      trackHistory: true,
    })

    const scope = createScope('test', { intent: 'test query' })
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

    const toolCalls = result.events.filter((e) => e.type === 'tool_call')
    const toolResults = result.events.filter((e) => e.type === 'tool_result')
    expect(toolCalls.length).toBeGreaterThanOrEqual(1)
    expect(toolResults.length).toBeGreaterThanOrEqual(1)

    // Both should have callId
    const callData = toolCalls[0].data as { callId?: string; tool: string }
    const resultData = toolResults[0].data as { callId?: string; tool: string }
    expect(callData.callId).toBeDefined()
    expect(resultData.callId).toBeDefined()
    // callId should match between call and result
    expect(callData.callId).toBe(resultData.callId)
  })

  it('should record expansions on the LoopTurn when ref:<id> is resolved', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    // Capture turns passed to controller across two calls so we can read the
    // second invocation's input — that's where turn-0's expansions appear.
    const turnsByCall: unknown[][] = []
    const mockController = vi.fn(
      async (
        _user_message: string,
        _intent: string,
        previous_results: string,
        _n_turn: number,
        _schema?: unknown,
        _collector?: unknown,
        _priorResults?: unknown,
      ) => {
        turnsByCall.push(JSON.parse(previous_results))
        const action =
          turnsByCall.length === 1
            ? mockAction({ tool_name: 'read_neo4j_cypher', tool_args: '{"data":"ref:ev-source"}' })
            : mockFinalAction('Done')
        return { action, llmCall: undefined }
      },
    )

    callToolMock.mockResolvedValue({ success: true, data: { rows: [{ id: 1 }] } })

    const pattern = simpleLoop(mockController, ['read_neo4j_cypher', 'Return'], {
      patternId: 'test',
      trackHistory: true,
    })

    const scope = createScope('test', { intent: 'lookup' })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        { type: 'user_message' as const, ts: 1, patternId: 'harness', data: { content: 'lookup' } },
        {
          type: 'tool_result' as const,
          ts: 2,
          patternId: 'p1',
          id: 'ev-source',
          data: { tool: 'search', result: { hello: 'world' }, success: true },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'lookup',
    }
    const view = createEventView(mockContext)

    await pattern.fn(scope, view)

    // Second controller call should see the first turn's expansions populated.
    expect(turnsByCall.length).toBe(2)
    const turn0 = (
      turnsByCall[1] as Array<{ n: number; expansions?: Array<{ ref_id: string }> }>
    )[0]
    expect(turn0.n).toBe(0)
    expect(turn0.expansions).toBeDefined()
    expect(turn0.expansions!.map((e) => e.ref_id)).toEqual(['ev-source'])
  })

  it('should not include expansions on turns that did not resolve any ref', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const turnsByCall: unknown[][] = []
    const mockController = vi.fn(
      async (
        _user_message: string,
        _intent: string,
        previous_results: string,
        _n_turn: number,
        _schema?: unknown,
        _collector?: unknown,
        _priorResults?: unknown,
      ) => {
        turnsByCall.push(JSON.parse(previous_results))
        const action =
          turnsByCall.length === 1
            ? mockAction({ tool_name: 'read_neo4j_cypher', tool_args: '{"q":"plain"}' })
            : mockFinalAction('Done')
        return { action, llmCall: undefined }
      },
    )

    callToolMock.mockResolvedValue({ success: true, data: { rows: [] } })

    const pattern = simpleLoop(mockController, ['read_neo4j_cypher', 'Return'], {
      patternId: 'test',
      trackHistory: true,
    })

    const scope = createScope('test', { intent: 'plain' })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        { type: 'user_message' as const, ts: 1, patternId: 'harness', data: { content: 'plain' } },
      ],
      status: 'running' as const,
      data: {},
      input: 'plain',
    }
    const view = createEventView(mockContext)

    await pattern.fn(scope, view)

    expect(turnsByCall.length).toBe(2)
    const turn0 = (turnsByCall[1] as Array<{ n: number; expansions?: unknown }>)[0]
    expect(turn0.expansions).toBeUndefined()
  })

  it('expandPreviousResult: resolves a valid ref and pushes a turn with expansions', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const turnsByCall: unknown[][] = []
    const mockController = vi.fn(
      async (
        _user_message: string,
        _intent: string,
        previous_results: string,
        _n_turn: number,
        _schema?: unknown,
        _collector?: unknown,
        _priorResults?: unknown,
      ) => {
        turnsByCall.push(JSON.parse(previous_results))
        const action =
          turnsByCall.length === 1
            ? mockAction({ tool_name: 'expandPreviousResult', tool_args: 'ref:ev-target' })
            : mockFinalAction('Done')
        return { action, llmCall: undefined }
      },
    )

    const pattern = simpleLoop(mockController, ['read_neo4j_cypher', 'Return'], {
      patternId: 'test',
      trackHistory: true,
    })

    const scope = createScope('test', { intent: 'q' })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        { type: 'user_message' as const, ts: 1, patternId: 'harness', data: { content: 'q' } },
        {
          type: 'tool_result' as const,
          ts: 2,
          patternId: 'p1',
          id: 'ev-target',
          data: { tool: 'web', result: { hello: 'world' }, success: true },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'q',
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)

    // The synthetic call should NOT have hit the real tool dispatcher.
    expect(callToolMock).not.toHaveBeenCalled()

    // tool_call + tool_result should both be tracked under 'expandPreviousResult'.
    const calls = result.events.filter((e) => e.type === 'tool_call')
    const results = result.events.filter((e) => e.type === 'tool_result')
    expect(
      calls.find((e) => (e.data as { tool: string }).tool === 'expandPreviousResult'),
    ).toBeDefined()
    const expandResult = results.find(
      (e) => (e.data as { tool: string }).tool === 'expandPreviousResult',
    )!
    expect((expandResult.data as { success: boolean }).success).toBe(true)
    expect((expandResult.data as { result: unknown }).result).toEqual({ hello: 'world' })

    // Second controller call sees turn 0 with expansions populated.
    expect(turnsByCall.length).toBe(2)
    const turn0 = (
      turnsByCall[1] as Array<{ n: number; expansions?: Array<{ ref_id: string }> }>
    )[0]
    expect(turn0.expansions?.map((e) => e.ref_id)).toEqual(['ev-target'])
  })

  it('expandPreviousResult: invalid ref_id is tracked as failure but loop continues', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const mockController = vi
      .fn()
      .mockResolvedValueOnce({
        action: mockAction({ tool_name: 'expandPreviousResult', tool_args: 'ref:ev-missing' }),
        llmCall: undefined,
      })
      .mockResolvedValueOnce({
        action: mockFinalAction('Done'),
        llmCall: undefined,
      })

    const pattern = simpleLoop(mockController, ['Return'], {
      patternId: 'test',
      trackHistory: true,
    })

    const scope = createScope('test', { intent: 'q' })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        { type: 'user_message' as const, ts: 1, patternId: 'harness', data: { content: 'q' } },
      ],
      status: 'running' as const,
      data: {},
      input: 'q',
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)

    // Loop should not have aborted with an error event — it continues.
    expect(result.events.some((e) => e.type === 'error')).toBe(false)
    // The second controller call should have happened (loop continued).
    expect(mockController).toHaveBeenCalledTimes(2)

    const expandResult = result.events.find(
      (e) =>
        e.type === 'tool_result' && (e.data as { tool: string }).tool === 'expandPreviousResult',
    )!
    expect((expandResult.data as { success: boolean }).success).toBe(false)
    expect((expandResult.data as { error: string }).error).toContain('ev-missing')
  })

  it('expandPreviousResult: hidden tool_results are unresolvable', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const mockController = vi
      .fn()
      .mockResolvedValueOnce({
        action: mockAction({ tool_name: 'expandPreviousResult', tool_args: 'ref:ev-hidden' }),
        llmCall: undefined,
      })
      .mockResolvedValueOnce({
        action: mockFinalAction('Done'),
        llmCall: undefined,
      })

    const pattern = simpleLoop(mockController, ['Return'], {
      patternId: 'test',
      trackHistory: true,
    })

    const scope = createScope('test', { intent: 'q' })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        { type: 'user_message' as const, ts: 1, patternId: 'harness', data: { content: 'q' } },
        {
          type: 'tool_result' as const,
          ts: 2,
          patternId: 'p1',
          id: 'ev-hidden',
          data: { tool: 'web', result: 'secret', success: true, hidden: true },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'q',
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)

    const expandResult = result.events.find(
      (e) =>
        e.type === 'tool_result' && (e.data as { tool: string }).tool === 'expandPreviousResult',
    )!
    expect((expandResult.data as { success: boolean }).success).toBe(false)
  })

  it('expandPreviousResult: comma-separated ref list expands all in one turn', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const turnsByCall: unknown[][] = []
    const mockController = vi.fn(
      async (
        _user_message: string,
        _intent: string,
        previous_results: string,
        _n_turn: number,
        _schema?: unknown,
        _collector?: unknown,
        _priorResults?: unknown,
      ) => {
        turnsByCall.push(JSON.parse(previous_results))
        const action =
          turnsByCall.length === 1
            ? mockAction({ tool_name: 'expandPreviousResult', tool_args: 'ref:ev-a,ev-b,ev-c' })
            : mockFinalAction('Done')
        return { action, llmCall: undefined }
      },
    )

    const pattern = simpleLoop(mockController, ['Return'], {
      patternId: 'test',
      trackHistory: true,
    })

    const scope = createScope('test', { intent: 'q' })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        { type: 'user_message' as const, ts: 1, patternId: 'harness', data: { content: 'q' } },
        {
          type: 'tool_result' as const,
          ts: 2,
          patternId: 'p1',
          id: 'ev-a',
          data: { tool: 'web', result: { kind: 'a' }, success: true },
        },
        {
          type: 'tool_result' as const,
          ts: 3,
          patternId: 'p1',
          id: 'ev-b',
          data: { tool: 'web', result: { kind: 'b' }, success: true },
        },
        {
          type: 'tool_result' as const,
          ts: 4,
          patternId: 'p1',
          id: 'ev-c',
          data: { tool: 'web', result: { kind: 'c' }, success: true },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'q',
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)

    // One tool_call, one tool_result — both keyed under expandPreviousResult.
    const calls = result.events.filter(
      (e) => e.type === 'tool_call' && (e.data as { tool: string }).tool === 'expandPreviousResult',
    )
    const results = result.events.filter(
      (e) =>
        e.type === 'tool_result' && (e.data as { tool: string }).tool === 'expandPreviousResult',
    )
    expect(calls).toHaveLength(1)
    expect(results).toHaveLength(1)

    // tool_call args should reflect the multi-ref shape (ref_ids: [...])
    expect((calls[0].data as { args: { ref_ids?: string[] } }).args.ref_ids).toEqual([
      'ev-a',
      'ev-b',
      'ev-c',
    ])

    // tool_result.result is keyed by ref_id with each prior result expanded
    const combined = (results[0].data as { result: Record<string, unknown> }).result
    expect(combined).toEqual({
      'ev-a': { kind: 'a' },
      'ev-b': { kind: 'b' },
      'ev-c': { kind: 'c' },
    })

    // The next turn sees one LoopTurn with three expansions[]
    const turn0 = (
      turnsByCall[1] as Array<{ n: number; expansions?: Array<{ ref_id: string }> }>
    )[0]
    expect(turn0.expansions?.map((e) => e.ref_id)).toEqual(['ev-a', 'ev-b', 'ev-c'])
  })

  it('expandPreviousResult: partial failure surfaces successes and notes errors', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const mockController = vi
      .fn()
      .mockResolvedValueOnce({
        action: mockAction({
          tool_name: 'expandPreviousResult',
          tool_args: 'ref:ev-ok,ev-missing',
        }),
        llmCall: undefined,
      })
      .mockResolvedValueOnce({
        action: mockFinalAction('Done'),
        llmCall: undefined,
      })

    const pattern = simpleLoop(mockController, ['Return'], {
      patternId: 'test',
      trackHistory: true,
    })

    const scope = createScope('test', { intent: 'q' })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        { type: 'user_message' as const, ts: 1, patternId: 'harness', data: { content: 'q' } },
        {
          type: 'tool_result' as const,
          ts: 2,
          patternId: 'p1',
          id: 'ev-ok',
          data: { tool: 'web', result: { kind: 'ok' }, success: true },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'q',
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)

    const expandResult = result.events.find(
      (e) =>
        e.type === 'tool_result' && (e.data as { tool: string }).tool === 'expandPreviousResult',
    )!
    // overallSuccess is true if at least one ref resolved.
    expect((expandResult.data as { success: boolean }).success).toBe(true)
    // Failures still surface in the error string + per-key __error.
    expect((expandResult.data as { error: string }).error).toContain('ev-missing')
    const combined = (expandResult.data as { result: Record<string, unknown> }).result
    expect(combined['ev-ok']).toEqual({ kind: 'ok' })
    expect((combined['ev-missing'] as { __error: string }).__error).toContain('ev-missing')

    // Loop continues — no abort error event.
    expect(result.events.some((e) => e.type === 'error')).toBe(false)
  })

  it('expandPreviousResult: JSON form {"ref_ids": ["a","b"]} expands batch', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const mockController = vi
      .fn()
      .mockResolvedValueOnce({
        action: mockAction({
          tool_name: 'expandPreviousResult',
          tool_args: '{"ref_ids":["ev-x","ev-y"]}',
        }),
        llmCall: undefined,
      })
      .mockResolvedValueOnce({
        action: mockFinalAction('Done'),
        llmCall: undefined,
      })

    const pattern = simpleLoop(mockController, ['Return'], {
      patternId: 'test',
      trackHistory: true,
    })

    const scope = createScope('test', { intent: 'q' })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        { type: 'user_message' as const, ts: 1, patternId: 'harness', data: { content: 'q' } },
        {
          type: 'tool_result' as const,
          ts: 2,
          patternId: 'p1',
          id: 'ev-x',
          data: { tool: 'web', result: 1, success: true },
        },
        {
          type: 'tool_result' as const,
          ts: 3,
          patternId: 'p1',
          id: 'ev-y',
          data: { tool: 'web', result: 2, success: true },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'q',
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)
    const expandResult = result.events.find(
      (e) =>
        e.type === 'tool_result' && (e.data as { tool: string }).tool === 'expandPreviousResult',
    )!
    expect((expandResult.data as { success: boolean }).success).toBe(true)
    const combined = (expandResult.data as { result: Record<string, unknown> }).result
    expect(combined).toEqual({ 'ev-x': 1, 'ev-y': 2 })
  })

  it('expandPreviousResult: also accepts JSON form {"ref_id": "..."} for resilience', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const mockController = vi
      .fn()
      .mockResolvedValueOnce({
        action: mockAction({
          tool_name: 'expandPreviousResult',
          tool_args: '{"ref_id":"ev-json"}',
        }),
        llmCall: undefined,
      })
      .mockResolvedValueOnce({
        action: mockFinalAction('Done'),
        llmCall: undefined,
      })

    const pattern = simpleLoop(mockController, ['Return'], {
      patternId: 'test',
      trackHistory: true,
    })

    const scope = createScope('test', { intent: 'q' })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        { type: 'user_message' as const, ts: 1, patternId: 'harness', data: { content: 'q' } },
        {
          type: 'tool_result' as const,
          ts: 2,
          patternId: 'p1',
          id: 'ev-json',
          data: { tool: 'web', result: { ok: true }, success: true },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'q',
    }
    const view = createEventView(mockContext)

    const result = await pattern.fn(scope, view)
    const expandResult = result.events.find(
      (e) =>
        e.type === 'tool_result' && (e.data as { tool: string }).tool === 'expandPreviousResult',
    )!
    expect((expandResult.data as { success: boolean }).success).toBe(true)
    expect((expandResult.data as { result: unknown }).result).toEqual({ ok: true })
  })

  it('regression: priorResults sent to controller have explicit null for unexpanded refs (postgres-18 hallucination repro)', async () => {
    // Repro of the bug observed against the live agent (PR #34, fix 2a751e7):
    // withReferences attached the postgres-18 web-search ref, but my original
    // annotateExpansions left `expanded_in_turn` absent (not null). MiniJinja's
    // `is not none` test evaluates TRUE for undefined attributes (because
    // undefined ≠ None), so the prompt's `{% if r.expanded_in_turn is not none %}`
    // branch fired for refs that had never been expanded — rendering
    // "(expanded in turn )" with an empty turn number, suppressing the summary,
    // and causing the LLM to hallucinate PostgreSQL release notes instead of
    // calling expandPreviousResult.
    //
    // Fix: annotateExpansions always sets `expanded_in_turn: number | null`
    // (never absent). This test guards against regressing to the absent-field
    // form by asserting the explicit-null shape on the controller's input.
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const priorByCall: Array<unknown[]> = []
    const mockController = vi.fn(
      async (
        _user_message: string,
        _intent: string,
        _previous_results: string,
        _n_turn: number,
        _schema?: unknown,
        _collector?: unknown,
        priorResults?: unknown,
      ) => {
        priorByCall.push(priorResults as unknown[])
        return { action: mockFinalAction('Done'), llmCall: undefined }
      },
    )

    const pattern = simpleLoop(mockController, ['Return'], {
      patternId: 'neo4j-query',
      trackHistory: true,
    })

    const scope = createScope('neo4j-query', {
      intent: 'Update Neo4j knowledge graph with PostgreSQL 18 release information',
      attachedRefs: [
        {
          ref_id: 'ev-pg18',
          tool: 'search',
          summary: 'PostgreSQL 18 was released on September 25 2025...',
        },
      ],
    })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        {
          type: 'user_message' as const,
          ts: 1,
          patternId: 'harness',
          data: { content: 'Add this info to the neo4j graph' },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'Add this info to the neo4j graph',
    }
    const view = createEventView(mockContext)

    await pattern.fn(scope, view)

    expect(priorByCall.length).toBe(1)
    const prior = priorByCall[0] as Array<{ ref_id: string; expanded_in_turn: unknown }>
    expect(prior).toHaveLength(1)
    expect(prior[0].ref_id).toBe('ev-pg18')
    // The critical assertion: `expanded_in_turn` is explicitly null, NOT absent.
    expect(prior[0].expanded_in_turn).toBeNull()
    expect('expanded_in_turn' in prior[0]).toBe(true)
  })

  it('merges scope.data.attachedRefs with priorTurnCount-derived refs (dedup)', async () => {
    const { simpleLoop } =
      await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const priorByCall: unknown[][] = []
    const mockController = vi.fn(
      async (
        _user_message: string,
        _intent: string,
        _previous_results: string,
        _n_turn: number,
        _schema?: unknown,
        _collector?: unknown,
        priorResults?: unknown,
      ) => {
        priorByCall.push(priorResults as unknown[])
        return { action: mockFinalAction('Done'), llmCall: undefined }
      },
    )

    const pattern = simpleLoop(mockController, ['Return'], {
      patternId: 'test',
      trackHistory: true,
    })

    // attachedRefs include 'ev-shared' (also in turn-window) + 'ev-attached-only'
    const scope = createScope('test', {
      intent: 'q',
      attachedRefs: [
        { ref_id: 'ev-attached-only', tool: 'web', summary: 'A' },
        { ref_id: 'ev-shared', tool: 'web', summary: 'shared (from selector)' },
      ],
    })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        { type: 'user_message' as const, ts: 1, patternId: 'harness', data: { content: 'q' } },
        // Same ev-shared ref is also discoverable via the turn-window mechanism
        {
          type: 'tool_result' as const,
          ts: 2,
          patternId: 'web-search',
          id: 'ev-shared',
          data: {
            tool: 'web',
            result: 'shared content',
            success: true,
            summary: 'shared (from window)',
          },
        },
        {
          type: 'tool_result' as const,
          ts: 3,
          patternId: 'web-search',
          id: 'ev-window-only',
          data: { tool: 'web', result: 'window-only content', success: true, summary: 'W' },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'q',
    }
    const view = createEventView(mockContext)

    await pattern.fn(scope, view)

    expect(priorByCall.length).toBe(1)
    const prior = priorByCall[0] as Array<{ ref_id: string; summary: string }>
    const ids = prior.map((r) => r.ref_id)
    expect(ids).toContain('ev-attached-only')
    expect(ids).toContain('ev-shared')
    expect(ids).toContain('ev-window-only')
    // dedup: ev-shared appears once, and the *attached* version wins (selector summary, not the window summary)
    const sharedCount = ids.filter((id) => id === 'ev-shared').length
    expect(sharedCount).toBe(1)
    const sharedRef = prior.find((r) => r.ref_id === 'ev-shared')!
    expect(sharedRef.summary).toBe('shared (from selector)')
  })

  describe('resultOmit — compact controller view, full-fidelity events', () => {
    const BIG_URL = 'https://loop.cloud.microsoft/p/'.padEnd(519, 'x')
    const searchResult = {
      query: 'q',
      total: 14,
      results: [{ name: 'a.docx', webUrl: BIG_URL, item_id: 'i1' }],
    }
    const baseContext = () => ({
      sessionId: 'omit',
      createdAt: Date.now(),
      events: [
        { type: 'user_message' as const, ts: 1, patternId: 'harness', data: { content: 'q' } },
      ],
      status: 'running' as const,
      data: {},
      input: 'q',
    })

    it('projects the turn log the controller reads, but the tool_result EVENT keeps the full result', async () => {
      const { simpleLoop } =
        await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
      const { createScope } = await import('../../../../lib/harness-patterns/context.server')
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

      callToolMock.mockResolvedValueOnce({ success: true, data: searchResult })
      const mockController = vi
        .fn()
        .mockResolvedValueOnce({
          action: mockAction({ tool_name: 'read_neo4j_cypher', tool_args: '{"query":"x"}' }),
          llmCall: undefined,
        })
        .mockResolvedValueOnce({ action: mockFinalAction('done'), llmCall: undefined })

      const pattern = simpleLoop(mockController, ['read_neo4j_cypher', 'Return'], {
        patternId: 'omit-loop',
        resultOmit: { read_neo4j_cypher: ['webUrl'] },
      })
      const scope = createScope('omit-loop', { intent: 'q' })
      const result = await pattern.fn(scope, createEventView(baseContext()))

      // Turn 2's previous_results (3rd positional arg) is what the LLM reads.
      const previousResults = mockController.mock.calls[1][2] as string
      expect(previousResults).not.toContain(BIG_URL)
      expect(previousResults).toContain('a.docx')
      expect(previousResults).toContain('i1')
      // The turn's result is a JSON string nested in the outer JSON — keys
      // arrive escaped.
      expect(previousResults).toContain('total\\":14')

      // The event — what the compactExecution and citation extractors read — is complete.
      const event = result.events.find((e) => e.type === 'tool_result')!
      expect((event.data as { result: typeof searchResult }).result.results[0].webUrl).toBe(BIG_URL)
    })

    it('a tool without an omit entry passes through untouched', async () => {
      const { simpleLoop } =
        await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
      const { createScope } = await import('../../../../lib/harness-patterns/context.server')
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

      callToolMock.mockResolvedValueOnce({ success: true, data: searchResult })
      const mockController = vi
        .fn()
        .mockResolvedValueOnce({
          action: mockAction({ tool_name: 'read_neo4j_cypher', tool_args: '{"query":"x"}' }),
          llmCall: undefined,
        })
        .mockResolvedValueOnce({ action: mockFinalAction('done'), llmCall: undefined })

      const pattern = simpleLoop(mockController, ['read_neo4j_cypher', 'Return'], {
        patternId: 'no-omit-loop',
        resultOmit: { some_other_tool: ['webUrl'] },
      })
      const scope = createScope('no-omit-loop', { intent: 'q' })
      await pattern.fn(scope, createEventView(baseContext()))

      expect(mockController.mock.calls[1][2] as string).toContain(BIG_URL)
    })

    it('expandPreviousResult projects per ORIGIN tool; the expand event stays raw', async () => {
      const { simpleLoop } =
        await import('../../../../lib/harness-patterns/patterns/simpleLoop.server')
      const { createScope } = await import('../../../../lib/harness-patterns/context.server')
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

      const mockController = vi
        .fn()
        .mockResolvedValueOnce({
          action: mockAction({ tool_name: 'expandPreviousResult', tool_args: 'ref:ev-big' }),
          llmCall: undefined,
        })
        .mockResolvedValueOnce({ action: mockFinalAction('done'), llmCall: undefined })

      const ctx = baseContext()
      ctx.events.push({
        type: 'tool_result' as const,
        ts: 2,
        patternId: 'microsoft-365',
        id: 'ev-big',
        data: {
          tool: 'graph_files_search',
          result: searchResult,
          success: true,
          summary: 'search hits',
        },
      } as never)

      const pattern = simpleLoop(mockController, ['Return'], {
        patternId: 'omit-expand',
        // Keyed by the REFERENCED result's origin tool, not by expandPreviousResult.
        resultOmit: { graph_files_search: ['webUrl'] },
      })
      const scope = createScope('omit-expand', { intent: 'q' })
      const result = await pattern.fn(scope, createEventView(ctx))

      const previousResults = mockController.mock.calls[1][2] as string
      expect(previousResults).not.toContain(BIG_URL)
      expect(previousResults).toContain('a.docx')

      // The tracked expand event keeps the raw referenced result.
      const expandEvent = result.events.find(
        (e) =>
          e.type === 'tool_result' && (e.data as { tool: string }).tool === 'expandPreviousResult',
      )!
      expect(JSON.stringify((expandEvent.data as { result: unknown }).result)).toContain(BIG_URL)
    })
  })
})
