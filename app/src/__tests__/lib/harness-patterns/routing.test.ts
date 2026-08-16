/**
 * Routing Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock server-only imports
vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn()
}))

// Mock BAML Router
const mockRouter = vi.fn()

vi.mock('../../../../baml_client', () => ({
  b: {
    Router: mockRouter
  }
}))

describe('routeMessageOp', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRouter.mockResolvedValue({
      intent: 'Test intent',
      needs_tool: true,
      route: 'neo4j',
      response: ''
    })
  })

  it('should export routeMessageOp function', async () => {
    const { routeMessageOp } = await import('../../../lib/harness-patterns/routing.server')
    expect(routeMessageOp).toBeDefined()
    expect(typeof routeMessageOp).toBe('function')
  })

  it('should call Router with message and history', async () => {
    const { routeMessageOp } = await import('../../../lib/harness-patterns/routing.server')

    await routeMessageOp('test message', [])

    expect(mockRouter).toHaveBeenCalled()
    const [message] = mockRouter.mock.calls[0]
    expect(message).toBe('test message')
  })

  it('should return parsed routing result', async () => {
    const { routeMessageOp } = await import('../../../lib/harness-patterns/routing.server')

    const result = await routeMessageOp('query the database', [])

    expect(result.intent).toBe('Test intent')
    expect(result.tool_call_needed).toBe(true)
    expect(result.tool_name).toBe('neo4j')
  })

  it('should handle neo4j route', async () => {
    mockRouter.mockResolvedValue({
      intent: 'Database query',
      needs_tool: true,
      route: 'neo4j',
      response: ''
    })

    const { routeMessageOp } = await import('../../../lib/harness-patterns/routing.server')
    const result = await routeMessageOp('query db', [])

    expect(result.tool_name).toBe('neo4j')
  })

  it('should handle web_search route', async () => {
    mockRouter.mockResolvedValue({
      intent: 'Web search',
      needs_tool: true,
      route: 'web_search',
      response: ''
    })

    const { routeMessageOp } = await import('../../../lib/harness-patterns/routing.server')
    const result = await routeMessageOp('search the web', [])

    expect(result.tool_name).toBe('web_search')
  })

  it('should handle code_mode route', async () => {
    mockRouter.mockResolvedValue({
      intent: 'Code execution',
      needs_tool: true,
      route: 'code_mode',
      response: ''
    })

    const { routeMessageOp } = await import('../../../lib/harness-patterns/routing.server')
    const result = await routeMessageOp('run script', [])

    expect(result.tool_name).toBe('code_mode')
  })

  it('should handle null route when no tool needed', async () => {
    mockRouter.mockResolvedValue({
      intent: 'Simple greeting',
      needs_tool: false,
      route: null,
      response: 'Hello!'
    })

    const { routeMessageOp } = await import('../../../lib/harness-patterns/routing.server')
    const result = await routeMessageOp('hello', [])

    expect(result.tool_call_needed).toBe(false)
    expect(result.tool_name).toBe(null)
    expect(result.response_text).toBe('Hello!')
  })

  it('should pass conversation history', async () => {
    const { routeMessageOp } = await import('../../../lib/harness-patterns/routing.server')

    const history = [
      { role: 'user', content: 'previous message' },
      { role: 'assistant', content: 'previous response' }
    ]

    await routeMessageOp('new message', history)

    const [, , historyArg] = mockRouter.mock.calls[0]
    expect(historyArg).toEqual(history)
  })

  it('should use default routes when not specified', async () => {
    const { routeMessageOp } = await import('../../../lib/harness-patterns/routing.server')

    await routeMessageOp('test', [])

    const [, routes] = mockRouter.mock.calls[0]
    expect(routes).toHaveLength(3)
    expect(routes.map((r: { name: string }) => r.name)).toContain('neo4j')
    expect(routes.map((r: { name: string }) => r.name)).toContain('web_search')
    expect(routes.map((r: { name: string }) => r.name)).toContain('code_mode')
  })

  it('should accept custom routes', async () => {
    const { routeMessageOp } = await import('../../../lib/harness-patterns/routing.server')

    const customRoutes = [
      { name: 'custom1', description: 'Custom route 1' },
      { name: 'custom2', description: 'Custom route 2' }
    ]

    await routeMessageOp('test', [], customRoutes)

    const [, routes] = mockRouter.mock.calls[0]
    expect(routes).toEqual(customRoutes)
  })
})
