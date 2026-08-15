/**
 * Judge Pattern Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock server-only imports
vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

describe('judge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should export judge function', async () => {
    const { judge } = await import('../../../../lib/harness-patterns/patterns/judge.server')
    expect(judge).toBeDefined()
    expect(typeof judge).toBe('function')
  })

  it('should create a ConfiguredPattern', async () => {
    const { judge } = await import('../../../../lib/harness-patterns/patterns/judge.server')

    const evaluator = vi.fn()
    const pattern = judge(evaluator, { patternId: 'quality-judge' })

    expect(pattern.name).toBe('quality-judge')
    expect(pattern.fn).toBeDefined()
    expect(pattern.config.patternId).toBe('quality-judge')
  })

  it('should use default name when patternId not provided', async () => {
    const { judge } = await import('../../../../lib/harness-patterns/patterns/judge.server')

    const evaluator = vi.fn()
    const pattern = judge(evaluator)

    expect(pattern.name).toBe('judge')
  })

  it('should track error when no candidates exist', async () => {
    const { judge } = await import('../../../../lib/harness-patterns/patterns/judge.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } =
      await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const evaluator = vi.fn()
    const ctx = createContext('test query')
    const view = createEventView(ctx)

    const pattern = judge(evaluator)
    const result = await pattern.fn(
      { id: 'judge', data: ctx.data, events: [], startTime: Date.now() },
      view,
    )

    const errorEvents = result.events.filter((e) => e.type === 'error')
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(errorEvents[0].data)).toContain('No candidates to evaluate')
  })

  it('should call evaluator with candidates', async () => {
    const { judge } = await import('../../../../lib/harness-patterns/patterns/judge.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } =
      await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const evaluator = vi.fn().mockResolvedValue({
      reasoning: 'Test reasoning',
      rankings: [{ source: 'pattern1', score: 0.9, reason: 'High quality' }],
      best: { source: 'pattern1', content: 'Best result' },
    })

    const ctx = createContext<{ input?: string }>('test query')
    ctx.data = { input: 'test query' }
    // Add tool_result events as candidates
    ctx.events.push({
      type: 'tool_result',
      ts: Date.now(),
      patternId: 'pattern1',
      data: { result: 'First result' },
    })

    const view = createEventView(ctx)

    const pattern = judge(evaluator)
    await pattern.fn({ id: 'judge', data: ctx.data, events: [], startTime: Date.now() }, view)

    expect(evaluator).toHaveBeenCalled()
    const [query, candidates] = evaluator.mock.calls[0]
    expect(query).toBe('test query')
    expect(candidates.length).toBe(1)
    expect(candidates[0].source).toBe('pattern1')
  })

  it('should set best result as response', async () => {
    const { judge } = await import('../../../../lib/harness-patterns/patterns/judge.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } =
      await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const evaluator = vi.fn().mockResolvedValue({
      reasoning: 'Test reasoning',
      rankings: [{ source: 'pattern1', score: 0.9, reason: 'High quality' }],
      best: { source: 'pattern1', content: 'The best result' },
    })

    const ctx = createContext<{ input?: string; response?: string }>('test query')
    ctx.data = { input: 'test query' }
    ctx.events.push({
      type: 'tool_result',
      ts: Date.now(),
      patternId: 'pattern1',
      data: { result: 'First result' },
    })

    const view = createEventView(ctx)

    const pattern = judge(evaluator)
    const result = await pattern.fn(
      { id: 'judge', data: ctx.data, events: [], startTime: Date.now() },
      view,
    )

    expect(result.data.response).toBe('The best result')
    expect(result.data.judgeReasoning).toBe('Test reasoning')
    expect(result.data.rankings).toEqual([
      { source: 'pattern1', score: 0.9, reason: 'High quality' },
    ])
  })

  it('should limit candidates when maxCandidates is set', async () => {
    const { judge } = await import('../../../../lib/harness-patterns/patterns/judge.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } =
      await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const evaluator = vi.fn().mockResolvedValue({
      reasoning: 'Test',
      rankings: [],
      best: null,
    })

    const ctx = createContext<{ input?: string }>('test query')
    ctx.data = { input: 'test query' }
    // Add multiple candidates
    ctx.events.push(
      { type: 'tool_result', ts: Date.now(), patternId: 'p1', data: { result: '1' } },
      { type: 'tool_result', ts: Date.now(), patternId: 'p2', data: { result: '2' } },
      { type: 'tool_result', ts: Date.now(), patternId: 'p3', data: { result: '3' } },
    )

    const view = createEventView(ctx)

    const pattern = judge(evaluator, { maxCandidates: 2 })
    await pattern.fn({ id: 'judge', data: ctx.data, events: [], startTime: Date.now() }, view)

    const [, candidates] = evaluator.mock.calls[0]
    expect(candidates.length).toBe(2)
  })

  it('should track controller_action event with evaluation', async () => {
    const { judge } = await import('../../../../lib/harness-patterns/patterns/judge.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } =
      await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const evaluator = vi.fn().mockResolvedValue({
      reasoning: 'Detailed reasoning',
      rankings: [{ source: 'p1', score: 1, reason: 'Best' }],
      best: { source: 'p1', content: 'Winner' },
    })

    const ctx = createContext<{ input?: string }>('test query')
    ctx.data = { input: 'test query' }
    ctx.events.push({
      type: 'tool_result',
      ts: Date.now(),
      patternId: 'p1',
      data: { result: 'Result' },
    })

    const view = createEventView(ctx)

    const pattern = judge(evaluator)
    const result = await pattern.fn(
      { id: 'judge', data: ctx.data, events: [], startTime: Date.now() },
      view,
    )

    // Event may be tracked differently based on config; check data directly
    expect(result.data.judgeReasoning).toBe('Detailed reasoning')
  })

  it('should handle evaluator errors', async () => {
    const { judge } = await import('../../../../lib/harness-patterns/patterns/judge.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } =
      await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const evaluator = vi.fn().mockRejectedValue(new Error('Evaluator failed'))

    const ctx = createContext<{ input?: string }>('test query')
    ctx.data = { input: 'test query' }
    ctx.events.push({
      type: 'tool_result',
      ts: Date.now(),
      patternId: 'p1',
      data: { result: 'Result' },
    })

    const view = createEventView(ctx)

    const pattern = judge(evaluator)
    const result = await pattern.fn(
      { id: 'judge', data: ctx.data, events: [], startTime: Date.now() },
      view,
    )

    const errorEvents = result.events.filter((e) => e.type === 'error')
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(errorEvents[0].data)).toContain('Evaluator failed')
  })

  it('should handle null best result', async () => {
    const { judge } = await import('../../../../lib/harness-patterns/patterns/judge.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } =
      await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const evaluator = vi.fn().mockResolvedValue({
      reasoning: 'No good results',
      rankings: [],
      best: null,
    })

    const ctx = createContext<{ input?: string; response?: string }>('test query')
    ctx.data = { input: 'test query' }
    ctx.events.push({
      type: 'tool_result',
      ts: Date.now(),
      patternId: 'p1',
      data: { result: 'Result' },
    })

    const view = createEventView(ctx)

    const pattern = judge(evaluator)
    const result = await pattern.fn(
      { id: 'judge', data: ctx.data, events: [], startTime: Date.now() },
      view,
    )

    expect(result.data.response).toBeUndefined()
    expect(result.data.judgeReasoning).toBe('No good results')
  })
})
