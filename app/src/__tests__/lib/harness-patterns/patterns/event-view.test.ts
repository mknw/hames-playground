/**
 * EventView Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { UnifiedContext, ContextEvent } from '../../../../lib/harness-patterns/types'

// Mock server-only imports
vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn()
}))

// Helper to create mock context
function createMockContext(events: ContextEvent[] = []): UnifiedContext {
  return {
    sessionId: 'test-session',
    createdAt: Date.now(),
    input: 'test input',
    status: 'running',
    events,
    data: {}
  }
}

describe('EventViewImpl', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('should export createEventView function', async () => {
    const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')
    expect(createEventView).toBeDefined()
    expect(typeof createEventView).toBe('function')
  })

  it('should create an EventView instance', async () => {
    const { createEventView, EventViewImpl } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const ctx = createMockContext()
    const view = createEventView(ctx)

    expect(view).toBeInstanceOf(EventViewImpl)
  })

  describe('get()', () => {
    it('should return all events with no filters', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'user_message', ts: 1, patternId: 'p1', data: { content: 'hi' } },
        { type: 'tool_call', ts: 2, patternId: 'p1', data: { tool: 'test' } }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.get()
      expect(result).toHaveLength(2)
    })
  })

  describe('fromPattern()', () => {
    it('should filter events by pattern ID', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'tool_call', ts: 1, patternId: 'pattern-a', data: { tool: 'a' } },
        { type: 'tool_call', ts: 2, patternId: 'pattern-b', data: { tool: 'b' } },
        { type: 'tool_call', ts: 3, patternId: 'pattern-a', data: { tool: 'a2' } }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.fromPattern('pattern-a').get()
      expect(result).toHaveLength(2)
      expect(result.every(e => e.patternId === 'pattern-a')).toBe(true)
    })
  })

  describe('fromPatterns()', () => {
    it('should filter events by multiple pattern IDs', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'tool_call', ts: 1, patternId: 'p1', data: {} },
        { type: 'tool_call', ts: 2, patternId: 'p2', data: {} },
        { type: 'tool_call', ts: 3, patternId: 'p3', data: {} }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.fromPatterns(['p1', 'p3']).get()
      expect(result).toHaveLength(2)
      expect(result.map(e => e.patternId)).toEqual(['p1', 'p3'])
    })
  })

  describe('fromLastPattern()', () => {
    it('should filter events from the last pattern', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'pattern_enter', ts: 1, patternId: 'first', data: {} },
        { type: 'tool_call', ts: 2, patternId: 'first', data: { tool: 'a' } },
        { type: 'pattern_exit', ts: 3, patternId: 'first', data: {} },
        { type: 'pattern_enter', ts: 4, patternId: 'second', data: {} },
        { type: 'tool_call', ts: 5, patternId: 'second', data: { tool: 'b' } }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.fromLastPattern().get()
      expect(result.every(e => e.patternId === 'second')).toBe(true)
    })

    it('should return empty when no patterns exist', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const ctx = createMockContext([])
      const view = createEventView(ctx)

      const result = view.fromLastPattern().get()
      expect(result).toHaveLength(0)
    })

    it('should resolve to the most-recently-active pattern across multi-turn sessions', async () => {
      // Regression test for: in a 4-turn session where web-search ran in turn 3
      // and neo4j-query ran in turn 4, fromLastPattern() must resolve to
      // neo4j-query (last *activated*), not web-search (last *introduced*).
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        // Turn 2: neo4j-query first appears
        { type: 'pattern_enter', ts: 10, patternId: 'neo4j-query', data: {} },
        { type: 'tool_result', ts: 11, patternId: 'neo4j-query', data: { tool: 'read_neo4j_cypher', result: 'turn2-data', success: true } },
        { type: 'pattern_exit', ts: 12, patternId: 'neo4j-query', data: {} },
        { type: 'pattern_enter', ts: 13, patternId: 'response-synth', data: {} },
        { type: 'pattern_exit', ts: 14, patternId: 'response-synth', data: {} },
        // Turn 3: web-search first appears (LATER first-appearance than neo4j-query)
        { type: 'pattern_enter', ts: 20, patternId: 'web-search', data: {} },
        { type: 'tool_result', ts: 21, patternId: 'web-search', data: { tool: 'search', result: 'turn3-web-data', success: true } },
        { type: 'pattern_exit', ts: 22, patternId: 'web-search', data: {} },
        { type: 'pattern_enter', ts: 23, patternId: 'response-synth', data: {} },
        { type: 'pattern_exit', ts: 24, patternId: 'response-synth', data: {} },
        // Turn 4: neo4j-query runs again (most recent ACTIVATION)
        { type: 'pattern_enter', ts: 30, patternId: 'neo4j-query', data: {} },
        { type: 'tool_result', ts: 31, patternId: 'neo4j-query', data: { tool: 'read_neo4j_cypher', result: 'turn4-data', success: true } },
        { type: 'pattern_exit', ts: 32, patternId: 'neo4j-query', data: {} },
        // Synthesizer about to evaluate fromLastPattern()
        { type: 'pattern_enter', ts: 33, patternId: 'response-synth', data: {} },
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx, undefined, 'response-synth')
      const result = view.fromLastPattern().get()

      // Must resolve to turn-4 neo4j-query, not turn-3 web-search
      expect(result.every(e => e.patternId === 'neo4j-query')).toBe(true)
      const toolResult = result.find(e => e.type === 'tool_result')
      expect(toolResult).toBeDefined()
      expect((toolResult!.data as Record<string, unknown>).result).toBe('turn4-data')
      // Must NOT include web-search events
      expect(result.find(e => e.patternId === 'web-search')).toBeUndefined()
    })

    it('should only return events from the last execution when a pattern runs multiple times', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      // Simulates two user turns both routing to the same 'neo4j-query' pattern
      const events: ContextEvent[] = [
        // Turn 1: neo4j-query execution
        { type: 'pattern_enter', ts: 1, patternId: 'neo4j-query', data: {} },
        { type: 'tool_call', ts: 2, patternId: 'neo4j-query', data: { tool: 'read_neo4j_cypher' } },
        { type: 'tool_result', ts: 3, patternId: 'neo4j-query', data: { tool: 'read_neo4j_cypher', result: 'turn1-data', success: true } },
        { type: 'pattern_exit', ts: 4, patternId: 'neo4j-query', data: {} },
        // Turn 1: synthesizer
        { type: 'pattern_enter', ts: 5, patternId: 'response-synth', data: {} },
        { type: 'assistant_message', ts: 6, patternId: 'response-synth', data: { content: 'turn1 response' } },
        { type: 'pattern_exit', ts: 7, patternId: 'response-synth', data: {} },
        // Turn 2: neo4j-query execution (same patternId)
        { type: 'pattern_enter', ts: 8, patternId: 'neo4j-query', data: {} },
        { type: 'tool_call', ts: 9, patternId: 'neo4j-query', data: { tool: 'read_neo4j_cypher' } },
        { type: 'tool_result', ts: 10, patternId: 'neo4j-query', data: { tool: 'read_neo4j_cypher', result: 'turn2-data', success: true } },
        { type: 'pattern_exit', ts: 11, patternId: 'neo4j-query', data: {} },
        // Turn 2: synthesizer (self — excluded)
        { type: 'pattern_enter', ts: 12, patternId: 'response-synth', data: {} },
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx, undefined, 'response-synth')

      const result = view.fromLastPattern().get()

      // Should only contain events from the SECOND neo4j-query execution (ts 8-11)
      expect(result).toHaveLength(4)
      expect(result.every(e => e.ts >= 8 && e.ts <= 11)).toBe(true)

      // Specifically: should NOT contain turn 1 events
      const turn1Data = result.find(e => e.type === 'tool_result' && (e.data as Record<string, unknown>).result === 'turn1-data')
      expect(turn1Data).toBeUndefined()

      // Should contain turn 2 tool_result
      const turn2Data = result.find(e => e.type === 'tool_result' && (e.data as Record<string, unknown>).result === 'turn2-data')
      expect(turn2Data).toBeDefined()
    })
  })

  describe('fromLastNPatterns()', () => {
    it('should filter events from last N patterns', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'pattern_enter', ts: 1, patternId: 'first', data: {} },
        { type: 'tool_call', ts: 2, patternId: 'first', data: {} },
        { type: 'pattern_enter', ts: 3, patternId: 'second', data: {} },
        { type: 'tool_call', ts: 4, patternId: 'second', data: {} },
        { type: 'pattern_enter', ts: 5, patternId: 'third', data: {} },
        { type: 'tool_call', ts: 6, patternId: 'third', data: {} }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.fromLastNPatterns(2).get()
      const patternIds = [...new Set(result.map(e => e.patternId))]
      expect(patternIds).toEqual(['second', 'third'])
    })

    it('should return all events when N exceeds pattern count', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'pattern_enter', ts: 1, patternId: 'first', data: {} },
        { type: 'tool_call', ts: 2, patternId: 'first', data: {} }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      // Request more patterns than exist
      const result = view.fromLastNPatterns(10).get()
      expect(result.length).toBeGreaterThanOrEqual(1)
    })
  })

  describe('fromAll()', () => {
    it('should return all events without pattern filter', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'tool_call', ts: 1, patternId: 'p1', data: {} },
        { type: 'tool_call', ts: 2, patternId: 'p2', data: {} }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.fromAll().get()
      expect(result).toHaveLength(2)
    })
  })

  describe('ofType()', () => {
    it('should filter events by type', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'user_message', ts: 1, patternId: 'p1', data: { content: 'hi' } },
        { type: 'tool_call', ts: 2, patternId: 'p1', data: { tool: 'test' } },
        { type: 'tool_result', ts: 3, patternId: 'p1', data: { result: 'ok' } }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.ofType('tool_call').get()
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('tool_call')
    })
  })

  describe('ofTypes()', () => {
    it('should filter events by multiple types', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'user_message', ts: 1, patternId: 'p1', data: { content: 'hi' } },
        { type: 'tool_call', ts: 2, patternId: 'p1', data: { tool: 'test' } },
        { type: 'tool_result', ts: 3, patternId: 'p1', data: { result: 'ok' } }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.ofTypes(['tool_call', 'tool_result']).get()
      expect(result).toHaveLength(2)
    })
  })

  describe('tools()', () => {
    it('should return tool_call and tool_result events', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'user_message', ts: 1, patternId: 'p1', data: { content: 'hi' } },
        { type: 'tool_call', ts: 2, patternId: 'p1', data: { tool: 'test', args: {} } },
        { type: 'tool_result', ts: 3, patternId: 'p1', data: { tool: 'test', success: true, result: 'ok' } }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.tools().get()
      expect(result).toHaveLength(2)
      expect(result.every(e => ['tool_call', 'tool_result'].includes(e.type))).toBe(true)
    })
  })

  describe('messages()', () => {
    it('should return user_message and assistant_message events', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'user_message', ts: 1, patternId: 'p1', data: { content: 'hi' } },
        { type: 'assistant_message', ts: 2, patternId: 'p1', data: { content: 'hello' } },
        { type: 'tool_call', ts: 3, patternId: 'p1', data: { tool: 'test' } }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.messages().get()
      expect(result).toHaveLength(2)
      expect(result.every(e => ['user_message', 'assistant_message'].includes(e.type))).toBe(true)
    })
  })

  describe('actions()', () => {
    it('should return controller_action events', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'controller_action', ts: 1, patternId: 'p1', data: { action: 'test' } },
        { type: 'tool_call', ts: 2, patternId: 'p1', data: { tool: 'test' } },
        { type: 'controller_action', ts: 3, patternId: 'p1', data: { action: 'test2' } }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.actions().get()
      expect(result).toHaveLength(2)
      expect(result.every(e => e.type === 'controller_action')).toBe(true)
    })
  })

  describe('last()', () => {
    it('should return last N events', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'tool_call', ts: 1, patternId: 'p1', data: { n: 1 } },
        { type: 'tool_call', ts: 2, patternId: 'p1', data: { n: 2 } },
        { type: 'tool_call', ts: 3, patternId: 'p1', data: { n: 3 } }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.last(2).get()
      expect(result).toHaveLength(2)
      expect((result[0].data as { n: number }).n).toBe(2)
      expect((result[1].data as { n: number }).n).toBe(3)
    })
  })

  describe('first()', () => {
    it('should return first N events', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'tool_call', ts: 1, patternId: 'p1', data: { n: 1 } },
        { type: 'tool_call', ts: 2, patternId: 'p1', data: { n: 2 } },
        { type: 'tool_call', ts: 3, patternId: 'p1', data: { n: 3 } }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.first(2).get()
      expect(result).toHaveLength(2)
      expect((result[0].data as { n: number }).n).toBe(1)
      expect((result[1].data as { n: number }).n).toBe(2)
    })
  })

  describe('since()', () => {
    it('should filter events since timestamp', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'tool_call', ts: 100, patternId: 'p1', data: {} },
        { type: 'tool_call', ts: 200, patternId: 'p1', data: {} },
        { type: 'tool_call', ts: 300, patternId: 'p1', data: {} }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.since(200).get()
      expect(result).toHaveLength(2)
      expect(result.every(e => e.ts >= 200)).toBe(true)
    })
  })

  describe('fromLastNTurns()', () => {
    it('should return events from the last N user turns', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        // Turn 1
        { type: 'user_message', ts: 1, patternId: 'p1', data: { content: 'first' } },
        { type: 'tool_call', ts: 2, patternId: 'p1', data: { tool: 'a' } },
        { type: 'tool_result', ts: 3, patternId: 'p1', data: { tool: 'a', result: 'r1', success: true } },
        // Turn 2
        { type: 'user_message', ts: 4, patternId: 'p1', data: { content: 'second' } },
        { type: 'tool_call', ts: 5, patternId: 'p1', data: { tool: 'b' } },
        { type: 'tool_result', ts: 6, patternId: 'p1', data: { tool: 'b', result: 'r2', success: true } },
        // Turn 3
        { type: 'user_message', ts: 7, patternId: 'p1', data: { content: 'third' } },
        { type: 'tool_call', ts: 8, patternId: 'p1', data: { tool: 'c' } },
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      // Last 1 turn: only turn 3 events
      const last1 = view.fromLastNTurns(1).get()
      expect(last1).toHaveLength(2) // user_message + tool_call from turn 3
      expect(last1[0].ts).toBe(7)

      // Last 2 turns: turns 2 and 3
      const last2 = view.fromLastNTurns(2).get()
      expect(last2).toHaveLength(5) // turns 2+3
      expect(last2[0].ts).toBe(4)
    })

    it('should return all events when N exceeds turn count', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'user_message', ts: 1, patternId: 'p1', data: { content: 'only turn' } },
        { type: 'tool_call', ts: 2, patternId: 'p1', data: { tool: 'a' } },
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.fromLastNTurns(10).get()
      expect(result).toHaveLength(2)
    })

    it('should chain with type filters', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'user_message', ts: 1, patternId: 'p1', data: { content: 'first' } },
        { type: 'tool_result', ts: 2, patternId: 'p1', id: 'ev-old', data: { tool: 'a', result: 'old', success: true } },
        { type: 'user_message', ts: 3, patternId: 'p1', data: { content: 'second' } },
        { type: 'tool_result', ts: 4, patternId: 'p1', id: 'ev-new', data: { tool: 'b', result: 'new', success: true } },
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      // Last 1 turn, tool_results only — should get ev-new only
      const result = view.fromLastNTurns(1).ofType('tool_result').get()
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('ev-new')
    })

    it('should return all events when no user_messages exist', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'tool_call', ts: 1, patternId: 'p1', data: { tool: 'a' } },
        { type: 'tool_result', ts: 2, patternId: 'p1', data: { tool: 'a', result: 'r', success: true } },
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.fromLastNTurns(1).get()
      expect(result).toHaveLength(2)
    })
  })

  describe('serialize()', () => {
    it('should serialize events to XML format', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'user_message', ts: 1, patternId: 'p1', data: { content: 'Hello' } }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.serialize()
      expect(result).toContain('<user_message>')
      expect(result).toContain('Hello')
      expect(result).toContain('</user_message>')
    })

    it('should format tool_call events correctly', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'tool_call', ts: 1, patternId: 'p1', data: { tool: 'search', args: { query: 'test' } } }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.serialize()
      expect(result).toContain('<tool_call>')
      expect(result).toContain('search')
    })

    it('should format tool_result events correctly', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'tool_result', ts: 1, patternId: 'p1', data: { tool: 'search', success: true, result: { items: [] } } }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.serialize()
      expect(result).toContain('<tool_result>')
      expect(result).toContain('search')
    })

    it('should format failed tool_result events with error', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'tool_result', ts: 1, patternId: 'p1', data: { tool: 'search', success: false, error: 'Not found' } }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.serialize()
      expect(result).toContain('ERROR')
      expect(result).toContain('Not found')
    })
  })

  describe('exists()', () => {
    it('should return true when events match', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'tool_call', ts: 1, patternId: 'p1', data: {} }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      expect(view.ofType('tool_call').exists()).toBe(true)
    })

    it('should return false when no events match', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const ctx = createMockContext([])
      const view = createEventView(ctx)

      expect(view.ofType('tool_call').exists()).toBe(false)
    })
  })

  describe('count()', () => {
    it('should return count of matching events', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'tool_call', ts: 1, patternId: 'p1', data: {} },
        { type: 'tool_call', ts: 2, patternId: 'p1', data: {} },
        { type: 'tool_result', ts: 3, patternId: 'p1', data: {} }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      expect(view.ofType('tool_call').count()).toBe(2)
    })
  })

  describe('chaining', () => {
    it('should support method chaining', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'pattern_enter', ts: 1, patternId: 'p1', data: {} },
        { type: 'tool_call', ts: 2, patternId: 'p1', data: {} },
        { type: 'tool_call', ts: 3, patternId: 'p1', data: {} },
        { type: 'tool_result', ts: 4, patternId: 'p1', data: {} },
        { type: 'pattern_enter', ts: 5, patternId: 'p2', data: {} },
        { type: 'tool_call', ts: 6, patternId: 'p2', data: {} }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view
        .fromPattern('p1')
        .ofType('tool_call')
        .last(1)
        .get()

      expect(result).toHaveLength(1)
      expect(result[0].ts).toBe(3)
    })
  })

  describe('ViewConfig', () => {
    // Note: ViewConfig's applyConfig method calls methods that return clones
    // but doesn't assign the result, so the config application is partial.
    // These tests verify the actual behavior.

    it('should support method chaining with explicit filters', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'pattern_enter', ts: 1, patternId: 'p1', data: {} },
        { type: 'tool_call', ts: 2, patternId: 'p1', data: {} },
        { type: 'pattern_enter', ts: 3, patternId: 'p2', data: {} },
        { type: 'tool_call', ts: 4, patternId: 'p2', data: {} }
      ]

      const ctx = createMockContext(events)
      // Use explicit method chaining instead of config
      const view = createEventView(ctx)
        .fromPatterns(['p1'])
        .ofTypes(['tool_call'])

      const result = view.get()
      expect(result).toHaveLength(1)
      expect(result[0].patternId).toBe('p1')
    })

    it('should support method chaining with limit', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'tool_call', ts: 1, patternId: 'p1', data: {} },
        { type: 'tool_call', ts: 2, patternId: 'p1', data: {} },
        { type: 'tool_call', ts: 3, patternId: 'p1', data: {} }
      ]

      const ctx = createMockContext(events)
      // Use explicit method chaining
      const view = createEventView(ctx).last(2)

      const result = view.get()
      expect(result).toHaveLength(2)
    })

    it('should support fromLastN with method chaining', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'pattern_enter', ts: 1, patternId: 'p1', data: {} },
        { type: 'tool_call', ts: 2, patternId: 'p1', data: {} },
        { type: 'pattern_enter', ts: 3, patternId: 'p2', data: {} },
        { type: 'tool_call', ts: 4, patternId: 'p2', data: {} },
        { type: 'pattern_enter', ts: 5, patternId: 'p3', data: {} },
        { type: 'tool_call', ts: 6, patternId: 'p3', data: {} }
      ]

      const ctx = createMockContext(events)
      // Use explicit method chaining
      const view = createEventView(ctx)
        .fromLastNPatterns(2)
        .ofTypes(['tool_call'])

      const result = view.get()
      // Should get tool_call events from the last 2 patterns (p2 and p3)
      expect(result.length).toBeGreaterThanOrEqual(2)
      const patternIds = result.map(e => e.patternId)
      expect(patternIds).toContain('p2')
      expect(patternIds).toContain('p3')
    })

    it('should apply fromLastNTurns via ViewConfig', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        // Turn 1
        { type: 'user_message', ts: 1, patternId: 'p1', data: { content: 'first' } },
        { type: 'tool_result', ts: 2, patternId: 'p1', id: 'ev-1', data: { tool: 'a', result: 'old', success: true } },
        // Turn 2
        { type: 'user_message', ts: 3, patternId: 'p1', data: { content: 'second' } },
        { type: 'tool_result', ts: 4, patternId: 'p1', id: 'ev-2', data: { tool: 'b', result: 'new', success: true } },
      ]

      const ctx = createMockContext(events)
      // Apply via ViewConfig constructor param (the path used by router and simpleLoop)
      const view = createEventView(ctx, {
        fromLast: false,
        fromLastNTurns: 1,
        eventTypes: ['tool_result']
      })

      const result = view.get()
      // Should only get tool_result from turn 2
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe('ev-2')
    })

    it('should combine fromLastNTurns with eventTypes in ViewConfig', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'user_message', ts: 1, patternId: 'p1', data: { content: 'first' } },
        { type: 'tool_call', ts: 2, patternId: 'p1', data: { tool: 'a', args: {} } },
        { type: 'tool_result', ts: 3, patternId: 'p1', data: { tool: 'a', result: 'r1', success: true } },
        { type: 'user_message', ts: 4, patternId: 'p1', data: { content: 'second' } },
        { type: 'tool_call', ts: 5, patternId: 'p1', data: { tool: 'b', args: {} } },
        { type: 'tool_result', ts: 6, patternId: 'p1', data: { tool: 'b', result: 'r2', success: true } },
        { type: 'assistant_message', ts: 7, patternId: 'p1', data: { content: 'response' } },
      ]

      const ctx = createMockContext(events)
      // Config like the router default: last 2 turns, only messages
      const view = createEventView(ctx, {
        fromLast: false,
        fromLastNTurns: 2,
        eventTypes: ['user_message', 'assistant_message']
      })

      const result = view.get()
      // Should get: user_message(first), user_message(second), assistant_message
      expect(result).toHaveLength(3)
      expect(result.every(e => ['user_message', 'assistant_message'].includes(e.type))).toBe(true)
    })
  })

  describe('errors()', () => {
    it('should return error events', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'tool_call', ts: 1, patternId: 'p1', data: { tool: 'test' } },
        { type: 'error', ts: 2, patternId: 'p1', data: { error: 'Something went wrong' } },
        { type: 'tool_result', ts: 3, patternId: 'p1', data: { result: 'ok' } }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.errors().get()
      expect(result).toHaveLength(1)
      expect(result[0].type).toBe('error')
    })
  })

  describe('hasErrors()', () => {
    it('should return true when errors exist', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'error', ts: 1, patternId: 'p1', data: { error: 'Failed' } }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      expect(view.hasErrors()).toBe(true)
    })

    it('should return false when no errors exist', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'tool_call', ts: 1, patternId: 'p1', data: { tool: 'test' } }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      expect(view.hasErrors()).toBe(false)
    })
  })

  describe('lastError()', () => {
    it('should return the last error message', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'error', ts: 1, patternId: 'p1', data: { error: 'First error' } },
        { type: 'error', ts: 2, patternId: 'p1', data: { error: 'Second error' } }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      expect(view.lastError()).toBe('Second error')
    })

    it('should return undefined when no errors exist', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'tool_call', ts: 1, patternId: 'p1', data: { tool: 'test' } }
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      expect(view.lastError()).toBeUndefined()
    })
  })

  describe('serializeCompact — hidden/archived filtering', () => {
    it('should exclude hidden tool_result events from compact serialization', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'user_message', ts: 1, patternId: 'p1', data: { content: 'query' } },
        { type: 'tool_result', ts: 2, patternId: 'p1', id: 'ev-visible', data: { tool: 'search', result: 'visible data', success: true } },
        { type: 'tool_result', ts: 3, patternId: 'p1', id: 'ev-hidden', data: { tool: 'fetch', result: 'hidden data', success: true, hidden: true } },
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.serializeCompact()
      expect(result).toContain('visible data')
      expect(result).not.toContain('hidden data')
    })

    it('should exclude archived tool_result events from compact serialization', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'user_message', ts: 1, patternId: 'p1', data: { content: 'query' } },
        { type: 'tool_result', ts: 2, patternId: 'p1', id: 'ev-visible', data: { tool: 'search', result: 'active data', success: true } },
        { type: 'tool_result', ts: 3, patternId: 'p1', id: 'ev-archived', data: { tool: 'fetch', result: 'archived data', success: true, archived: true } },
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.serializeCompact()
      expect(result).toContain('active data')
      expect(result).not.toContain('archived data')
    })

    it('should include non-tool_result events even when hidden/archived flags exist on other events', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'user_message', ts: 1, patternId: 'p1', data: { content: 'query' } },
        { type: 'tool_call', ts: 2, patternId: 'p1', data: { tool: 'search', args: {} } },
        { type: 'tool_result', ts: 3, patternId: 'p1', id: 'ev-hidden', data: { tool: 'search', result: 'hidden', success: true, hidden: true } },
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.serializeCompact()
      // tool_call should still be present
      expect(result).toContain('tool_call')
      expect(result).toContain('search')
      // hidden tool_result should be excluded
      expect(result).not.toContain('hidden')
    })
  })

  describe('serializeCompact — summary in compact pointers', () => {
    it('should use LLM summary in compact pointer when available', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        // Turn 1 (older — will be compacted)
        { type: 'user_message', ts: 1, patternId: 'p1', data: { content: 'first query' } },
        { type: 'tool_result', ts: 2, patternId: 'p1', id: 'ev-old', data: { tool: 'search', result: 'raw result data that is very long', success: true, summary: 'Found 3 search results about testing.' } },
        // Turn 2 (current — rendered in full)
        { type: 'user_message', ts: 3, patternId: 'p1', data: { content: 'second query' } },
        { type: 'tool_result', ts: 4, patternId: 'p1', id: 'ev-new', data: { tool: 'fetch', result: 'current result', success: true } },
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.serializeCompact({ recentTurns: 1 })
      // Older event should use summary in compact pointer
      expect(result).toContain('Found 3 search results about testing.')
      expect(result).toContain('compact="true"')
      expect(result).toContain('ref:ev-old')
      // Current turn event should be rendered in full
      expect(result).toContain('current result')
    })

    it('should fall back to raw result slice when no summary available', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const longResult = 'x'.repeat(200)
      const events: ContextEvent[] = [
        { type: 'user_message', ts: 1, patternId: 'p1', data: { content: 'first query' } },
        { type: 'tool_result', ts: 2, patternId: 'p1', id: 'ev-old', data: { tool: 'search', result: longResult, success: true } },
        { type: 'user_message', ts: 3, patternId: 'p1', data: { content: 'second query' } },
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.serializeCompact({ recentTurns: 1 })
      // Should contain truncated raw result with "..."
      expect(result).toContain('...')
      expect(result).toContain('compact="true"')
      expect(result).toContain('ref:ev-old')
    })

    it('should include accurate char count in compact pointer', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const resultData = 'Exact length test data'
      const events: ContextEvent[] = [
        { type: 'user_message', ts: 1, patternId: 'p1', data: { content: 'first query' } },
        { type: 'tool_result', ts: 2, patternId: 'p1', id: 'ev-counted', data: { tool: 'search', result: resultData, success: true } },
        { type: 'user_message', ts: 3, patternId: 'p1', data: { content: 'second query' } },
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.serializeCompact({ recentTurns: 1 })
      // The char count should match the raw result string length (not JSON.stringify)
      const expectedLen = resultData.length
      expect(result).toContain(`(${expectedLen} chars)`)
      expect(result).toContain('tool="search"')
      expect(result).toContain('ref:ev-counted')
    })
  })

  describe('serialize — tool_result with summary', () => {
    it('should append summary to full tool_result serialization', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'tool_result', ts: 1, patternId: 'p1', data: { tool: 'search', result: { items: [1, 2] }, success: true, summary: 'Found 2 items matching the query.' } },
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.serialize()
      expect(result).toContain('[Summary: Found 2 items matching the query.]')
      expect(result).toContain('search')
    })

    it('should not append summary tag when no summary exists', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'tool_result', ts: 1, patternId: 'p1', data: { tool: 'search', result: { items: [1] }, success: true } },
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.serialize()
      expect(result).not.toContain('[Summary:')
      expect(result).toContain('search')
    })

    it('should not append summary for error results', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'tool_result', ts: 1, patternId: 'p1', data: { tool: 'search', result: null, success: false, error: 'Connection refused', summary: 'Should not show' } },
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx)

      const result = view.serialize()
      expect(result).toContain('ERROR')
      expect(result).toContain('Connection refused')
      expect(result).not.toContain('[Summary:')
    })
  })

  describe('selfPatternId exclusion', () => {
    it('fromLastPattern() should exclude self when selfPatternId is provided', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'pattern_enter', ts: 1, patternId: 'router-1', data: { pattern: 'router' } },
        { type: 'assistant_message', ts: 2, patternId: 'router-1', data: { content: 'hi' } },
        { type: 'pattern_enter', ts: 3, patternId: 'web-search', data: { pattern: 'simpleLoop' } },
        { type: 'tool_call', ts: 4, patternId: 'web-search', data: { tool: 'search' } },
        { type: 'tool_result', ts: 5, patternId: 'web-search', data: { tool: 'search', result: 'found', success: true } },
        { type: 'pattern_enter', ts: 6, patternId: 'synth-1', data: { pattern: 'synthesizer' } },
      ]

      const ctx = createMockContext(events)
      // Without selfPatternId — fromLastPattern returns synth-1 (self)
      const viewNoSelf = createEventView(ctx)
      expect(viewNoSelf.fromLastPattern().tools().get()).toHaveLength(0)

      // With selfPatternId — fromLastPattern skips synth-1, returns web-search
      const viewWithSelf = createEventView(ctx, undefined, 'synth-1')
      const tools = viewWithSelf.fromLastPattern().tools().get()
      expect(tools).toHaveLength(2)
      expect(tools[0].patternId).toBe('web-search')
    })

    it('fromLastNPatterns() should exclude self when selfPatternId is provided', async () => {
      const { createEventView } = await import('../../../../lib/harness-patterns/patterns/event-view.server')

      const events: ContextEvent[] = [
        { type: 'pattern_enter', ts: 1, patternId: 'p1', data: {} },
        { type: 'tool_call', ts: 2, patternId: 'p1', data: {} },
        { type: 'pattern_enter', ts: 3, patternId: 'p2', data: {} },
        { type: 'tool_call', ts: 4, patternId: 'p2', data: {} },
        { type: 'pattern_enter', ts: 5, patternId: 'self', data: {} },
      ]

      const ctx = createMockContext(events)
      const view = createEventView(ctx, undefined, 'self')
      // Last 1 pattern (excluding self) should be p2
      const result = view.fromLastNPatterns(1).get()
      expect(result.every(e => e.patternId === 'p2')).toBe(true)
    })
  })
})
