/**
 * Harness Tests
 *
 * Tests for harness(), resumeHarness(), and continueSession()
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock server-only imports
vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn()
}))

// Mock runChain to track calls
const mockChain = vi.fn()
vi.mock('../../../lib/harness-patterns/patterns/chain.server', () => ({
  runChain: mockChain,
  chain: vi.fn()
}))

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
    const { harness } = await import('../../../lib/harness-patterns/harness.server')
    expect(harness).toBeDefined()
    expect(typeof harness).toBe('function')
  })

  it('should create a callable agent function', async () => {
    const { harness } = await import('../../../lib/harness-patterns/harness.server')

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' }
    }

    const agent = harness(mockPattern)
    expect(typeof agent).toBe('function')
  })

  it('should execute patterns via chain', async () => {
    const { harness } = await import('../../../lib/harness-patterns/harness.server')

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' }
    }

    const agent = harness(mockPattern)
    await agent('test input')

    expect(mockChain).toHaveBeenCalled()
  })

  it('should return response from context data', async () => {
    const { harness } = await import('../../../lib/harness-patterns/harness.server')

    mockChain.mockImplementation(async (ctx) => {
      ctx.data.response = 'Hello world!'
      ctx.status = 'done'
      return ctx
    })

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' }
    }

    const agent = harness(mockPattern)
    const result = await agent('test input')

    expect(result.response).toBe('Hello world!')
    expect(result.status).toBe('done')
  })

  it('should include duration_ms in result', async () => {
    const { harness } = await import('../../../lib/harness-patterns/harness.server')

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' }
    }

    const agent = harness(mockPattern)
    const result = await agent('test input')

    expect(result.duration_ms).toBeDefined()
    expect(typeof result.duration_ms).toBe('number')
    expect(result.duration_ms).toBeGreaterThanOrEqual(0)
  })

  it('should include serialized context', async () => {
    const { harness } = await import('../../../lib/harness-patterns/harness.server')

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' }
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
    const { harness } = await import('../../../lib/harness-patterns/harness.server')

    mockChain.mockImplementation(async (ctx) => {
      ctx.data.response = 'Final response'
      ctx.status = 'done'
      return ctx
    })

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' }
    }

    const agent = harness(mockPattern)
    const result = await agent('test input')

    const assistantMessages = result.context.events.filter(e => e.type === 'assistant_message')
    expect(assistantMessages.length).toBeGreaterThan(0)
    expect((assistantMessages[0].data as { content: string }).content).toBe('Final response')
  })

  it('should handle errors gracefully', async () => {
    const { harness } = await import('../../../lib/harness-patterns/harness.server')

    mockChain.mockRejectedValue(new Error('Test error'))

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' }
    }

    const agent = harness(mockPattern)
    const result = await agent('test input')

    expect(result.status).toBe('error')
    expect(result.response).toContain('Error:')
    expect(result.response).toContain('Test error')
  })

  it('should accept sessionId parameter', async () => {
    const { harness } = await import('../../../lib/harness-patterns/harness.server')

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' }
    }

    const agent = harness(mockPattern)
    const result = await agent('test input', 'custom-session-id')

    expect(result.context.sessionId).toBe('custom-session-id')
  })

  it('should accept initialData parameter', async () => {
    const { harness } = await import('../../../lib/harness-patterns/harness.server')

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' }
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

  it('should export resumeHarness function', async () => {
    const { resumeHarness } = await import('../../../lib/harness-patterns/harness.server')
    expect(resumeHarness).toBeDefined()
    expect(typeof resumeHarness).toBe('function')
  })

  it('should throw if context is not paused', async () => {
    const { resumeHarness } = await import('../../../lib/harness-patterns/harness.server')
    const { serializeContext, createContext } = await import('../../../lib/harness-patterns/context.server')

    // Create a running context
    const ctx = createContext('test')
    ctx.status = 'running'
    const serialized = serializeContext(ctx)

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' }
    }

    await expect(resumeHarness(serialized, [mockPattern], true)).rejects.toThrow(
      'Cannot resume: context is not paused'
    )
  })

  it('should resume paused context with approval', async () => {
    const { resumeHarness } = await import('../../../lib/harness-patterns/harness.server')
    const { serializeContext, createContext } = await import('../../../lib/harness-patterns/context.server')

    // Create a paused context
    const ctx = createContext<{ approved?: boolean; response?: string }>('test')
    ctx.status = 'paused'
    const serialized = serializeContext(ctx)

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' }
    }

    const result = await resumeHarness(serialized, [mockPattern], true)

    expect(result.data.approved).toBe(true)
    expect(mockChain).toHaveBeenCalled()
  })

  it('should add approval_response event', async () => {
    const { resumeHarness } = await import('../../../lib/harness-patterns/harness.server')
    const { serializeContext, createContext } = await import('../../../lib/harness-patterns/context.server')

    const ctx = createContext<{ approved?: boolean; response?: string }>('test')
    ctx.status = 'paused'
    const serialized = serializeContext(ctx)

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' }
    }

    const result = await resumeHarness(serialized, [mockPattern], false)

    const approvalEvents = result.context.events.filter(e => e.type === 'approval_response')
    expect(approvalEvents.length).toBeGreaterThan(0)
    expect((approvalEvents[0].data as { approved: boolean }).approved).toBe(false)
  })

  it('should handle errors during resume', async () => {
    const { resumeHarness } = await import('../../../lib/harness-patterns/harness.server')
    const { serializeContext, createContext } = await import('../../../lib/harness-patterns/context.server')

    mockChain.mockRejectedValue(new Error('Resume error'))

    const ctx = createContext<{ approved?: boolean; response?: string }>('test')
    ctx.status = 'paused'
    const serialized = serializeContext(ctx)

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' }
    }

    const result = await resumeHarness(serialized, [mockPattern], true)

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
    const { continueSession } = await import('../../../lib/harness-patterns/harness.server')
    expect(continueSession).toBeDefined()
    expect(typeof continueSession).toBe('function')
  })

  it('should continue session with new input', async () => {
    const { continueSession } = await import('../../../lib/harness-patterns/harness.server')
    const { serializeContext, createContext } = await import('../../../lib/harness-patterns/context.server')

    const ctx = createContext<{ response?: string }>('first message')
    ctx.status = 'done'
    const serialized = serializeContext(ctx)

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' }
    }

    const result = await continueSession(serialized, [mockPattern], 'second message')

    expect(result.context.input).toBe('second message')
    expect(mockChain).toHaveBeenCalled()
  })

  it('should add user_message event for new input', async () => {
    const { continueSession } = await import('../../../lib/harness-patterns/harness.server')
    const { serializeContext, createContext } = await import('../../../lib/harness-patterns/context.server')

    const ctx = createContext<{ response?: string }>('first message')
    ctx.status = 'done'
    const serialized = serializeContext(ctx)

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' }
    }

    const result = await continueSession(serialized, [mockPattern], 'follow up')

    const userMessages = result.context.events.filter(e => e.type === 'user_message')
    const followUpMessage = userMessages.find(
      e => (e.data as { content: string }).content === 'follow up'
    )
    expect(followUpMessage).toBeDefined()
  })

  it('should handle errors during continue', async () => {
    const { continueSession } = await import('../../../lib/harness-patterns/harness.server')
    const { serializeContext, createContext } = await import('../../../lib/harness-patterns/context.server')

    mockChain.mockRejectedValue(new Error('Continue error'))

    const ctx = createContext<{ response?: string }>('first message')
    ctx.status = 'done'
    const serialized = serializeContext(ctx)

    const mockPattern = {
      name: 'test',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'test' }
    }

    const result = await continueSession(serialized, [mockPattern], 'second message')

    expect(result.status).toBe('error')
    expect(result.response).toContain('Continue error')
  })

  it('should reset status to running before executing', async () => {
    const { continueSession } = await import('../../../lib/harness-patterns/harness.server')
    const { serializeContext, createContext } = await import('../../../lib/harness-patterns/context.server')

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
      config: { patternId: 'test' }
    }

    await continueSession(serialized, [mockPattern], 'second message')

    expect(statusWhenChainCalled).toBe('running')
  })
})
