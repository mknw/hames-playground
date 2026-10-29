/**
 * actorCritic Pattern Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { withRunFrame } from '@hames-ai/harness-patterns/run-frame.server'
import { mockAction, mockFinalAction, mockCriticResult, mockBAMLClient } from '../../../mocks/baml'
import { mockCallTool, mockListTools } from '../../../mocks/mcp'
import type { CriticFnWithLLMData } from '@hames-ai/harness-baml/baml-adapters.server'
import type { ActorFn, ActorInput } from '@hames-ai/harness-patterns/types'

/**
 * #374: a pattern run needs a run frame, and these tests drive patterns
 * directly rather than through a harness entry point — the script /
 * background-job case ruling D3 makes explicit. An empty frame gives every slot
 * its default; nesting one inside an open frame joins it rather than opening a
 * second, so this is safe to apply uniformly.
 */
const runInFrame = <T>(fn: () => Promise<T>): Promise<T> => withRunFrame({}, fn)

// Mock server-only imports
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

// Mock MCP client
const callToolMock = mockCallTool({
  responses: {
    'code-mode': { result: 'Script executed successfully' },
    Return: { response: 'Done' },
  },
})

const listToolsMock = mockListTools(['code-mode', 'Return'])

vi.mock('@hames-ai/harness-patterns/mcp-client.server', () => ({
  callTool: callToolMock,
  listTools: listToolsMock,
}))

// Mock BAML client
vi.mock('@hames-ai/harness-baml/baml_client', () => ({
  b: mockBAMLClient({
    actorActions: [
      mockAction({ tool_name: 'code-mode', tool_args: '{"script":"console.log(1)"}' }),
      mockFinalAction('Script complete'),
    ],
    criticResults: [mockCriticResult({ is_sufficient: true })],
  }),
}))

describe('actorCritic', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should export actorCritic function', async () => {
    const { actorCritic } = await import('@hames-ai/harness-patterns/patterns/actorCritic.server')
    expect(actorCritic).toBeDefined()
    expect(typeof actorCritic).toBe('function')
  })

  it('should create a ConfiguredPattern with name and config', async () => {
    const { actorCritic } = await import('@hames-ai/harness-patterns/patterns/actorCritic.server')
    const { createActorControllerAdapter, createCriticAdapter } =
      await import('@hames-ai/harness-baml/baml-adapters.server')

    const actor = createActorControllerAdapter(['code-mode', 'Return'])
    const critic = createCriticAdapter()

    const pattern = actorCritic(actor, critic, ['code-mode', 'Return'], {
      patternId: 'test-actor-critic',
    })

    expect(pattern.name).toBe('actorCritic')
    expect(pattern.config.patternId).toBe('test-actor-critic')
    expect(pattern.fn).toBeDefined()
  })

  // As with simpleLoop's `maxTurns`: the default lives once, in
  // `DEFAULT_SETTINGS`, and is read here through the pattern rather than
  // restated as a literal (#269).
  it('should take its default maxRetries from the request settings', async () => {
    const { actorCritic } = await import('@hames-ai/harness-patterns/patterns/actorCritic.server')
    const { DEFAULT_SETTINGS } = await import('../../../../lib/settings')
    const { createActorControllerAdapter, createCriticAdapter } =
      await import('@hames-ai/harness-baml/baml-adapters.server')

    const actor = createActorControllerAdapter(['Return'])
    const critic = createCriticAdapter()

    const pattern = actorCritic(actor, critic, ['Return'])

    expect(pattern.name).toBe('actorCritic')
    expect(pattern.estimateTurns?.(DEFAULT_SETTINGS)).toBe(DEFAULT_SETTINGS.maxRetries)
  })

  it('should handle custom maxRetries config', async () => {
    const { actorCritic } = await import('@hames-ai/harness-patterns/patterns/actorCritic.server')
    const { createActorControllerAdapter, createCriticAdapter } =
      await import('@hames-ai/harness-baml/baml-adapters.server')

    const actor = createActorControllerAdapter(['Return'])
    const critic = createCriticAdapter()

    const pattern = actorCritic(actor, critic, ['Return'], {
      maxRetries: 5,
      patternId: 'limited-critic',
    })

    expect(pattern.name).toBe('actorCritic')
    expect(pattern.config.patternId).toBe('limited-critic')
  })
})

describe('actorCritic execution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Reset callTool mock
    callToolMock.mockResolvedValue({
      success: true,
      data: { result: 'ok' },
    })
  })

  it('dispatches under-escaped tool_args and marks the call as reconstructed', async () => {
    // actorCritic is where the incident landed — `.harness-logs/
    // sandbox-tool-recovery.json`, event ev-tey7ez, a `sandbox_edit` whose
    // content quotes were escaped one level instead of two. Shape-for-shape
    // repro; a 20 KB synthetic reconstruction is pinned in
    // json-repair-unescaped-content.test.ts.
    const { actorCritic } = await import('@hames-ai/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('@hames-ai/harness-patterns/context.server')
    const { createEventView } = await import('@hames-ai/harness-patterns/patterns')

    const mockActor = vi.fn().mockResolvedValue({
      action: mockAction({
        tool_name: 'code-mode',
        tool_args: '{"script": "print("ok")", "path": "/work/f.py"}',
      }),
      llmCall: undefined,
    })
    const mockCritic = vi.fn().mockResolvedValue({
      result: mockCriticResult({ is_sufficient: true }),
      llmCall: undefined,
    })

    const pattern = actorCritic(mockActor, mockCritic, ['code-mode'], { patternId: 'test' })

    const result = await runInFrame(() =>
      pattern.fn(
        createScope('test', { intent: 'edit' }),
        createEventView({
          sessionId: 'test',
          createdAt: Date.now(),
          events: [],
          status: 'running' as const,
          data: {},
          input: 'edit',
        }),
      ),
    )

    expect(result.events.filter((e) => e.type === 'error')).toHaveLength(0)

    const toolCall = result.events.find((e) => e.type === 'tool_call')
    expect(toolCall?.data).toMatchObject({
      tool: 'code-mode',
      args: { script: 'print("ok")', path: '/work/f.py' },
      repaired: { strategy: 'unescaped-content', counts: { quotes: 2, controlChars: 0 } },
    })
  })

  it('pins the repaired marker to the right sub-call when a batch member is precheck-declined', async () => {
    // Review F1, actorCritic half — the pattern the incident actually ran on.
    // See the simpleLoop twin for the desync this catches.
    const { actorCritic } = await import('@hames-ai/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('@hames-ai/harness-patterns/context.server')
    const { createEventView } = await import('@hames-ai/harness-patterns/patterns')

    const mockActor = vi.fn().mockResolvedValue({
      action: mockAction({
        tool_name: 'not_allowed_tool',
        tool_args: '{"a":1}',
        additional_calls: [
          { tool_name: 'code-mode', tool_args: '{"script": "print("ok")", "path": "/work/f.py"}' },
        ],
      }),
      llmCall: undefined,
    })
    const mockCritic = vi.fn().mockResolvedValue({
      result: mockCriticResult({ is_sufficient: true }),
      llmCall: undefined,
    })

    const pattern = actorCritic(mockActor, mockCritic, ['code-mode'], { patternId: 'test' })

    const result = await runInFrame(() =>
      pattern.fn(
        createScope('test', { intent: 'edit' }),
        createEventView({
          sessionId: 'test',
          createdAt: Date.now(),
          events: [],
          status: 'running' as const,
          data: {},
          input: 'edit',
        }),
      ),
    )

    const calls = result.events.filter((e) => e.type === 'tool_call')
    expect(calls.map((e) => (e.data as { tool: string }).tool)).toEqual([
      'not_allowed_tool',
      'code-mode',
    ])
    expect(calls[0].data).not.toHaveProperty('repaired')
    expect(calls[1].data).toMatchObject({
      tool: 'code-mode',
      args: { script: 'print("ok")', path: '/work/f.py' },
      repaired: { strategy: 'unescaped-content', counts: { quotes: 2, controlChars: 0 } },
    })
  })

  it('should track controller_action and critic_result events', async () => {
    const { actorCritic } = await import('@hames-ai/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('@hames-ai/harness-patterns/context.server')
    const { createEventView } = await import('@hames-ai/harness-patterns/patterns')

    // Create mock actor and critic
    const mockActor = vi.fn().mockResolvedValue({
      action: mockAction({ tool_name: 'code-mode', tool_args: '{"script":"test"}' }),
      llmCall: undefined,
    })

    const mockCritic = vi.fn().mockResolvedValue({
      result: mockCriticResult({ is_sufficient: true }),
      llmCall: undefined,
    })

    const pattern = actorCritic(mockActor, mockCritic, ['code-mode'], {
      patternId: 'test',
      trackHistory: ['controller_action', 'critic_result'],
    })

    // Create mock scope and view
    const scope = createScope('test', { intent: 'execute script' })
    const mockContext = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        {
          type: 'user_message' as const,
          ts: Date.now(),
          patternId: 'harness',
          data: { content: 'execute script' },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'execute script',
    }
    const view = createEventView(mockContext)

    // Execute pattern
    const result = await runInFrame(() => pattern.fn(scope, view))

    // Verify actor and critic were called
    expect(mockActor).toHaveBeenCalled()
    expect(mockCritic).toHaveBeenCalled()
    expect(result).toBeDefined()
  })

  it('should retry when tool is not allowed', async () => {
    const { actorCritic } = await import('@hames-ai/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('@hames-ai/harness-patterns/context.server')
    const { createEventView } = await import('@hames-ai/harness-patterns/patterns')

    const mockActor = vi
      .fn()
      .mockResolvedValueOnce({
        action: mockAction({ tool_name: 'forbidden_tool', tool_args: '{}' }),
        llmCall: undefined,
      })
      .mockResolvedValueOnce({
        action: mockAction({ tool_name: 'code-mode', tool_args: '{"script":"test"}' }),
        llmCall: undefined,
      })

    const mockCritic = vi.fn().mockResolvedValue({
      result: mockCriticResult({ is_sufficient: true }),
      llmCall: undefined,
    })

    const pattern = actorCritic(mockActor, mockCritic, ['code-mode'], {
      patternId: 'test',
      maxRetries: 3,
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

    const result = await runInFrame(() => pattern.fn(scope, view))

    // Should have called actor twice (first attempt with wrong tool, second with correct)
    expect(mockActor).toHaveBeenCalledTimes(2)
    expect(result.data.result).toBeDefined()
  })

  it('should retry when tool_args JSON is invalid', async () => {
    const { actorCritic } = await import('@hames-ai/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('@hames-ai/harness-patterns/context.server')
    const { createEventView } = await import('@hames-ai/harness-patterns/patterns')

    const mockActor = vi
      .fn()
      .mockResolvedValueOnce({
        action: mockAction({ tool_name: 'code-mode', tool_args: 'not valid json' }),
        llmCall: undefined,
      })
      .mockResolvedValueOnce({
        action: mockAction({ tool_name: 'code-mode', tool_args: '{"script":"test"}' }),
        llmCall: undefined,
      })

    const mockCritic = vi.fn().mockResolvedValue({
      result: mockCriticResult({ is_sufficient: true }),
      llmCall: undefined,
    })

    const pattern = actorCritic(mockActor, mockCritic, ['code-mode'], {
      patternId: 'test',
      maxRetries: 3,
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

    const result = await runInFrame(() => pattern.fn(scope, view))

    // Should have called actor twice (first with invalid JSON, second with valid)
    expect(mockActor).toHaveBeenCalledTimes(2)
    expect(result.data.result).toBeDefined()
  })

  it('should retry when tool execution fails', async () => {
    const { actorCritic } = await import('@hames-ai/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('@hames-ai/harness-patterns/context.server')
    const { createEventView } = await import('@hames-ai/harness-patterns/patterns')

    // First call fails, second succeeds
    callToolMock
      .mockResolvedValueOnce({ success: false, data: null, error: 'Execution failed' })
      .mockResolvedValueOnce({ success: true, data: { result: 'ok' } })

    const mockActor = vi.fn().mockResolvedValue({
      action: mockAction({ tool_name: 'code-mode', tool_args: '{"script":"test"}' }),
      llmCall: undefined,
    })

    const mockCritic = vi.fn().mockResolvedValue({
      result: mockCriticResult({ is_sufficient: true }),
      llmCall: undefined,
    })

    const pattern = actorCritic(mockActor, mockCritic, ['code-mode'], {
      patternId: 'test',
      maxRetries: 3,
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

    const result = await runInFrame(() => pattern.fn(scope, view))

    expect(mockActor).toHaveBeenCalledTimes(2)
    expect(result.data.result).toBeDefined()
  })

  it('should retry when critic says not sufficient', async () => {
    const { actorCritic } = await import('@hames-ai/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('@hames-ai/harness-patterns/context.server')
    const { createEventView } = await import('@hames-ai/harness-patterns/patterns')

    callToolMock.mockResolvedValue({ success: true, data: { result: 'ok' } })

    const mockActor = vi.fn().mockResolvedValue({
      action: mockAction({ tool_name: 'code-mode', tool_args: '{"script":"test"}' }),
      llmCall: undefined,
    })

    const mockCritic = vi
      .fn()
      .mockResolvedValueOnce({
        result: mockCriticResult({
          is_sufficient: false,
          explanation: 'Try harder',
          suggested_approach: 'Use a better approach',
        }),
        llmCall: undefined,
      })
      .mockResolvedValueOnce({
        result: mockCriticResult({ is_sufficient: true }),
        llmCall: undefined,
      })

    const pattern = actorCritic(mockActor, mockCritic, ['code-mode'], {
      patternId: 'test',
      maxRetries: 3,
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

    const result = await runInFrame(() => pattern.fn(scope, view))

    // Should have called actor and critic twice
    expect(mockActor).toHaveBeenCalledTimes(2)
    expect(mockCritic).toHaveBeenCalledTimes(2)
    expect(result.data.result).toBeDefined()
  })

  it('should track error when max retries exceeded', async () => {
    const { actorCritic } = await import('@hames-ai/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('@hames-ai/harness-patterns/context.server')
    const { createEventView } = await import('@hames-ai/harness-patterns/patterns')

    callToolMock.mockResolvedValue({ success: true, data: { result: 'ok' } })

    const mockActor = vi.fn().mockResolvedValue({
      action: mockAction({ tool_name: 'code-mode', tool_args: '{"script":"test"}' }),
      llmCall: undefined,
    })

    // Critic always says not sufficient
    const mockCritic = vi.fn().mockResolvedValue({
      result: mockCriticResult({ is_sufficient: false, explanation: 'Not good enough' }),
      llmCall: undefined,
    })

    const pattern = actorCritic(mockActor, mockCritic, ['code-mode'], {
      patternId: 'test',
      maxRetries: 2,
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

    const result = await runInFrame(() => pattern.fn(scope, view))

    // Should have exhausted retries
    expect(mockActor).toHaveBeenCalledTimes(2)
    expect(mockCritic).toHaveBeenCalledTimes(2)

    const errorEvents = result.events.filter((e) => e.type === 'error')
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(errorEvents[0].data)).toContain('Max retries')
  })

  it('should handle actor errors gracefully', async () => {
    const { actorCritic } = await import('@hames-ai/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('@hames-ai/harness-patterns/context.server')
    const { createEventView } = await import('@hames-ai/harness-patterns/patterns')

    const mockActor = vi.fn().mockRejectedValue(new Error('Actor crashed'))

    const mockCritic = vi.fn().mockResolvedValue({
      result: mockCriticResult({ is_sufficient: true }),
      llmCall: undefined,
    })

    const pattern = actorCritic(mockActor, mockCritic, ['code-mode'], {
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

    const result = await runInFrame(() => pattern.fn(scope, view))

    const errorEvents = result.events.filter((e) => e.type === 'error')
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(errorEvents[0].data)).toContain('Actor crashed')
  })
})

describe('actorCritic criticCadence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    callToolMock.mockResolvedValue({ success: true, data: { result: 'ok' } })
  })

  // Minimal scope/view/context builder shared by the cadence tests.
  async function run(
    mockActor: ActorFn,
    mockCritic: CriticFnWithLLMData,
    config: Record<string, unknown>,
    tools: string[] = ['code-mode'],
  ) {
    const { actorCritic } = await import('@hames-ai/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('@hames-ai/harness-patterns/context.server')
    const { createEventView } = await import('@hames-ai/harness-patterns/patterns')

    const pattern = actorCritic(mockActor, mockCritic, tools, {
      patternId: 'cadence',
      ...config,
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
          data: { content: 'do it' },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'do it',
    }
    return runInFrame(() => pattern.fn(scope, createEventView(mockContext)))
  }

  it('skips the critic until the Nth successful turn (cadence backstop)', async () => {
    // Actor never signals is_final; critic accepts when it finally runs.
    const mockActor = vi.fn().mockResolvedValue({
      action: mockAction({ tool_name: 'code-mode', tool_args: '{"script":"step"}' }),
      llmCall: undefined,
    })
    const mockCritic = vi.fn().mockResolvedValue({
      result: mockCriticResult({ is_sufficient: true }),
      llmCall: undefined,
    })

    const result = await run(mockActor, mockCritic, { maxRetries: 6, criticCadence: 3 })

    // Turns 0,1 skip the critic; turn 2 (3rd successful turn) runs it → exits.
    expect(mockActor).toHaveBeenCalledTimes(3)
    expect(mockCritic).toHaveBeenCalledTimes(1)
    expect(result.data.result).toBeDefined()
  })

  it('runs the critic immediately when the actor sets is_final (early trigger)', async () => {
    // First action is already is_final → critic runs on turn 0 despite cadence 3.
    // Use an allowlisted tool (not mockFinalAction's 'Return', which the loop
    // rejects before the critic) so is_final is what triggers the critic.
    const mockActor = vi.fn().mockResolvedValue({
      action: mockAction({
        tool_name: 'code-mode',
        tool_args: '{"script":"done"}',
        is_final: true,
      }),
      llmCall: undefined,
    })
    const mockCritic = vi.fn().mockResolvedValue({
      result: mockCriticResult({ is_sufficient: true }),
      llmCall: undefined,
    })

    const result = await run(mockActor, mockCritic, { maxRetries: 6, criticCadence: 3 })

    expect(mockActor).toHaveBeenCalledTimes(1)
    expect(mockCritic).toHaveBeenCalledTimes(1)
    expect(result.data.result).toBeDefined()
  })

  it('encodes the write-then-run fix: never critiques the written-but-unrun step', async () => {
    // Turn 0: WRITE the script (is_final=false) → must be skipped by the critic.
    // Turn 1: RUN it (is_final=true) → critic runs and accepts. The regression
    // (.harness-logs/context-3817275e-*.json) was the critic accepting turn 0.
    const mockActor = vi
      .fn()
      .mockResolvedValueOnce({
        action: mockAction({
          tool_name: 'code-mode',
          tool_args: '{"script":"write report"}',
          is_final: false,
        }),
        llmCall: undefined,
      })
      .mockResolvedValueOnce({
        action: mockAction({
          tool_name: 'code-mode',
          tool_args: '{"script":"run report"}',
          is_final: true,
        }),
        llmCall: undefined,
      })
    const mockCritic = vi.fn().mockResolvedValue({
      result: mockCriticResult({ is_sufficient: true }),
      llmCall: undefined,
    })

    await run(mockActor, mockCritic, { maxRetries: 6, criticCadence: 3 })

    // The critic must NOT have been consulted after the write-only turn.
    expect(mockActor).toHaveBeenCalledTimes(2)
    expect(mockCritic).toHaveBeenCalledTimes(1)
  })

  it('always critiques on the final attempt even if cadence never hits', async () => {
    const mockActor = vi.fn().mockResolvedValue({
      action: mockAction({ tool_name: 'code-mode', tool_args: '{"script":"step"}' }),
      llmCall: undefined,
    })
    const mockCritic = vi.fn().mockResolvedValue({
      result: mockCriticResult({ is_sufficient: true }),
      llmCall: undefined,
    })

    // cadence 5 never divides turns 1..2, but the last attempt forces a critic run.
    const result = await run(mockActor, mockCritic, { maxRetries: 2, criticCadence: 5 })

    expect(mockActor).toHaveBeenCalledTimes(2)
    expect(mockCritic).toHaveBeenCalledTimes(1)
    expect(result.data.result).toBeDefined()
  })

  it('clamps criticCadence < 1 to every-turn (critic can never be disabled)', async () => {
    const mockActor = vi.fn().mockResolvedValue({
      action: mockAction({ tool_name: 'code-mode', tool_args: '{"script":"step"}' }),
      llmCall: undefined,
    })
    // Not sufficient on turn 0, sufficient on turn 1 — proves the critic ran both.
    const mockCritic = vi
      .fn()
      .mockResolvedValueOnce({
        result: mockCriticResult({ is_sufficient: false, explanation: 'more' }),
        llmCall: undefined,
      })
      .mockResolvedValueOnce({
        result: mockCriticResult({ is_sufficient: true }),
        llmCall: undefined,
      })

    await run(mockActor, mockCritic, { maxRetries: 2, criticCadence: 0 })

    expect(mockCritic).toHaveBeenCalledTimes(2)
  })

  // #784 item 7: the actor must name a tool on every attempt, so it marked
  // itself done by re-running the call it had just made, with identical args
  // and an identical result. That repeat is no longer dispatched. The other
  // cases characterise its scope: the sandbox tools are stateful, so anything
  // but a final-marking repeat of the newest, successful call still runs — and
  // so does a repeat whose result the critic has already judged: the skip holds
  // only while the critic has not yet given feedback on that result (fix round 1).
  describe('a final-marking repeat of the previous call (#784 item 7)', () => {
    const step = (args: string, is_final = false) => ({
      action: mockAction({ tool_name: 'code-mode', tool_args: args, is_final }),
      llmCall: undefined,
    })
    const accept = () =>
      vi.fn().mockResolvedValue({
        result: mockCriticResult({ is_sufficient: true }),
        llmCall: undefined,
      })

    it('is not dispatched again; the critic judges the result already held', async () => {
      callToolMock.mockResolvedValueOnce({ success: true, data: { files: ['a.docx'] } })
      const mockActor = vi
        .fn()
        .mockResolvedValueOnce(step('{"top": 5}'))
        .mockResolvedValueOnce(step('{"top": 5}', true))
      const mockCritic = accept()

      const result = await run(mockActor, mockCritic, { maxRetries: 6, criticCadence: 3 })

      expect(callToolMock).toHaveBeenCalledTimes(1)
      expect(result.events.filter((e) => e.type === 'tool_call')).toHaveLength(1)
      expect(result.events.filter((e) => e.type === 'tool_result')).toHaveLength(1)
      expect(mockCritic).toHaveBeenCalledTimes(1)
      const judged = mockCritic.mock.calls[0][1] as { output: string; error?: string | null }[]
      expect(judged).toHaveLength(2)
      expect(judged[1].output).toBe(JSON.stringify({ files: ['a.docx'] }))
      expect(judged[1].error).toBeNull()
      expect(result.data.result).toEqual({ files: ['a.docx'] })
    })

    // Fix round 1: the skip must not fire after the critic has judged — and
    // rejected — that result. Cadence 1 is the shape where it bit hardest: the
    // critic judges every successful attempt, so the only repeat it could skip
    // is one it has already rejected, and the loop burned attempts judging the
    // identical output on stale state. Passes on main; MUTATION: delete the
    // `lastRun = undefined` on the rejection branch of `runCadenceAndCritic`
    // and this goes red (1 callTool call, the stale `{ status: 'running' }`).
    it('runs a repeat the critic has already rejected (a poll that came back running)', async () => {
      callToolMock
        .mockResolvedValueOnce({ success: true, data: { status: 'running' } })
        .mockResolvedValueOnce({ success: true, data: { status: 'done' } })
      const mockActor = vi
        .fn()
        .mockResolvedValueOnce(step('{"script":"poll"}'))
        .mockResolvedValueOnce(step('{"script":"poll"}', true))
      const mockCritic = vi
        .fn()
        .mockResolvedValueOnce({
          result: mockCriticResult({ is_sufficient: false, explanation: 'poll again' }),
          llmCall: undefined,
        })
        .mockResolvedValueOnce({
          result: mockCriticResult({ is_sufficient: true }),
          llmCall: undefined,
        })

      const result = await run(mockActor, mockCritic, { maxRetries: 6, criticCadence: 1 })

      expect(callToolMock).toHaveBeenCalledTimes(2)
      expect(result.data.result).toEqual({ status: 'done' })
    })

    it('runs when the args differ', async () => {
      const mockActor = vi
        .fn()
        .mockResolvedValueOnce(step('{"top": 5}'))
        .mockResolvedValueOnce(step('{"top": 10}', true))

      await run(mockActor, accept(), { maxRetries: 6, criticCadence: 3 })

      expect(callToolMock).toHaveBeenCalledTimes(2)
    })

    it('runs on a non-final turn (a poll may return something new)', async () => {
      const mockActor = vi
        .fn()
        .mockResolvedValueOnce(step('{"top": 5}'))
        .mockResolvedValueOnce(step('{"top": 5}'))
        .mockResolvedValueOnce(step('{"top": 5}', true))

      await run(mockActor, accept(), { maxRetries: 6, criticCadence: 3 })

      // The second (non-final) repeat ran; only the final-marking third did not.
      expect(callToolMock).toHaveBeenCalledTimes(2)
    })

    it('runs when another attempt came in between', async () => {
      // A batch is the case that matters: it records its own attempt without
      // replacing the remembered singular call, and a write-then-run batch is
      // exactly what changes the sandbox state the repeat would read.
      const mockActor = vi
        .fn()
        .mockResolvedValueOnce(step('{"top": 5}'))
        .mockResolvedValueOnce({
          action: mockAction({
            tool_name: 'code-mode',
            tool_args: '{"script": "write"}',
            additional_calls: [{ tool_name: 'code-mode', tool_args: '{"script": "run"}' }],
          }),
          llmCall: undefined,
        })
        .mockResolvedValueOnce(step('{"top": 5}', true))

      await run(mockActor, accept(), { maxRetries: 6, criticCadence: 3 })

      expect(callToolMock).toHaveBeenCalledTimes(4)
    })

    it('runs when the tool differs', async () => {
      // Same args, a different allowed tool: the tool-name half of the match
      // carries real weight — `read {"path":"x"}` then `delete {"path":"x"}`
      // with is_final must not be skipped and judged on the read's result.
      // MUTATION: `lastRun.tool === action.tool_name &&` → `true &&` leaves
      // every other case green; this one goes red.
      const mockActor = vi
        .fn()
        .mockResolvedValueOnce(step('{"path": "x"}'))
        .mockResolvedValueOnce({
          action: mockAction({
            tool_name: 'file-delete',
            tool_args: '{"path": "x"}',
            is_final: true,
          }),
          llmCall: undefined,
        })

      await run(mockActor, accept(), { maxRetries: 6, criticCadence: 3 }, [
        'code-mode',
        'file-delete',
      ])

      expect(callToolMock).toHaveBeenCalledTimes(2)
    })

    it('runs when the previous call failed', async () => {
      callToolMock.mockResolvedValueOnce({ success: false, data: null, error: 'busy' })
      const mockActor = vi
        .fn()
        .mockResolvedValueOnce(step('{"top": 5}'))
        .mockResolvedValueOnce(step('{"top": 5}', true))

      await run(mockActor, accept(), { maxRetries: 6, criticCadence: 3 })

      expect(callToolMock).toHaveBeenCalledTimes(2)
    })
  })
})

/**
 * SA-C1 — the critic's feedback has to reach the actor.
 *
 * `runCadenceAndCritic` wrote the rejection reason to `scope.data.feedback`,
 * which nothing on the actor's input path reads, while the actor prompt's
 * closing section told it to address feedback it was never shown. The retry
 * therefore ran blind — the whole reason actorCritic exists over simpleLoop —
 * and a false imperative invited the model to invent a critique. The reason now
 * rides `ScriptExecutionEvent.feedback` on the attempt the critic judged, which
 * both adapters map onto `Attempt.feedback` and `ActorAttemptLog` renders.
 */
describe('actorCritic critic feedback reaches the next attempt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    callToolMock.mockResolvedValue({ success: true, data: { result: 'ok' } })
  })

  const REASON = 'the CSV is missing the amount column — re-read it with headers'

  /** previous_attempts is one mutated array across calls, so snapshot per call.
   *  Lane A4: the attempts arrive on the object seam (`input.previousAttempts`). */
  function snapshottingActor(snapshots: Array<Array<Record<string, unknown>>>) {
    return vi.fn(async (...args: unknown[]) => {
      const input = args[0] as ActorInput
      const attempts = input.previousAttempts as unknown as Array<Record<string, unknown>>
      snapshots.push(attempts.map((a) => ({ ...a })))
      return {
        action: mockAction({ tool_name: 'code-mode', tool_args: '{"script":"read()"}' }),
        llmCall: undefined,
      }
    })
  }

  async function run(
    actor: ActorFn,
    critic: CriticFnWithLLMData,
    config: Record<string, unknown> = {},
  ) {
    const { actorCritic } = await import('@hames-ai/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('@hames-ai/harness-patterns/context.server')
    const { createEventView } = await import('@hames-ai/harness-patterns/patterns')

    const pattern = actorCritic(actor, critic, ['code-mode'], {
      patternId: 'feedback',
      maxRetries: 2,
      ...config,
    })
    const ctx = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        {
          type: 'user_message' as const,
          ts: Date.now(),
          patternId: 'harness',
          data: { content: 'total the invoices' },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'total the invoices',
    }
    return runInFrame(() => pattern.fn(createScope('test', {}), createEventView(ctx)))
  }

  it('stamps the rejection reason onto the attempt the critic judged', async () => {
    const snapshots: Array<Array<Record<string, unknown>>> = []
    const actor = snapshottingActor(snapshots)
    const critic = vi
      .fn()
      .mockResolvedValueOnce({
        result: mockCriticResult({ is_sufficient: false, suggested_approach: REASON }),
        llmCall: undefined,
      })
      .mockResolvedValueOnce({
        result: mockCriticResult({ is_sufficient: true }),
        llmCall: undefined,
      })

    await run(actor as never, critic as never)

    // Attempt 1 sees an empty history; attempt 2 sees attempt 1 WITH the reason.
    expect(snapshots).toHaveLength(2)
    expect(snapshots[0]).toEqual([])
    expect(snapshots[1]).toHaveLength(1)
    expect(snapshots[1][0].feedback).toBe(REASON)
  })

  it('falls back to the explanation when the critic suggests no approach', async () => {
    const snapshots: Array<Array<Record<string, unknown>>> = []
    const critic = vi
      .fn()
      .mockResolvedValueOnce({
        result: mockCriticResult({ is_sufficient: false, explanation: 'no total was printed' }),
        llmCall: undefined,
      })
      .mockResolvedValueOnce({
        result: mockCriticResult({ is_sufficient: true }),
        llmCall: undefined,
      })

    await run(snapshottingActor(snapshots) as never, critic as never)

    expect(snapshots[1][0].feedback).toBe('no total was printed')
  })

  it('leaves an accepted attempt unstamped — the closing nag stays off', async () => {
    const snapshots: Array<Array<Record<string, unknown>>> = []
    const critic = vi
      .fn()
      .mockResolvedValue({ result: mockCriticResult({ is_sufficient: true }), llmCall: undefined })

    await run(snapshottingActor(snapshots) as never, critic as never)

    // Accepted on attempt 1, so there is no second call and nothing to stamp.
    expect(snapshots).toHaveLength(1)
    expect(critic).toHaveBeenCalledTimes(1)
  })

  it('shows the critic its own prior feedback, so it can tell whether it was addressed', async () => {
    const criticSnapshots: Array<Array<Record<string, unknown>>> = []
    const critic = vi.fn(async (...args: unknown[]) => {
      const attempts = args[1] as Array<Record<string, unknown>>
      criticSnapshots.push(attempts.map((a) => ({ ...a })))
      return {
        result: mockCriticResult({
          is_sufficient: criticSnapshots.length > 1,
          suggested_approach: REASON,
        }),
        llmCall: undefined,
      }
    })

    await run(snapshottingActor([]) as never, critic as never)

    expect(criticSnapshots).toHaveLength(2)
    // Its own first-round reason is on the attempt it rejected.
    expect(criticSnapshots[1][0].feedback).toBe(REASON)
    // ...and not on the attempt it has not judged yet.
    expect(criticSnapshots[1][1].feedback).toBeUndefined()
  })
})

describe('actorCritic: the intent its actor and critic read', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    callToolMock.mockResolvedValue({ success: true, data: { result: 'ok' } })
  })

  /** One accepted attempt over `data`; returns the actor's and the critic's intents. */
  async function intentsFor(data: Record<string, unknown>) {
    const { actorCritic } = await import('@hames-ai/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('@hames-ai/harness-patterns/context.server')
    const { createEventView } = await import('@hames-ai/harness-patterns/patterns')
    const actor = vi.fn(async (_input: ActorInput) => ({
      action: mockAction({ tool_name: 'code-mode', tool_args: '{"script":"run()"}' }),
      llmCall: undefined,
    }))
    const critic = vi.fn(async (_intent: string) => ({
      result: mockCriticResult({ is_sufficient: true }),
      llmCall: undefined,
    }))
    const pattern = actorCritic(actor as never, critic as never, ['code-mode'], {
      patternId: 'intent',
    })
    const ctx = {
      sessionId: 'test',
      createdAt: Date.now(),
      events: [
        {
          type: 'user_message' as const,
          ts: Date.now(),
          patternId: 'harness',
          data: { content: 'total the invoices and save the report' },
        },
      ],
      status: 'running' as const,
      data: {},
      input: 'total the invoices and save the report',
    }
    await runInFrame(() => pattern.fn(createScope('test', data), createEventView(ctx)))
    return { actor: actor.mock.calls[0][0].intent, critic: critic.mock.calls[0][0] }
  }

  // Outside a decisionLoop nothing changes: no scope, the raw message (or a
  // routed `data.intent`) is the intent. MUTATION: always append a scope line.
  it('is the user message, or data.intent, when no route scope is given', async () => {
    expect(await intentsFor({})).toEqual({
      actor: 'total the invoices and save the report',
      critic: 'total the invoices and save the report',
    })
    expect(await intentsFor({ intent: 'routed intent' })).toEqual({
      actor: 'routed intent',
      critic: 'routed intent',
    })
  })

  // FIX14. MUTATIONS: ignore `routeScope` (the critic judges the raw message);
  // replace the task with the scope (the request is lost); scope the critic's
  // intent but not the actor's, or the reverse.
  it('appends a route scope to the task, for the actor and the critic alike', async () => {
    const scope = 'THIS STEP: only the totals'
    expect(await intentsFor({ routeScope: scope })).toEqual({
      actor: `total the invoices and save the report\n\n${scope}`,
      critic: `total the invoices and save the report\n\n${scope}`,
    })
    expect(await intentsFor({ intent: 'routed intent', routeScope: scope })).toEqual({
      actor: `routed intent\n\n${scope}`,
      critic: `routed intent\n\n${scope}`,
    })
  })
})
