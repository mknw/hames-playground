/**
 * Summarize Server Tests
 *
 * Tests for scheduleSummarization — background tool result summarization.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { UnifiedContext, ContextEvent } from '../../../lib/harness-patterns/types'

// Mock server-only imports
vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn()
}))

// Mock describeToolResultOp
const mockDescribe = vi.fn()
vi.mock('../../../lib/harness-patterns/baml-adapters.server', () => ({
  describeToolResultOp: (...args: unknown[]) => mockDescribe(...args)
}))

function createTestContext(events: ContextEvent[]): UnifiedContext {
  return {
    sessionId: 'test-session',
    createdAt: Date.now(),
    input: 'test input',
    status: 'done',
    events,
    data: {}
  }
}

describe('scheduleSummarization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDescribe.mockResolvedValue('Test summary')
  })

  it('should summarize tool_result events from the current turn', async () => {
    const { scheduleSummarization } = await import('../../../lib/harness-patterns/summarize.server')

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      { type: 'controller_action', ts: 2, patternId: 'p1', data: { action: { reasoning: 'Need to search', tool_name: 'search', tool_args: '{}', status: 'success', is_final: false } } },
      { type: 'tool_call', ts: 3, patternId: 'p1', data: { callId: 'tc-1', tool: 'search', args: { q: 'test' } } },
      { type: 'tool_result', ts: 4, patternId: 'p1', id: 'ev-r1', data: { callId: 'tc-1', tool: 'search', result: 'Found 5 results', success: true } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    await scheduleSummarization(ctx, onPersist)

    expect(mockDescribe).toHaveBeenCalledOnce()
    expect(mockDescribe).toHaveBeenCalledWith(
      'search',
      JSON.stringify({ q: 'test' }),
      'Need to search',
      'Found 5 results'
    )

    // Should have enriched the event
    const data = events[3].data as { summary?: string }
    expect(data.summary).toBe('Test summary')

    // Should have called onPersist
    expect(onPersist).toHaveBeenCalledOnce()
  })

  it('should skip hidden tool_result events', async () => {
    const { scheduleSummarization } = await import('../../../lib/harness-patterns/summarize.server')

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      { type: 'tool_result', ts: 2, patternId: 'p1', id: 'ev-r1', data: { tool: 'search', result: 'data', success: true, hidden: true } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    await scheduleSummarization(ctx, onPersist)

    expect(mockDescribe).not.toHaveBeenCalled()
    expect(onPersist).toHaveBeenCalledOnce()
  })

  it('should skip archived tool_result events', async () => {
    const { scheduleSummarization } = await import('../../../lib/harness-patterns/summarize.server')

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      { type: 'tool_result', ts: 2, patternId: 'p1', id: 'ev-r1', data: { tool: 'search', result: 'data', success: true, archived: true } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    await scheduleSummarization(ctx, onPersist)

    expect(mockDescribe).not.toHaveBeenCalled()
  })

  it('should skip events that already have a summary', async () => {
    const { scheduleSummarization } = await import('../../../lib/harness-patterns/summarize.server')

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      { type: 'tool_result', ts: 2, patternId: 'p1', id: 'ev-r1', data: { tool: 'search', result: 'data', success: true, summary: 'Already summarized' } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    await scheduleSummarization(ctx, onPersist)

    expect(mockDescribe).not.toHaveBeenCalled()
  })

  it('should skip failed (success: false) tool_result events', async () => {
    const { scheduleSummarization } = await import('../../../lib/harness-patterns/summarize.server')

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      { type: 'tool_result', ts: 2, patternId: 'p1', id: 'ev-r1', data: { tool: 'search', result: null, success: false, error: 'Connection failed' } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    await scheduleSummarization(ctx, onPersist)

    expect(mockDescribe).not.toHaveBeenCalled()
  })

  it('should skip tool_result events without an id', async () => {
    const { scheduleSummarization } = await import('../../../lib/harness-patterns/summarize.server')

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      { type: 'tool_result', ts: 2, patternId: 'p1', data: { tool: 'search', result: 'data', success: true } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    await scheduleSummarization(ctx, onPersist)

    expect(mockDescribe).not.toHaveBeenCalled()
  })

  it('should summarize multiple tool_results in parallel', async () => {
    const { scheduleSummarization } = await import('../../../lib/harness-patterns/summarize.server')

    mockDescribe
      .mockResolvedValueOnce('Summary for search')
      .mockResolvedValueOnce('Summary for fetch')

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      { type: 'tool_result', ts: 2, patternId: 'p1', id: 'ev-r1', data: { callId: 'tc-1', tool: 'search', result: 'search data', success: true } },
      { type: 'tool_result', ts: 3, patternId: 'p1', id: 'ev-r2', data: { callId: 'tc-2', tool: 'fetch', result: 'fetched page', success: true } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    await scheduleSummarization(ctx, onPersist)

    expect(mockDescribe).toHaveBeenCalledTimes(2)
    expect((events[1].data as { summary?: string }).summary).toBe('Summary for search')
    expect((events[2].data as { summary?: string }).summary).toBe('Summary for fetch')
  })

  it('should truncate long results before sending to summarizer', async () => {
    const { scheduleSummarization } = await import('../../../lib/harness-patterns/summarize.server')

    const longResult = 'x'.repeat(5000)
    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      { type: 'tool_result', ts: 2, patternId: 'p1', id: 'ev-r1', data: { tool: 'search', result: longResult, success: true } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    await scheduleSummarization(ctx, onPersist)

    expect(mockDescribe).toHaveBeenCalledOnce()
    // The 4th arg (result) should be truncated
    const passedResult = mockDescribe.mock.calls[0][3] as string
    expect(passedResult.length).toBeLessThan(longResult.length)
    expect(passedResult).toContain('...[truncated]')
  })

  it('should handle describeToolResultOp returning empty string gracefully', async () => {
    const { scheduleSummarization } = await import('../../../lib/harness-patterns/summarize.server')

    mockDescribe.mockResolvedValue('')

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      { type: 'tool_result', ts: 2, patternId: 'p1', id: 'ev-r1', data: { tool: 'search', result: 'data', success: true } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    await scheduleSummarization(ctx, onPersist)

    // Empty string should not be stored as summary
    expect((events[1].data as { summary?: string }).summary).toBeUndefined()
    expect(onPersist).toHaveBeenCalledOnce()
  })

  it('should handle describeToolResultOp rejection gracefully', async () => {
    const { scheduleSummarization } = await import('../../../lib/harness-patterns/summarize.server')

    mockDescribe.mockRejectedValue(new Error('Model unavailable'))

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      { type: 'tool_result', ts: 2, patternId: 'p1', id: 'ev-r1', data: { tool: 'search', result: 'data', success: true } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    // Should not throw — Promise.allSettled handles rejections
    await scheduleSummarization(ctx, onPersist)

    // Summary should not be set
    expect((events[1].data as { summary?: string }).summary).toBeUndefined()
    // onPersist should still be called
    expect(onPersist).toHaveBeenCalledOnce()
  })

  it('should do nothing when there are no tool_results in current turn', async () => {
    const { scheduleSummarization } = await import('../../../lib/harness-patterns/summarize.server')

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'just a chat' } },
      { type: 'assistant_message', ts: 2, patternId: 'harness', data: { content: 'hello' } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    await scheduleSummarization(ctx, onPersist)

    expect(mockDescribe).not.toHaveBeenCalled()
    // onPersist should NOT be called when there's nothing to summarize
    expect(onPersist).not.toHaveBeenCalled()
  })

  it('should only summarize current turn results, not prior turn results', async () => {
    const { scheduleSummarization } = await import('../../../lib/harness-patterns/summarize.server')

    const events: ContextEvent[] = [
      // Turn 1
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'first query' } },
      { type: 'tool_result', ts: 2, patternId: 'p1', id: 'ev-old', data: { tool: 'search', result: 'old data', success: true, summary: 'Already done' } },
      // Turn 2 (current)
      { type: 'user_message', ts: 3, patternId: 'harness', data: { content: 'second query' } },
      { type: 'tool_result', ts: 4, patternId: 'p1', id: 'ev-new', data: { tool: 'fetch', result: 'new data', success: true } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    await scheduleSummarization(ctx, onPersist)

    // Should only be called for ev-new (current turn)
    expect(mockDescribe).toHaveBeenCalledOnce()
    expect(mockDescribe.mock.calls[0][0]).toBe('fetch')
  })

  it('should find controller_action reasoning for context', async () => {
    const { scheduleSummarization } = await import('../../../lib/harness-patterns/summarize.server')

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      { type: 'controller_action', ts: 2, patternId: 'p1', data: { action: { reasoning: 'I need to query the graph for person nodes', tool_name: 'read_neo4j_cypher', tool_args: '{}', status: 'success', is_final: false } } },
      { type: 'tool_call', ts: 3, patternId: 'p1', data: { callId: 'tc-1', tool: 'read_neo4j_cypher', args: { query: 'MATCH (n:Person) RETURN n' } } },
      { type: 'tool_result', ts: 4, patternId: 'p1', id: 'ev-r1', data: { callId: 'tc-1', tool: 'read_neo4j_cypher', result: [{ name: 'Alice' }], success: true } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    await scheduleSummarization(ctx, onPersist)

    // Reasoning should be passed as 3rd argument
    expect(mockDescribe.mock.calls[0][2]).toBe('I need to query the graph for person nodes')
  })
})
