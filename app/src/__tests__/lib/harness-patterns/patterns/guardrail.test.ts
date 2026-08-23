/**
 * Guardrail Pattern Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock server-only imports
vi.mock('../../../../lib/harness-patterns/assert.server', () => ({
  assertServerOnImport: vi.fn(),
}))

// Mock MCP client
const mockCallTool = vi.fn()
vi.mock('../../../../lib/harness-patterns/mcp-client.server', () => ({
  callTool: (...args: unknown[]) => mockCallTool(...args),
}))

describe('guardrail', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockCallTool.mockResolvedValue({ success: true, data: [] })
  })

  it('should export guardrail function', async () => {
    const { guardrail } = await import('../../../../lib/harness-patterns/patterns/guardrail.server')
    expect(guardrail).toBeDefined()
    expect(typeof guardrail).toBe('function')
  })

  it('should create a ConfiguredPattern wrapping inner pattern', async () => {
    const { guardrail } = await import('../../../../lib/harness-patterns/patterns/guardrail.server')

    const innerPattern = {
      name: 'inner',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'inner' },
    }

    const pattern = guardrail(innerPattern, {
      patternId: 'test-guardrail',
      rails: [],
    })

    expect(pattern.name).toBe('guardrail(inner)')
    expect(pattern.fn).toBeDefined()
  })

  it('should execute inner pattern when no rails block', async () => {
    const { guardrail } = await import('../../../../lib/harness-patterns/patterns/guardrail.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } =
      await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const innerFn = vi.fn(async (scope) => {
      scope.data = { ...scope.data, executed: true }
      return scope
    })

    const innerPattern = {
      name: 'inner',
      fn: innerFn,
      config: { patternId: 'inner' },
    }

    const ctx = createContext<{ input?: string; executed?: boolean }>('test')
    ctx.data = { input: 'test' }
    const view = createEventView(ctx)

    const pattern = guardrail(innerPattern, { rails: [] })
    const result = await pattern.fn(
      { id: 'guardrail', data: ctx.data, events: [], startTime: Date.now() },
      view,
    )

    expect(innerFn).toHaveBeenCalled()
    expect(result.data.executed).toBe(true)
  })

  it('should wrap inner pattern events with pattern_enter/exit', async () => {
    const { guardrail } = await import('../../../../lib/harness-patterns/patterns/guardrail.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } =
      await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const innerFn = vi.fn(async (scope) => {
      scope.events.push({
        type: 'tool_call' as const,
        ts: Date.now(),
        patternId: 'inner',
        data: { tool: 'test' },
      })
      return scope
    })

    const innerPattern = {
      name: 'inner',
      fn: innerFn,
      config: { patternId: 'guarded-inner' },
    }

    const ctx = createContext<{ input?: string }>('test')
    ctx.data = { input: 'test' }
    const view = createEventView(ctx)

    const pattern = guardrail(innerPattern, { rails: [] })
    const result = await pattern.fn(
      { id: 'guardrail', data: ctx.data, events: [], startTime: Date.now() },
      view,
    )

    const enters = result.events.filter((e) => e.type === 'pattern_enter')
    const exits = result.events.filter((e) => e.type === 'pattern_exit')
    expect(enters.length).toBe(1)
    expect(exits.length).toBe(1)
    expect(enters[0].patternId).toBe('guarded-inner')
    expect(exits[0].patternId).toBe('guarded-inner')

    // Inner event should be between enter and exit
    const enterIdx = result.events.indexOf(enters[0])
    const exitIdx = result.events.indexOf(exits[0])
    const toolIdx = result.events.findIndex((e) => e.type === 'tool_call')
    expect(toolIdx).toBeGreaterThan(enterIdx)
    expect(toolIdx).toBeLessThan(exitIdx)
  })

  it('should block when input rail returns not ok', async () => {
    const { guardrail } = await import('../../../../lib/harness-patterns/patterns/guardrail.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } =
      await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const innerFn = vi.fn(async (scope) => scope)
    const innerPattern = {
      name: 'inner',
      fn: innerFn,
      config: { patternId: 'inner' },
    }

    const blockingRail = {
      name: 'blocker',
      phase: 'input' as const,
      check: vi.fn().mockResolvedValue({
        ok: false,
        reason: 'Blocked by test',
        action: 'block' as const,
      }),
    }

    const onBlock = vi.fn()

    const ctx = createContext<{ input?: string }>('test')
    ctx.data = { input: 'malicious input' }
    const view = createEventView(ctx)

    const pattern = guardrail(innerPattern, {
      rails: [blockingRail],
      onBlock,
    })

    const result = await pattern.fn(
      { id: 'guardrail', data: ctx.data, events: [], startTime: Date.now() },
      view,
    )

    // Inner pattern should NOT be executed
    expect(innerFn).not.toHaveBeenCalled()

    // Error should be tracked
    const errorEvents = result.events.filter((e) => e.type === 'error')
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(errorEvents[0].data)).toContain('Input rail')

    // onBlock callback should be called
    expect(onBlock).toHaveBeenCalledWith('blocker', 'Blocked by test')
  })

  it('should redact input when rail returns redact action', async () => {
    const { guardrail } = await import('../../../../lib/harness-patterns/patterns/guardrail.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } =
      await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const innerFn = vi.fn(async (scope) => {
      return scope
    })

    const innerPattern = {
      name: 'inner',
      fn: innerFn,
      config: { patternId: 'inner' },
    }

    const redactingRail = {
      name: 'redactor',
      phase: 'input' as const,
      check: vi.fn().mockResolvedValue({
        ok: false,
        action: 'redact' as const,
        reason: 'Contains secret',
        redacted: 'safe input',
      }),
    }

    const ctx = createContext<{ input: string }>('test')
    ctx.data = { input: 'secret input' }
    const view = createEventView(ctx)

    const pattern = guardrail(innerPattern, { rails: [redactingRail] })
    await pattern.fn({ id: 'guardrail', data: ctx.data, events: [], startTime: Date.now() }, view)

    // Inner pattern should be executed
    expect(innerFn).toHaveBeenCalled()
  })

  it('should check output rails after execution', async () => {
    const { guardrail } = await import('../../../../lib/harness-patterns/patterns/guardrail.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } =
      await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const innerPattern = {
      name: 'inner',
      fn: vi.fn(async (scope) => {
        scope.events.push({
          type: 'tool_result' as const,
          ts: Date.now(),
          patternId: 'inner',
          data: { tool: 'test', result: 'output' },
        })
        return scope
      }),
      config: { patternId: 'inner' },
    }

    const outputRail = {
      name: 'output-checker',
      phase: 'output' as const,
      check: vi.fn().mockResolvedValue({ ok: true }),
    }

    const ctx = createContext<{ input: string }>('test')
    ctx.data = { input: 'test' }
    const view = createEventView(ctx)

    const pattern = guardrail(innerPattern, { rails: [outputRail] })
    await pattern.fn({ id: 'guardrail', data: ctx.data, events: [], startTime: Date.now() }, view)

    // Output rail should have been checked
    expect(outputRail.check).toHaveBeenCalled()
  })

  it('should track error when output rail rejects with retry', async () => {
    const { guardrail } = await import('../../../../lib/harness-patterns/patterns/guardrail.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } =
      await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const innerPattern = {
      name: 'inner',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'inner' },
    }

    const outputRail = {
      name: 'output-rejector',
      phase: 'output' as const,
      check: vi.fn().mockResolvedValue({
        ok: false,
        action: 'retry' as const,
        reason: 'Bad output',
      }),
    }

    const ctx = createContext<{ input: string }>('test')
    ctx.data = { input: 'test' }
    const view = createEventView(ctx)

    const pattern = guardrail(innerPattern, { rails: [outputRail] })
    const result = await pattern.fn(
      { id: 'guardrail', data: ctx.data, events: [], startTime: Date.now() },
      view,
    )

    const errorEvents = result.events.filter((e) => e.type === 'error')
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(errorEvents[0].data)).toContain('Output rail')
  })

  it('should track error when output rail rejects with warn', async () => {
    const { guardrail } = await import('../../../../lib/harness-patterns/patterns/guardrail.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } =
      await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const innerPattern = {
      name: 'inner',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'inner' },
    }

    const outputRail = {
      name: 'output-warner',
      phase: 'output' as const,
      check: vi.fn().mockResolvedValue({
        ok: false,
        action: 'warn' as const,
        reason: 'Warning message',
      }),
    }

    const ctx = createContext<{ input: string }>('test')
    ctx.data = { input: 'test' }
    const view = createEventView(ctx)

    const pattern = guardrail(innerPattern, { rails: [outputRail] })
    const result = await pattern.fn(
      { id: 'guardrail', data: ctx.data, events: [], startTime: Date.now() },
      view,
    )

    const errorEvents = result.events.filter((e) => e.type === 'error')
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(errorEvents[0].data)).toContain('warning')
  })

  it('should check circuit breaker if configured', async () => {
    const { guardrail } = await import('../../../../lib/harness-patterns/patterns/guardrail.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } =
      await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const innerPattern = {
      name: 'inner',
      fn: vi.fn(async (scope) => scope),
      config: { patternId: 'inner' },
    }

    // Mock circuit breaker returning failures
    mockCallTool.mockResolvedValue({
      success: true,
      data: ['fail1', 'fail2', 'fail3'],
    })

    const ctx = createContext<{ input: string }>('test')
    ctx.data = { input: 'test' }
    const view = createEventView(ctx)

    const pattern = guardrail(innerPattern, {
      rails: [],
      circuitBreaker: {
        maxFailures: 3,
        windowMs: 60000,
        cooldownMs: 30000,
      },
    })

    const result = await pattern.fn(
      { id: 'guardrail', data: ctx.data, events: [], startTime: Date.now() },
      view,
    )

    // Inner pattern should not execute when circuit breaker trips
    expect(innerPattern.fn).not.toHaveBeenCalled()

    const errorEvents = result.events.filter((e) => e.type === 'error')
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(errorEvents[0].data)).toContain('Circuit breaker')
  })

  // sf-M1. Failing OPEN is the right call (a breaker outage must not block
  // every turn) but it used to be indistinguishable from a breaker that is
  // working: the pattern ran unguarded and reported normal operation.
  describe('circuit-breaker fail-open is reported (sf-M1)', () => {
    async function runWithBrokenRedis(): Promise<unknown> {
      const { guardrail, __resetGuardrailBreakerWarnings } =
        await import('../../../../lib/harness-patterns/patterns/guardrail.server')
      const { createContext } = await import('../../../../lib/harness-patterns/context.server')
      const { createEventView } =
        await import('../../../../lib/harness-patterns/patterns/event-view.server')
      __resetGuardrailBreakerWarnings()

      const innerPattern = {
        name: 'inner',
        fn: vi.fn(async (scope: unknown) => scope),
        config: { patternId: 'inner' },
      }
      mockCallTool.mockRejectedValue(new Error('redis unreachable'))

      const ctx = createContext<{ input: string }>('test')
      ctx.data = { input: 'test' }
      const pattern = guardrail(innerPattern as never, {
        rails: [],
        circuitBreaker: { maxFailures: 3, windowMs: 60000, cooldownMs: 30000 },
      })
      await pattern.fn(
        { id: 'guardrail', data: ctx.data, events: [], startTime: Date.now() } as never,
        createEventView(ctx) as never,
      )
      return innerPattern
    }

    it('warns that the breaker can never trip, and still runs the pattern', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const inner = (await runWithBrokenRedis()) as { fn: ReturnType<typeof vi.fn> }

      // Fails OPEN — the wrapped pattern still runs.
      expect(inner.fn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('will never trip'),
      )
      expect(warn.mock.calls[0][0]).toContain('Failing OPEN')
      warn.mockRestore()
    })

    it('warns ONCE, not on every turn', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const { guardrail, __resetGuardrailBreakerWarnings } =
        await import('../../../../lib/harness-patterns/patterns/guardrail.server')
      const { createContext } = await import('../../../../lib/harness-patterns/context.server')
      const { createEventView } =
        await import('../../../../lib/harness-patterns/patterns/event-view.server')
      __resetGuardrailBreakerWarnings()
      mockCallTool.mockRejectedValue(new Error('redis unreachable'))

      const ctx = createContext<{ input: string }>('test')
      ctx.data = { input: 'test' }
      const pattern = guardrail(
        { name: 'inner', fn: vi.fn(async (s: unknown) => s), config: { patternId: 'inner' } } as never,
        { rails: [], circuitBreaker: { maxFailures: 3, windowMs: 60000, cooldownMs: 30000 } },
      )

      // The breaker is consulted on every turn; the warning must not become the
      // noise it is meant to cut through.
      for (let i = 0; i < 4; i++) {
        await pattern.fn(
          { id: 'guardrail', data: ctx.data, events: [], startTime: Date.now() } as never,
          createEventView(ctx) as never,
        )
      }

      expect(warn).toHaveBeenCalledTimes(1)
      warn.mockRestore()
    })
  })

  it('should handle errors in pattern execution', async () => {
    const { guardrail } = await import('../../../../lib/harness-patterns/patterns/guardrail.server')
    const { createContext } = await import('../../../../lib/harness-patterns/context.server')
    const { createEventView } =
      await import('../../../../lib/harness-patterns/patterns/event-view.server')

    const innerPattern = {
      name: 'inner',
      fn: vi.fn().mockRejectedValue(new Error('Inner pattern failed')),
      config: { patternId: 'inner' },
    }

    const ctx = createContext<{ input: string }>('test')
    ctx.data = { input: 'test' }
    const view = createEventView(ctx)

    const pattern = guardrail(innerPattern, { rails: [] })
    const result = await pattern.fn(
      { id: 'guardrail', data: ctx.data, events: [], startTime: Date.now() },
      view,
    )

    const errorEvents = result.events.filter((e) => e.type === 'error')
    expect(errorEvents.length).toBeGreaterThan(0)
    expect(JSON.stringify(errorEvents[0].data)).toContain('Inner pattern failed')
  })
})

describe('common rails', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('piiScanRail', () => {
    it('should detect AWS keys', async () => {
      const { piiScanRail } =
        await import('../../../../lib/harness-patterns/patterns/guardrail.server')

      const result = await piiScanRail.check({
        input: 'my key is AKIAIOSFODNN7EXAMPLE',
        scope: {} as never,
        view: {} as never,
      })

      expect(result.ok).toBe(false)
      expect(result.action).toBe('redact')
      expect(result.reason).toContain('AWS key')
      expect(result.redacted).toContain('[REDACTED:AWS key]')
    })

    it('should detect GitHub tokens', async () => {
      const { piiScanRail } =
        await import('../../../../lib/harness-patterns/patterns/guardrail.server')

      const result = await piiScanRail.check({
        input: 'token: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ123456789012',
        scope: {} as never,
        view: {} as never,
      })

      expect(result.ok).toBe(false)
      expect(result.action).toBe('redact')
      expect(result.reason).toContain('GitHub token')
    })

    it('should detect JWTs', async () => {
      const { piiScanRail } =
        await import('../../../../lib/harness-patterns/patterns/guardrail.server')

      const result = await piiScanRail.check({
        input: 'auth: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0',
        scope: {} as never,
        view: {} as never,
      })

      expect(result.ok).toBe(false)
      expect(result.action).toBe('redact')
      expect(result.reason).toContain('JWT')
    })

    it('should detect private keys', async () => {
      const { piiScanRail } =
        await import('../../../../lib/harness-patterns/patterns/guardrail.server')

      const result = await piiScanRail.check({
        input: '-----BEGIN PRIVATE KEY-----',
        scope: {} as never,
        view: {} as never,
      })

      expect(result.ok).toBe(false)
      expect(result.action).toBe('redact')
      expect(result.reason).toContain('private key')
    })

    it('should pass clean input', async () => {
      const { piiScanRail } =
        await import('../../../../lib/harness-patterns/patterns/guardrail.server')

      const result = await piiScanRail.check({
        input: 'Hello, this is a normal message',
        scope: {} as never,
        view: {} as never,
      })

      expect(result.ok).toBe(true)
    })
  })

  describe('pathAllowlistRail', () => {
    it('should block node_modules paths', async () => {
      const { pathAllowlistRail } =
        await import('../../../../lib/harness-patterns/patterns/guardrail.server')

      const result = await pathAllowlistRail.check({
        input: '',
        scope: {} as never,
        view: {} as never,
        lastToolCall: {
          type: 'tool_call',
          ts: Date.now(),
          patternId: 'test',
          data: { tool: 'read_file', args: { path: '/project/node_modules/secret' } },
        },
      })

      expect(result.ok).toBe(false)
      expect(result.action).toBe('block')
    })

    it('should block .env files', async () => {
      const { pathAllowlistRail } =
        await import('../../../../lib/harness-patterns/patterns/guardrail.server')

      const result = await pathAllowlistRail.check({
        input: '',
        scope: {} as never,
        view: {} as never,
        lastToolCall: {
          type: 'tool_call',
          ts: Date.now(),
          patternId: 'test',
          data: { tool: 'read_file', args: { path: '/project/.env' } },
        },
      })

      expect(result.ok).toBe(false)
      expect(result.action).toBe('block')
    })

    it('should block .git paths', async () => {
      const { pathAllowlistRail } =
        await import('../../../../lib/harness-patterns/patterns/guardrail.server')

      const result = await pathAllowlistRail.check({
        input: '',
        scope: {} as never,
        view: {} as never,
        lastToolCall: {
          type: 'tool_call',
          ts: Date.now(),
          patternId: 'test',
          data: { tool: 'read_file', args: { path: '/project/.git/config' } },
        },
      })

      expect(result.ok).toBe(false)
      expect(result.action).toBe('block')
    })

    it('should allow normal paths', async () => {
      const { pathAllowlistRail } =
        await import('../../../../lib/harness-patterns/patterns/guardrail.server')

      const result = await pathAllowlistRail.check({
        input: '',
        scope: {} as never,
        view: {} as never,
        lastToolCall: {
          type: 'tool_call',
          ts: Date.now(),
          patternId: 'test',
          data: { tool: 'read_file', args: { path: '/project/src/index.ts' } },
        },
      })

      expect(result.ok).toBe(true)
    })

    it('should pass when no path in args', async () => {
      const { pathAllowlistRail } =
        await import('../../../../lib/harness-patterns/patterns/guardrail.server')

      const result = await pathAllowlistRail.check({
        input: '',
        scope: {} as never,
        view: {} as never,
        lastToolCall: {
          type: 'tool_call',
          ts: Date.now(),
          patternId: 'test',
          data: { tool: 'search', args: { query: 'test' } },
        },
      })

      expect(result.ok).toBe(true)
    })
  })

  describe('driftDetectorRail', () => {
    it('should flag large file changes', async () => {
      const { driftDetectorRail } =
        await import('../../../../lib/harness-patterns/patterns/guardrail.server')

      const result = await driftDetectorRail.check({
        input: '',
        scope: {} as never,
        view: {} as never,
        lastToolResult: {
          type: 'tool_result',
          ts: Date.now(),
          patternId: 'test',
          data: {
            tool: 'edit_file',
            success: true,
            result: JSON.stringify({ linesChanged: 80, totalLines: 100 }),
          },
        },
      })

      expect(result.ok).toBe(false)
      expect(result.action).toBe('retry')
      expect(result.reason).toContain('80%')
    })

    it('should pass small changes', async () => {
      const { driftDetectorRail } =
        await import('../../../../lib/harness-patterns/patterns/guardrail.server')

      const result = await driftDetectorRail.check({
        input: '',
        scope: {} as never,
        view: {} as never,
        lastToolResult: {
          type: 'tool_result',
          ts: Date.now(),
          patternId: 'test',
          data: {
            tool: 'edit_file',
            success: true,
            result: JSON.stringify({ linesChanged: 10, totalLines: 100 }),
          },
        },
      })

      expect(result.ok).toBe(true)
    })

    it('should pass non-edit_file results', async () => {
      const { driftDetectorRail } =
        await import('../../../../lib/harness-patterns/patterns/guardrail.server')

      const result = await driftDetectorRail.check({
        input: '',
        scope: {} as never,
        view: {} as never,
        lastToolResult: {
          type: 'tool_result',
          ts: Date.now(),
          patternId: 'test',
          data: {
            tool: 'read_file',
            success: true,
            result: 'file contents',
          },
        },
      })

      expect(result.ok).toBe(true)
    })

    it('should pass failed edit_file results', async () => {
      const { driftDetectorRail } =
        await import('../../../../lib/harness-patterns/patterns/guardrail.server')

      const result = await driftDetectorRail.check({
        input: '',
        scope: {} as never,
        view: {} as never,
        lastToolResult: {
          type: 'tool_result',
          ts: Date.now(),
          patternId: 'test',
          data: {
            tool: 'edit_file',
            success: false,
            result: 'error',
          },
        },
      })

      expect(result.ok).toBe(true)
    })
  })
})
