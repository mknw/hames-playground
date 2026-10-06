/**
 * Harness Tests
 *
 * Tests for harness(), resumeHarness(), and continueSession()
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock server-only imports
vi.mock('@hames-ai/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

// Mock runChain to track calls
const mockChain = vi.fn()
vi.mock('@hames-ai/harness-patterns/patterns/chain.server', () => ({
  runChain: mockChain,
  chain: vi.fn(),
}))

/** Park a context on one request, as a stored blob holds it: the owning
 *  runChain wrote the `hitl_request` and set `paused` (#433). Returns its id. */
function pauseOn(ctx: { events: unknown[]; status: string }, names = ['test']): string {
  const requestId = '7f1e8f5a-3c1b-4d2e-9a6b-0c5d4e3f2a1b'
  ctx.events.push({
    id: 'ev-request',
    type: 'hitl_request',
    ts: Date.now(),
    patternId: 'test',
    data: {
      v: 1,
      requestId,
      runId: '',
      key: 'confirm:write',
      kind: 'confirm',
      question: 'Write it?',
      options: [
        { id: 'approve', label: 'Approve' },
        { id: 'reject', label: 'Reject', unattended: true },
      ],
      defaultOption: 'reject',
      unattended: 'apply-default',
      summary: {},
      blocking: true,
      resumeAt: { index: 0, names },
    },
  })
  ctx.status = 'paused'
  return requestId
}

describe('harness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Default chain implementation - just mark as done
    mockChain.mockImplementation(async (ctx) => {
      ctx.status = 'done'
      return ctx
    })
  })

  it('should export harness function', async () => {
    const { harness } = await import('@hames-ai/harness-patterns/harness.server')
    expect(harness).toBeDefined()
    expect(typeof harness).toBe('function')
  })

  it('should create a callable agent function', async () => {
    const { harness } = await import('@hames-ai/harness-patterns/harness.server')

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' },
    }

    const agent = harness(mockPattern)
    expect(typeof agent).toBe('function')
  })

  it('should execute patterns via chain', async () => {
    const { harness } = await import('@hames-ai/harness-patterns/harness.server')

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' },
    }

    const agent = harness(mockPattern)
    await agent('test input')

    expect(mockChain).toHaveBeenCalled()
  })

  it('should return response from context data', async () => {
    const { harness } = await import('@hames-ai/harness-patterns/harness.server')

    mockChain.mockImplementation(async (ctx) => {
      ctx.data.response = 'Hello world!'
      ctx.status = 'done'
      return ctx
    })

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' },
    }

    const agent = harness(mockPattern)
    const result = await agent('test input')

    expect(result.response).toBe('Hello world!')
    expect(result.status).toBe('done')
  })

  it('should include duration_ms in result', async () => {
    const { harness } = await import('@hames-ai/harness-patterns/harness.server')

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' },
    }

    const agent = harness(mockPattern)
    const result = await agent('test input')

    expect(result.duration_ms).toBeDefined()
    expect(typeof result.duration_ms).toBe('number')
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('should include serialized context', async () => {
    const { harness } = await import('@hames-ai/harness-patterns/harness.server')

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' },
    }

    const agent = harness(mockPattern)
    const result = await agent('test input')

    expect(result.serialized).toBeDefined()
    expect(typeof result.serialized).toBe('string')

    // Should be valid JSON
    const parsed = JSON.parse(result.serialized)
    expect(parsed).toBeDefined()
  })

  it('should add assistant_message event when done with response', async () => {
    const { harness } = await import('@hames-ai/harness-patterns/harness.server')

    mockChain.mockImplementation(async (ctx) => {
      ctx.data.response = 'Final response'
      ctx.status = 'done'
      return ctx
    })

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' },
    }

    const agent = harness(mockPattern)
    const result = await agent('test input')

    const assistantMessages = result.context.events.filter((e) => e.type === 'assistant_message')
    expect(assistantMessages.length).toBeGreaterThan(0)
    expect((assistantMessages[0].data as { content: string }).content).toBe('Final response')
  })

  it('should handle errors gracefully', async () => {
    const { harness } = await import('@hames-ai/harness-patterns/harness.server')

    mockChain.mockRejectedValue(new Error('Test error'))

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' },
    }

    const agent = harness(mockPattern)
    const result = await agent('test input')

    expect(result.status).toBe('error')
    expect(result.response).toContain('Error:')
    expect(result.response).toContain('Test error')
  })

  it('should accept sessionId parameter', async () => {
    const { harness } = await import('@hames-ai/harness-patterns/harness.server')

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' },
    }

    const agent = harness(mockPattern)
    const result = await agent('test input', 'custom-session-id')

    expect(result.context.sessionId).toBe('custom-session-id')
  })

  it('should accept initialData parameter', async () => {
    const { harness } = await import('@hames-ai/harness-patterns/harness.server')

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' },
    }

    const agent = harness<{ response?: string; customField: string }>(mockPattern)
    const result = await agent('test input', undefined, { customField: 'custom value' })

    expect(result.data.customField).toBe('custom value')
  })
})

describe('resumeHarness', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockChain.mockImplementation(async (ctx) => {
      ctx.status = 'done'
      return ctx
    })
  })

  const mockPattern = () => ({
    name: 'test',
    fn: vi.fn(async (scope) => scope),
    config: { patternId: 'test' },
  })

  it('should export resumeHarness function', async () => {
    const { resumeHarness } = await import('@hames-ai/harness-patterns/harness.server')
    expect(resumeHarness).toBeDefined()
    expect(typeof resumeHarness).toBe('function')
  })

  it('refuses a context that is not paused, with a coded error', async () => {
    const { resumeHarness } = await import('@hames-ai/harness-patterns/harness.server')
    const { HitlAnswerError } = await import('@hames-ai/harness-patterns/hitl.server')
    const { serializeContext, createContext } =
      await import('@hames-ai/harness-patterns/context.server')

    const ctx = createContext('test')
    ctx.status = 'running'

    const refusal = resumeHarness(serializeContext(ctx), [mockPattern()], {})
    await expect(refusal).rejects.toBeInstanceOf(HitlAnswerError)
    await expect(refusal).rejects.toMatchObject({ code: 'not-paused' })
    expect(mockChain).not.toHaveBeenCalled()
  })

  it('records the answer and re-enters at the paused pattern', async () => {
    const { resumeHarness } = await import('@hames-ai/harness-patterns/harness.server')
    const { serializeContext, createContext } =
      await import('@hames-ai/harness-patterns/context.server')

    const ctx = createContext<{ response?: string }>('test')
    const requestId = pauseOn(ctx)

    const result = await resumeHarness(
      serializeContext(ctx),
      [mockPattern()],
      { [requestId]: 'approve' },
      { principal: 'user-1' },
    )

    expect(mockChain).toHaveBeenCalledWith(expect.anything(), expect.anything(), undefined, {
      startAt: 0,
    })
    const answers = result.context.events.filter((e) => e.type === 'hitl_response')
    expect(answers.map((e) => e.data)).toEqual([
      expect.objectContaining({ requestId, choice: 'approve', by: 'person', principal: 'user-1' }),
    ])
    // The legacy event is never written any more (#433 F9).
    expect(result.context.events.some((e) => e.type === 'approval_response')).toBe(false)
  })

  it('should handle errors during resume', async () => {
    const { resumeHarness } = await import('@hames-ai/harness-patterns/harness.server')
    const { serializeContext, createContext } =
      await import('@hames-ai/harness-patterns/context.server')

    mockChain.mockRejectedValue(new Error('Resume error'))

    const ctx = createContext<{ response?: string }>('test')
    const requestId = pauseOn(ctx)

    const result = await resumeHarness(serializeContext(ctx), [mockPattern()], {
      [requestId]: 'reject',
    })

    expect(result.status).toBe('error')
    expect(result.response).toContain('Resume error')
  })
})

describe('continueSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockChain.mockImplementation(async (ctx) => {
      ctx.status = 'done'
      return ctx
    })
  })

  it('should export continueSession function', async () => {
    const { continueSession } = await import('@hames-ai/harness-patterns/harness.server')
    expect(continueSession).toBeDefined()
    expect(typeof continueSession).toBe('function')
  })

  it('should continue session with new input', async () => {
    const { continueSession } = await import('@hames-ai/harness-patterns/harness.server')
    const { serializeContext, createContext } =
      await import('@hames-ai/harness-patterns/context.server')

    const ctx = createContext<{ response?: string }>('first message')
    ctx.status = 'done'
    const serialized = serializeContext(ctx)

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' },
    }

    const result = await continueSession(serialized, [mockPattern], 'second message')

    expect(result.context.input).toBe('second message')
    expect(mockChain).toHaveBeenCalled()
  })

  it('should add user_message event for new input', async () => {
    const { continueSession } = await import('@hames-ai/harness-patterns/harness.server')
    const { serializeContext, createContext } =
      await import('@hames-ai/harness-patterns/context.server')

    const ctx = createContext<{ response?: string }>('first message')
    ctx.status = 'done'
    const serialized = serializeContext(ctx)

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' },
    }

    const result = await continueSession(serialized, [mockPattern], 'follow up')

    const userMessages = result.context.events.filter((e) => e.type === 'user_message')
    const followUpMessage = userMessages.find(
      (e) => (e.data as { content: string }).content === 'follow up',
    )
    expect(followUpMessage).toBeDefined()
  })

  it('should handle errors during continue', async () => {
    const { continueSession } = await import('@hames-ai/harness-patterns/harness.server')
    const { serializeContext, createContext } =
      await import('@hames-ai/harness-patterns/context.server')

    mockChain.mockRejectedValue(new Error('Continue error'))

    const ctx = createContext<{ response?: string }>('first message')
    ctx.status = 'done'
    const serialized = serializeContext(ctx)

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' },
    }

    const result = await continueSession(serialized, [mockPattern], 'second message')

    expect(result.status).toBe('error')
    expect(result.response).toContain('Continue error')
  })

  it('should reset status to running before executing', async () => {
    const { continueSession } = await import('@hames-ai/harness-patterns/harness.server')
    const { serializeContext, createContext } =
      await import('@hames-ai/harness-patterns/context.server')

    // Track the status when chain is called
    let statusWhenChainCalled: string | undefined

    mockChain.mockImplementation(async (ctx) => {
      statusWhenChainCalled = ctx.status
      ctx.status = 'done'
      return ctx
    })

    const ctx = createContext<{ response?: string }>('first message')
    ctx.status = 'done'
    const serialized = serializeContext(ctx)

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' },
    }

    await continueSession(serialized, [mockPattern], 'second message')

    expect(statusWhenChainCalled).toBe('running')
  })
})
