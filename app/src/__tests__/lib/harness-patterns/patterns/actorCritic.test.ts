/**
 * actorCritic Pattern Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mockAction, mockFinalAction, mockCriticResult, mockBAMLClient } from '../../../mocks/baml'
import { mockCallTool, mockListTools } from '../../../mocks/mcp'
import type {
  ActorControllerFnWithLLMData,
  CriticFnWithLLMData,
} from '../../../../lib/harness-patterns/baml-adapters.server'

// Mock server-only imports
vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
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

vi.mock('../../../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: callToolMock,
  listTools: listToolsMock,
}))

// Mock BAML client
vi.mock('../../../../../baml_client', () => ({
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
    const { actorCritic } =
      await import('../../../../lib/harness-patterns/patterns/actorCritic.server')
    expect(actorCritic).toBeDefined()
    expect(typeof actorCritic).toBe('function')
  })

  it('should create a ConfiguredPattern with name and config', async () => {
    const { actorCritic } =
      await import('../../../../lib/harness-patterns/patterns/actorCritic.server')
    const { createActorControllerAdapter, createCriticAdapter } =
      await import('../../../../lib/harness-patterns/baml-adapters.server')

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
    const { actorCritic } =
      await import('../../../../lib/harness-patterns/patterns/actorCritic.server')
    const { DEFAULT_SETTINGS } = await import('../../../../lib/settings')
    const { createActorControllerAdapter, createCriticAdapter } =
      await import('../../../../lib/harness-patterns/baml-adapters.server')

    const actor = createActorControllerAdapter(['Return'])
    const critic = createCriticAdapter()

    const pattern = actorCritic(actor, critic, ['Return'])

    expect(pattern.name).toBe('actorCritic')
    expect(pattern.estimateTurns?.(DEFAULT_SETTINGS)).toBe(DEFAULT_SETTINGS.maxRetries)
  })

  it('should handle custom maxRetries config', async () => {
    const { actorCritic } =
      await import('../../../../lib/harness-patterns/patterns/actorCritic.server')
    const { createActorControllerAdapter, createCriticAdapter } =
      await import('../../../../lib/harness-patterns/baml-adapters.server')

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

  it('should track controller_action and critic_result events', async () => {
    const { actorCritic } =
      await import('../../../../lib/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

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
    const result = await pattern.fn(scope, view)

    // Verify actor and critic were called
    expect(mockActor).toHaveBeenCalled()
    expect(mockCritic).toHaveBeenCalled()
    expect(result).toBeDefined()
  })

  it('should retry when tool is not allowed', async () => {
    const { actorCritic } =
      await import('../../../../lib/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

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

    const result = await pattern.fn(scope, view)

    // Should have called actor twice (first attempt with wrong tool, second with correct)
    expect(mockActor).toHaveBeenCalledTimes(2)
    expect(result.data.result).toBeDefined()
  })

  it('should retry when tool_args JSON is invalid', async () => {
    const { actorCritic } =
      await import('../../../../lib/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

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

    const result = await pattern.fn(scope, view)

    // Should have called actor twice (first with invalid JSON, second with valid)
    expect(mockActor).toHaveBeenCalledTimes(2)
    expect(result.data.result).toBeDefined()
  })

  it('should retry when tool execution fails', async () => {
    const { actorCritic } =
      await import('../../../../lib/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

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

    const result = await pattern.fn(scope, view)

    expect(mockActor).toHaveBeenCalledTimes(2)
    expect(result.data.result).toBeDefined()
  })

  it('should retry when critic says not sufficient', async () => {
    const { actorCritic } =
      await import('../../../../lib/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

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

    const result = await pattern.fn(scope, view)

    // Should have called actor and critic twice
    expect(mockActor).toHaveBeenCalledTimes(2)
    expect(mockCritic).toHaveBeenCalledTimes(2)
    expect(result.data.result).toBeDefined()
  })

  it('should track error when max retries exceeded', async () => {
    const { actorCritic } =
      await import('../../../../lib/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

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

    const result = await pattern.fn(scope, view)

    // Should have exhausted retries
    expect(mockActor).toHaveBeenCalledTimes(2)
    expect(mockCritic).toHaveBeenCalledTimes(2)

    const errorEvents = result.events.filter((e) => e.type === 'error')
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(errorEvents[0].data)).toContain('Max retries')
  })

  it('should handle actor errors gracefully', async () => {
    const { actorCritic } =
      await import('../../../../lib/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

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

    const result = await pattern.fn(scope, view)

    const errorEvents = result.events.filter((e) => e.type === 'error')
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(errorEvents[0].data)).toContain('Actor crashed')
  })

  it('should use availableTools from config', async () => {
    const { actorCritic } =
      await import('../../../../lib/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    callToolMock.mockResolvedValue({ success: true, data: { result: 'ok' } })

    let receivedAvailableTools: string[] = []
    const mockActor = vi.fn().mockImplementation(async (_user, _intent, availableTools) => {
      receivedAvailableTools = availableTools
      return {
        action: mockAction({ tool_name: 'code-mode', tool_args: '{}' }),
        llmCall: undefined,
      }
    })

    const mockCritic = vi.fn().mockResolvedValue({
      result: mockCriticResult({ is_sufficient: true }),
      llmCall: undefined,
    })

    const pattern = actorCritic(mockActor, mockCritic, ['code-mode'], {
      patternId: 'test',
      availableTools: ['custom-tool-1', 'custom-tool-2'],
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

    await pattern.fn(scope, view)

    expect(receivedAvailableTools).toEqual(['custom-tool-1', 'custom-tool-2'])
  })
})

describe('actorCritic criticCadence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    callToolMock.mockResolvedValue({ success: true, data: { result: 'ok' } })
  })

  // Minimal scope/view/context builder shared by the cadence tests.
  async function run(
    mockActor: ActorControllerFnWithLLMData,
    mockCritic: CriticFnWithLLMData,
    config: Record<string, unknown>,
  ) {
    const { actorCritic } =
      await import('../../../../lib/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

    const pattern = actorCritic(mockActor, mockCritic, ['code-mode'], {
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
    return pattern.fn(scope, createEventView(mockContext))
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

  /** previous_attempts is one mutated array across calls, so snapshot per call. */
  function snapshottingActor(snapshots: Array<Array<Record<string, unknown>>>) {
    return vi.fn(async (...args: unknown[]) => {
      const attempts = args[3] as Array<Record<string, unknown>>
      snapshots.push(attempts.map((a) => ({ ...a })))
      return {
        action: mockAction({ tool_name: 'code-mode', tool_args: '{"script":"read()"}' }),
        llmCall: undefined,
      }
    })
  }

  async function run(
    actor: ActorControllerFnWithLLMData,
    critic: CriticFnWithLLMData,
    config: Record<string, unknown> = {},
  ) {
    const { actorCritic } =
      await import('../../../../lib/harness-patterns/patterns/actorCritic.server')
    const { createScope } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns')

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
    return pattern.fn(createScope('test', {}), createEventView(ctx))
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
