/**
 * Live Event Streaming Tests
 *
 * Covers:
 *  - emitLive() ALS gating (no listener → no-op; listener + disabled → no-op)
 *  - trackEvent() forwards events when liveEvents is enabled for the current pattern
 *  - runChain() dedup: events emitted live are not re-emitted at commit time
 *  - harness() end-to-end: simpleLoop with liveEvents:true streams in-flight events
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn()
}))

describe('live-event-context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emitLive is a no-op when no listener is installed', async () => {
    const { emitLive } = await import('../../../lib/harness-patterns/live-event-context.server')
    expect(emitLive({ id: 'ev-1', type: 'tool_call', ts: 0, patternId: 'p', data: {} })).toBe(false)
  })

  it('emitLive does not fire until setLivePatternEnabled(true) is called', async () => {
    const { runWithLiveListener, emitLive } = await import(
      '../../../lib/harness-patterns/live-event-context.server'
    )
    const listener = vi.fn()
    await runWithLiveListener(listener, async () => {
      emitLive({ id: 'ev-a', type: 'tool_call', ts: 0, patternId: 'p', data: {} })
    })
    expect(listener).not.toHaveBeenCalled()
  })

  it('emitLive fires when both the listener and the pattern toggle are active', async () => {
    const { runWithLiveListener, setLivePatternEnabled, emitLive } = await import(
      '../../../lib/harness-patterns/live-event-context.server'
    )
    const listener = vi.fn()
    await runWithLiveListener(listener, async () => {
      setLivePatternEnabled(true)
      emitLive({ id: 'ev-x', type: 'controller_action', ts: 0, patternId: 'p', data: { status: 'thinking' } })
    })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].id).toBe('ev-x')
  })

  it('wasEmittedLive remembers ids that were dispatched', async () => {
    const { runWithLiveListener, setLivePatternEnabled, emitLive, wasEmittedLive } = await import(
      '../../../lib/harness-patterns/live-event-context.server'
    )
    await runWithLiveListener(vi.fn(), async () => {
      setLivePatternEnabled(true)
      const ev = { id: 'ev-y', type: 'tool_call' as const, ts: 0, patternId: 'p', data: {} }
      emitLive(ev)
      expect(wasEmittedLive(ev)).toBe(true)
      expect(wasEmittedLive({ id: 'ev-other', type: 'tool_call', ts: 0, patternId: 'p', data: {} })).toBe(false)
    })
  })
})

describe('trackEvent + liveEvents', () => {
  beforeEach(() => vi.clearAllMocks())

  it('forwards a tracked event to the live listener when enabled', async () => {
    const { runWithLiveListener, setLivePatternEnabled } = await import(
      '../../../lib/harness-patterns/live-event-context.server'
    )
    const { createScope, trackEvent } = await import(
      '../../../lib/harness-patterns/context.server'
    )

    const listener = vi.fn()
    await runWithLiveListener(listener, async () => {
      setLivePatternEnabled(true)
      const scope = createScope('p1', {})
      trackEvent(scope, 'controller_action', { reasoning: 'r', status: 's' }, true)
    })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0][0].type).toBe('controller_action')
  })

  it('does not forward when liveEvents is off (default behavior)', async () => {
    const { runWithLiveListener, setLivePatternEnabled } = await import(
      '../../../lib/harness-patterns/live-event-context.server'
    )
    const { createScope, trackEvent } = await import(
      '../../../lib/harness-patterns/context.server'
    )

    const listener = vi.fn()
    await runWithLiveListener(listener, async () => {
      setLivePatternEnabled(false)
      const scope = createScope('p1', {})
      trackEvent(scope, 'tool_call', { tool: 't', args: {} }, true)
    })
    expect(listener).not.toHaveBeenCalled()
  })

  it('respects the trackHistory filter — events not tracked are not emitted live', async () => {
    const { runWithLiveListener, setLivePatternEnabled } = await import(
      '../../../lib/harness-patterns/live-event-context.server'
    )
    const { createScope, trackEvent } = await import(
      '../../../lib/harness-patterns/context.server'
    )

    const listener = vi.fn()
    await runWithLiveListener(listener, async () => {
      setLivePatternEnabled(true)
      const scope = createScope('p1', {})
      // trackHistory = false → not tracked → not emitted
      trackEvent(scope, 'tool_call', { tool: 't', args: {} }, false)
    })
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('runChain dedup', () => {
  beforeEach(() => vi.clearAllMocks())

  it('skips events at commit time that were already emitted live', async () => {
    const { runWithLiveListener } = await import(
      '../../../lib/harness-patterns/live-event-context.server'
    )
    const { runChain } = await import('../../../lib/harness-patterns/patterns/chain.server')
    const { createContext, trackEvent } = await import(
      '../../../lib/harness-patterns/context.server'
    )

    const ctx = createContext('hi', {} as Record<string, unknown>)

    // Pattern that tracks one tool_result event
    const livePattern = {
      name: 'live-loop',
      fn: async (scope: import('../../../lib/harness-patterns/types').PatternScope<Record<string, unknown>>) => {
        trackEvent(scope, 'tool_result', { tool: 'foo', result: 1, success: true }, true)
        return scope
      },
      config: {
        patternId: 'live-loop',
        commitStrategy: 'always' as const,
        trackHistory: true as const,
        liveEvents: true
      }
    }

    const listener = vi.fn()
    await runWithLiveListener(listener, () => runChain(ctx, [livePattern], listener))

    // Listener should have been invoked exactly once for the tool_result —
    // not twice (live emission + commit-time emission would be a bug).
    const toolResults = listener.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === 'tool_result')
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0].data).toMatchObject({ tool: 'foo', success: true })
  })

  it('still emits at commit time when liveEvents is off (legacy behavior)', async () => {
    const { runWithLiveListener } = await import(
      '../../../lib/harness-patterns/live-event-context.server'
    )
    const { runChain } = await import('../../../lib/harness-patterns/patterns/chain.server')
    const { createContext, trackEvent } = await import(
      '../../../lib/harness-patterns/context.server'
    )

    const ctx = createContext('hi', {} as Record<string, unknown>)

    const bufferedPattern = {
      name: 'buffered',
      fn: async (scope: import('../../../lib/harness-patterns/types').PatternScope<Record<string, unknown>>) => {
        trackEvent(scope, 'tool_result', { tool: 'bar', result: 2, success: true }, true)
        return scope
      },
      config: {
        patternId: 'buffered',
        commitStrategy: 'always' as const,
        trackHistory: true as const
        // liveEvents not set → defaults to commit-time emission
      }
    }

    const listener = vi.fn()
    await runWithLiveListener(listener, () => runChain(ctx, [bufferedPattern], listener))

    const toolResults = listener.mock.calls
      .map((c) => c[0])
      .filter((e) => e.type === 'tool_result')
    expect(toolResults).toHaveLength(1)
    expect(toolResults[0].data).toMatchObject({ tool: 'bar' })
  })

  it('streams pattern_enter and pattern_exit live when enabled', async () => {
    const { runWithLiveListener } = await import(
      '../../../lib/harness-patterns/live-event-context.server'
    )
    const { runChain } = await import('../../../lib/harness-patterns/patterns/chain.server')
    const { createContext } = await import('../../../lib/harness-patterns/context.server')

    const ctx = createContext('hi', {} as Record<string, unknown>)

    const livePattern = {
      name: 'lifecycle',
      fn: async (scope: import('../../../lib/harness-patterns/types').PatternScope<Record<string, unknown>>) => scope,
      config: {
        patternId: 'lifecycle',
        commitStrategy: 'always' as const,
        trackHistory: true as const,
        liveEvents: true
      }
    }

    const seen: string[] = []
    await runWithLiveListener(
      (e) => seen.push(e.type),
      () => runChain(ctx, [livePattern])
    )

    expect(seen).toContain('pattern_enter')
    expect(seen).toContain('pattern_exit')
  })

  it('routes emits child pattern_enter/exit live when liveEvents is on', async () => {
    const { runWithLiveListener } = await import(
      '../../../lib/harness-patterns/live-event-context.server'
    )
    const { runChain } = await import('../../../lib/harness-patterns/patterns/chain.server')
    const { routes } = await import('../../../lib/harness-patterns/patterns/router.server')
    const { createContext, trackEvent } = await import(
      '../../../lib/harness-patterns/context.server'
    )

    // Inner pattern has maxTurns set so its pattern_enter carries a payload
    const inner = {
      name: 'inner-loop',
      fn: async (scope: import('../../../lib/harness-patterns/types').PatternScope<Record<string, unknown>>) => {
        trackEvent(scope, 'tool_result', { tool: 'x', result: 1, success: true }, true)
        return scope
      },
      config: {
        patternId: 'inner-loop',
        commitStrategy: 'always' as const,
        trackHistory: true as const,
        maxTurns: 5
      }
    }

    const routesPattern = routes({ inner }, { liveEvents: true })

    const ctx = createContext('hi', { route: 'inner' } as Record<string, unknown>)

    const events: import('../../../lib/harness-patterns/types').ContextEvent[] = []
    await runWithLiveListener(
      (e) => events.push(e),
      () => runChain(ctx, [routesPattern])
    )

    // Find the live-emitted child pattern_enter — it must carry maxTurns
    const childEnter = events.find(
      (e) => e.type === 'pattern_enter' && (e.data as { pattern?: string }).pattern === 'inner-loop'
    )
    expect(childEnter).toBeDefined()
    expect((childEnter!.data as { maxTurns?: number }).maxTurns).toBe(5)

    const childExit = events.find(
      (e) => e.type === 'pattern_exit' && e.patternId === 'inner-loop'
    )
    expect(childExit).toBeDefined()
  })

  it('emits in-flight events before the pattern finishes', async () => {
    const { runWithLiveListener } = await import(
      '../../../lib/harness-patterns/live-event-context.server'
    )
    const { runChain } = await import('../../../lib/harness-patterns/patterns/chain.server')
    const { createContext, trackEvent } = await import(
      '../../../lib/harness-patterns/context.server'
    )

    const ctx = createContext('hi', {} as Record<string, unknown>)

    let seenBeforeReturn = 0
    const observer = vi.fn(() => {
      seenBeforeReturn++
    })

    const slowPattern = {
      name: 'slow',
      fn: async (scope: import('../../../lib/harness-patterns/types').PatternScope<Record<string, unknown>>) => {
        // Three "in-flight" status events; the listener should see them
        // as we go, not all at the end.
        trackEvent(scope, 'controller_action', { reasoning: '', status: 'step 1', tool_name: '', tool_args: '', is_final: false }, true)
        await Promise.resolve()
        trackEvent(scope, 'controller_action', { reasoning: '', status: 'step 2', tool_name: '', tool_args: '', is_final: false }, true)
        await Promise.resolve()
        trackEvent(scope, 'controller_action', { reasoning: '', status: 'step 3', tool_name: '', tool_args: '', is_final: true }, true)
        // By the time we return, all 3 status events should already have fired
        expect(seenBeforeReturn).toBe(3)
        return scope
      },
      config: {
        patternId: 'slow',
        commitStrategy: 'always' as const,
        trackHistory: true as const,
        liveEvents: true
      }
    }

    await runWithLiveListener(observer, () => runChain(ctx, [slowPattern]))
    expect(observer).toHaveBeenCalled()
  })
})
