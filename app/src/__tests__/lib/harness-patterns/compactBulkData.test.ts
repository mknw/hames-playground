/**
 * compactBulkData Tests
 *
 * Tests for compactBulkData — background tool result summarization.
 * A lone result takes the single-item `ResultDescribe` path; two or more are
 * folded into `ResultDescribeBatch` calls whose response is split back by the
 * echoed per-item id, with a per-item fallback for whatever the batch misses.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { UnifiedContext, ContextEvent } from '../../../lib/harness-patterns/types'

// Mock server-only imports
vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn()
}))

// Mock both describe ops — the single-item call and its batched twin
const mockDescribe = vi.fn()
const mockDescribeBatch = vi.fn()
vi.mock('../../../lib/harness-patterns/baml-adapters.server', () => ({
  describeToolResultOp: (...args: unknown[]) => mockDescribe(...args),
  describeToolResultsBatchOp: (...args: unknown[]) => mockDescribeBatch(...args),
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

/** A tool_result event, ready to be summarized. */
function toolResult(n: number, tool = 'search'): ContextEvent {
  return {
    type: 'tool_result',
    ts: n + 1,
    patternId: 'p1',
    id: `ev-r${n}`,
    data: { callId: `tc-${n}`, tool, result: `result ${n}`, success: true },
  }
}

/** The batch op's return shape: item id → summary. */
function summaries(entries: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(entries))
}

describe('compactBulkData', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDescribe.mockResolvedValue('Test summary')
    mockDescribeBatch.mockResolvedValue(new Map())
  })

  it('should summarize tool_result events from the current turn', async () => {
    const { compactBulkData } = await import('../../../lib/harness-patterns/compactBulkData.server')

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      { type: 'controller_action', ts: 2, patternId: 'p1', data: { action: { reasoning: 'Need to search', tool_name: 'search', tool_args: '{}', status: 'success', is_final: false } } },
      { type: 'tool_call', ts: 3, patternId: 'p1', data: { callId: 'tc-1', tool: 'search', args: { q: 'test' } } },
      { type: 'tool_result', ts: 4, patternId: 'p1', id: 'ev-r1', data: { callId: 'tc-1', tool: 'search', result: 'Found 5 results', success: true } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    await compactBulkData(ctx, onPersist)

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
    const { compactBulkData } = await import('../../../lib/harness-patterns/compactBulkData.server')

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      { type: 'tool_result', ts: 2, patternId: 'p1', id: 'ev-r1', data: { tool: 'search', result: 'data', success: true, hidden: true } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    await compactBulkData(ctx, onPersist)

    expect(mockDescribe).not.toHaveBeenCalled()
    expect(onPersist).toHaveBeenCalledOnce()
  })

  it('should skip archived tool_result events', async () => {
    const { compactBulkData } = await import('../../../lib/harness-patterns/compactBulkData.server')

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      { type: 'tool_result', ts: 2, patternId: 'p1', id: 'ev-r1', data: { tool: 'search', result: 'data', success: true, archived: true } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    await compactBulkData(ctx, onPersist)

    expect(mockDescribe).not.toHaveBeenCalled()
  })

  it('should skip events that already have a summary', async () => {
    const { compactBulkData } = await import('../../../lib/harness-patterns/compactBulkData.server')

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      { type: 'tool_result', ts: 2, patternId: 'p1', id: 'ev-r1', data: { tool: 'search', result: 'data', success: true, summary: 'Already summarized' } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    await compactBulkData(ctx, onPersist)

    expect(mockDescribe).not.toHaveBeenCalled()
  })

  it('should skip failed (success: false) tool_result events', async () => {
    const { compactBulkData } = await import('../../../lib/harness-patterns/compactBulkData.server')

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      { type: 'tool_result', ts: 2, patternId: 'p1', id: 'ev-r1', data: { tool: 'search', result: null, success: false, error: 'Connection failed' } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    await compactBulkData(ctx, onPersist)

    expect(mockDescribe).not.toHaveBeenCalled()
  })

  it('should skip tool_result events without an id', async () => {
    const { compactBulkData } = await import('../../../lib/harness-patterns/compactBulkData.server')

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      { type: 'tool_result', ts: 2, patternId: 'p1', data: { tool: 'search', result: 'data', success: true } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    await compactBulkData(ctx, onPersist)

    expect(mockDescribe).not.toHaveBeenCalled()
  })

  it('should fold multiple tool_results into ONE batched call', async () => {
    const { compactBulkData } = await import('../../../lib/harness-patterns/compactBulkData.server')

    mockDescribeBatch.mockResolvedValue(
      summaries({ '1': 'Summary for search', '2': 'Summary for fetch' }),
    )

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      { type: 'tool_result', ts: 2, patternId: 'p1', id: 'ev-r1', data: { callId: 'tc-1', tool: 'search', result: 'search data', success: true } },
      { type: 'tool_result', ts: 3, patternId: 'p1', id: 'ev-r2', data: { callId: 'tc-2', tool: 'fetch', result: 'fetched page', success: true } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    await compactBulkData(ctx, onPersist)

    // One batched call, no per-item calls at all
    expect(mockDescribeBatch).toHaveBeenCalledOnce()
    expect(mockDescribe).not.toHaveBeenCalled()

    const batch = mockDescribeBatch.mock.calls[0][0] as Array<Record<string, string>>
    expect(batch.map((i) => i.id)).toEqual(['1', '2'])
    expect(batch.map((i) => i.tool)).toEqual(['search', 'fetch'])
    expect(batch[0].toolArgs).toBe('{}')

    // Split back by echoed id, not by list position
    expect((events[1].data as { summary?: string }).summary).toBe('Summary for search')
    expect((events[2].data as { summary?: string }).summary).toBe('Summary for fetch')
  })

  it('should attach batched summaries by id even when the model reorders them', async () => {
    const { compactBulkData } = await import('../../../lib/harness-patterns/compactBulkData.server')

    // Deliberately reversed relative to the request order
    mockDescribeBatch.mockResolvedValue(summaries({ '2': 'second', '1': 'first' }))

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      toolResult(1),
      toolResult(2, 'fetch'),
    ]

    const ctx = createTestContext(events)
    await compactBulkData(ctx, vi.fn().mockResolvedValue(undefined))

    expect((events[1].data as { summary?: string }).summary).toBe('first')
    expect((events[2].data as { summary?: string }).summary).toBe('second')
  })

  it('should fall back per item for the ids a batch left unanswered', async () => {
    const { compactBulkData } = await import('../../../lib/harness-patterns/compactBulkData.server')

    // Item 2 is missing from the batch response
    mockDescribeBatch.mockResolvedValue(summaries({ '1': 'batched one', '3': 'batched three' }))
    mockDescribe.mockResolvedValue('fallback two')

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      toolResult(1),
      toolResult(2, 'fetch'),
      toolResult(3, 'read'),
    ]

    const ctx = createTestContext(events)
    await compactBulkData(ctx, vi.fn().mockResolvedValue(undefined))

    // Exactly ONE repair call, for the missing item only
    expect(mockDescribeBatch).toHaveBeenCalledOnce()
    expect(mockDescribe).toHaveBeenCalledOnce()
    expect(mockDescribe.mock.calls[0][0]).toBe('fetch')

    expect((events[1].data as { summary?: string }).summary).toBe('batched one')
    expect((events[2].data as { summary?: string }).summary).toBe('fallback two')
    expect((events[3].data as { summary?: string }).summary).toBe('batched three')
  })

  it('should fall back per item when the whole batch comes back empty', async () => {
    const { compactBulkData } = await import('../../../lib/harness-patterns/compactBulkData.server')

    // describeToolResultsBatchOp swallows its own failures and returns an empty map
    mockDescribeBatch.mockResolvedValue(new Map())
    mockDescribe.mockResolvedValue('per-item summary')

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      toolResult(1),
      toolResult(2, 'fetch'),
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)
    await compactBulkData(ctx, onPersist)

    expect(mockDescribe).toHaveBeenCalledTimes(2)
    expect((events[1].data as { summary?: string }).summary).toBe('per-item summary')
    expect((events[2].data as { summary?: string }).summary).toBe('per-item summary')
    expect(onPersist).toHaveBeenCalledOnce()
  })

  it('should survive the batch op itself rejecting', async () => {
    const { compactBulkData } = await import('../../../lib/harness-patterns/compactBulkData.server')

    mockDescribeBatch.mockRejectedValue(new Error('Model unavailable'))

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      toolResult(1),
      toolResult(2, 'fetch'),
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    // Must not throw, and must still persist whatever was gathered
    await compactBulkData(ctx, onPersist)

    expect((events[1].data as { summary?: string }).summary).toBeUndefined()
    expect((events[2].data as { summary?: string }).summary).toBeUndefined()
    expect(onPersist).toHaveBeenCalledOnce()
  })

  it('should split more than MAX_BATCH_ITEMS results across several batches', async () => {
    const { compactBulkData, MAX_BATCH_ITEMS } = await import(
      '../../../lib/harness-patterns/compactBulkData.server'
    )

    const total = MAX_BATCH_ITEMS + 2
    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      ...Array.from({ length: total }, (_, i) => toolResult(i + 1)),
    ]

    // Answer every id in whichever batch it arrives in
    mockDescribeBatch.mockImplementation(async (items: Array<{ id: string }>) =>
      new Map(items.map((i) => [i.id, `summary ${i.id}`])),
    )

    const ctx = createTestContext(events)
    await compactBulkData(ctx, vi.fn().mockResolvedValue(undefined))

    expect(mockDescribeBatch).toHaveBeenCalledTimes(2)
    const sizes = mockDescribeBatch.mock.calls.map((c) => (c[0] as unknown[]).length)
    expect(sizes).toEqual([MAX_BATCH_ITEMS, 2])
    expect(mockDescribe).not.toHaveBeenCalled()

    // Ids are batch-local labels but unique across the turn, so every event got its own
    for (let i = 1; i <= total; i++) {
      expect((events[i].data as { summary?: string }).summary).toBe(`summary ${i}`)
    }
  })

  it('should use the single-item path for a lone result, never the batch', async () => {
    const { compactBulkData } = await import('../../../lib/harness-patterns/compactBulkData.server')

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      toolResult(1),
    ]

    const ctx = createTestContext(events)
    await compactBulkData(ctx, vi.fn().mockResolvedValue(undefined))

    expect(mockDescribeBatch).not.toHaveBeenCalled()
    expect(mockDescribe).toHaveBeenCalledOnce()
  })

  it('should not batch results that already have a summary', async () => {
    const { compactBulkData } = await import('../../../lib/harness-patterns/compactBulkData.server')

    const alreadyDone = toolResult(1)
    ;(alreadyDone.data as { summary?: string }).summary = 'Already summarized'

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      alreadyDone,
      toolResult(2, 'fetch'),
    ]

    const ctx = createTestContext(events)
    await compactBulkData(ctx, vi.fn().mockResolvedValue(undefined))

    // One target left → single-item path, and the done one is untouched
    expect(mockDescribeBatch).not.toHaveBeenCalled()
    expect(mockDescribe).toHaveBeenCalledOnce()
    expect(mockDescribe.mock.calls[0][0]).toBe('fetch')
    expect((events[1].data as { summary?: string }).summary).toBe('Already summarized')
  })

  it('should truncate long results before sending to summarizer', async () => {
    const { compactBulkData } = await import('../../../lib/harness-patterns/compactBulkData.server')

    const longResult = 'x'.repeat(5000)
    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      { type: 'tool_result', ts: 2, patternId: 'p1', id: 'ev-r1', data: { tool: 'search', result: longResult, success: true } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    await compactBulkData(ctx, onPersist)

    expect(mockDescribe).toHaveBeenCalledOnce()
    // The 4th arg (result) should be truncated
    const passedResult = mockDescribe.mock.calls[0][3] as string
    expect(passedResult.length).toBeLessThan(longResult.length)
    expect(passedResult).toContain('...[truncated]')
  })

  it('should handle describeToolResultOp returning empty string gracefully', async () => {
    const { compactBulkData } = await import('../../../lib/harness-patterns/compactBulkData.server')

    mockDescribe.mockResolvedValue('')

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      { type: 'tool_result', ts: 2, patternId: 'p1', id: 'ev-r1', data: { tool: 'search', result: 'data', success: true } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    await compactBulkData(ctx, onPersist)

    // Empty string should not be stored as summary
    expect((events[1].data as { summary?: string }).summary).toBeUndefined()
    expect(onPersist).toHaveBeenCalledOnce()
  })

  it('should handle describeToolResultOp rejection gracefully', async () => {
    const { compactBulkData } = await import('../../../lib/harness-patterns/compactBulkData.server')

    mockDescribe.mockRejectedValue(new Error('Model unavailable'))

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      { type: 'tool_result', ts: 2, patternId: 'p1', id: 'ev-r1', data: { tool: 'search', result: 'data', success: true } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    // Should not throw — Promise.allSettled handles rejections
    await compactBulkData(ctx, onPersist)

    // Summary should not be set
    expect((events[1].data as { summary?: string }).summary).toBeUndefined()
    // onPersist should still be called
    expect(onPersist).toHaveBeenCalledOnce()
  })

  it('should do nothing when there are no tool_results in current turn', async () => {
    const { compactBulkData } = await import('../../../lib/harness-patterns/compactBulkData.server')

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'just a chat' } },
      { type: 'assistant_message', ts: 2, patternId: 'harness', data: { content: 'hello' } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    await compactBulkData(ctx, onPersist)

    expect(mockDescribe).not.toHaveBeenCalled()
    // onPersist should NOT be called when there's nothing to summarize
    expect(onPersist).not.toHaveBeenCalled()
  })

  it('should only summarize current turn results, not prior turn results', async () => {
    const { compactBulkData } = await import('../../../lib/harness-patterns/compactBulkData.server')

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

    await compactBulkData(ctx, onPersist)

    // Should only be called for ev-new (current turn)
    expect(mockDescribe).toHaveBeenCalledOnce()
    expect(mockDescribe.mock.calls[0][0]).toBe('fetch')
  })

  it('should find controller_action reasoning for context', async () => {
    const { compactBulkData } = await import('../../../lib/harness-patterns/compactBulkData.server')

    const events: ContextEvent[] = [
      { type: 'user_message', ts: 1, patternId: 'harness', data: { content: 'query' } },
      { type: 'controller_action', ts: 2, patternId: 'p1', data: { action: { reasoning: 'I need to query the graph for person nodes', tool_name: 'read_neo4j_cypher', tool_args: '{}', status: 'success', is_final: false } } },
      { type: 'tool_call', ts: 3, patternId: 'p1', data: { callId: 'tc-1', tool: 'read_neo4j_cypher', args: { query: 'MATCH (n:Person) RETURN n' } } },
      { type: 'tool_result', ts: 4, patternId: 'p1', id: 'ev-r1', data: { callId: 'tc-1', tool: 'read_neo4j_cypher', result: [{ name: 'Alice' }], success: true } },
    ]

    const ctx = createTestContext(events)
    const onPersist = vi.fn().mockResolvedValue(undefined)

    await compactBulkData(ctx, onPersist)

    // Reasoning should be passed as 3rd argument
    expect(mockDescribe.mock.calls[0][2]).toBe('I need to query the graph for person nodes')
  })
})
