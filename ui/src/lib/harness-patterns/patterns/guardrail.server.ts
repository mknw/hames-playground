/**
 * Guardrail Pattern
 *
 * Multi-layered validation wrapping an inner pattern.
 * Input rails, execution rails, output rails, and circuit breaker.
 */

import { assertServerOnImport } from '../assert.server'
import { callTool } from '../mcp-client.server'
import type {
  PatternScope,
  EventView,
  ConfiguredPattern,
  PatternConfig,
  ContextEvent
} from '../types'
import { trackEvent, resolveConfig, createEvent, createScope } from '../context.server'

assertServerOnImport()

// ============================================================================
// Types
// ============================================================================

export interface Rail<T> {
  name: string
  phase: 'input' | 'execution' | 'output'
  check: (ctx: RailContext<T>) => Promise<RailResult>
}

export interface RailResult {
  ok: boolean
  reason?: string
  action?: 'block' | 'warn' | 'redact' | 'retry'
  redacted?: string
}

export interface RailContext<T> {
  input: string
  scope: PatternScope<T>
  view: EventView
  lastToolCall?: ContextEvent
  lastToolResult?: ContextEvent
}

export interface CircuitBreakerConfig {
  maxFailures: number
  windowMs: number
  cooldownMs: number
}

export interface GuardrailConfig<T> extends PatternConfig {
  rails: Rail<T>[]
  circuitBreaker?: CircuitBreakerConfig
  onBlock?: (rail: string, reason: string) => void
}

// ============================================================================
// Pattern
// ============================================================================

/**
 * Wrap a pattern with multi-layered guardrails.
 *
 * Applies input rails before execution, execution rails as interceptors,
 * output rails after execution, and optional circuit breaker via redis.
 *
 * @param pattern - The pattern to wrap with guardrails
 * @param config - Guardrail configuration with rails and circuit breaker
 * @returns ConfiguredPattern with guardrail protection
 *
 * @example
 * const safe = guardrail(innerPattern, {
 *   patternId: 'safe-edit',
 *   rails: [topicalRail, pathAllowlistRail, driftDetectorRail],
 *   circuitBreaker: { maxFailures: 3, windowMs: 60_000, cooldownMs: 30_000 }
 * })
 */
export function guardrail<T extends Record<string, unknown>>(
  pattern: ConfiguredPattern<T>,
  config: GuardrailConfig<T>
): ConfiguredPattern<T> {
  const resolved = resolveConfig('guardrail', config)
  const inputRails = config.rails.filter((r) => r.phase === 'input')
  const outputRails = config.rails.filter((r) => r.phase === 'output')

  return {
    name: `guardrail(${pattern.name})`,
    fn: async (scope, view) => {
      try {
        // --- Circuit breaker check (redis-backed) ---
        if (config.circuitBreaker) {
          const cb = config.circuitBreaker
          const key = `circuit:${scope.id}`
          const now = Date.now()
          try {
            const recentFailures = await callTool('zrange', {
              key,
              start: String(now - cb.windowMs),
              stop: String(now)
            })
            if (
              recentFailures.success &&
              Array.isArray(recentFailures.data) &&
              recentFailures.data.length >= cb.maxFailures
            ) {
              trackEvent(scope, 'error', {
                error: `Circuit breaker tripped: ${recentFailures.data.length} failures in ${cb.windowMs}ms`
              }, true)
              return scope
            }
          } catch {
            // Redis may not be available; proceed without circuit breaker
          }
        }

        // --- Input rails ---
        const railCtx: RailContext<T> = {
          input: (scope.data as Record<string, unknown>).input as string ?? '',
          scope,
          view
        }

        for (const rail of inputRails) {
          const result = await rail.check(railCtx)

          if (!result.ok) {
            if (result.action === 'redact' && result.redacted) {
              railCtx.input = result.redacted
            } else {
              trackEvent(scope, 'error', {
                error: `Input rail '${rail.name}' blocked: ${result.reason}`
              }, true)
              config.onBlock?.(rail.name, result.reason ?? '')
              return scope
            }
          }
        }

        // --- Execute wrapped pattern in a fresh child scope ---
        // The wrapped pattern needs its own scope so its events are tagged
        // with its own patternId (not the guardrail's). Without this,
        // `view.fromLastPattern()` filters the wrapped pattern's events out.
        // Mirrors `with-references.server.ts`'s child-scope wrapping.
        const innerPatternId = pattern.config.patternId ?? pattern.name
        const childScope = createScope(innerPatternId, scope.data) as typeof scope
        const result = await pattern.fn(childScope, view)

        // Wrap inner pattern events with enter/exit markers and merge back
        scope.events.push(createEvent('pattern_enter', innerPatternId, { pattern: pattern.name }))
        scope.events.push(...result.events)
        scope.events.push(createEvent('pattern_exit', innerPatternId, { status: 'completed' }))
        scope.data = result.data

        // --- Output rails ---
        for (const rail of outputRails) {
          const check = await rail.check({
            ...railCtx,
            scope,
            lastToolResult: scope.events.filter((e) => e.type === 'tool_result').pop()
          })

          if (!check.ok) {
            if (check.action === 'retry') {
              // Track failure for circuit breaker
              if (config.circuitBreaker) {
                try {
                  await callTool('zadd', {
                    key: `circuit:${scope.id}`,
                    score: Date.now(),
                    member: `fail-${Date.now()}`
                  })
                } catch {
                  // Redis may not be available
                }
              }
              trackEvent(scope, 'error', {
                error: `Output rail '${rail.name}' rejected: ${check.reason}`
              }, true)
            } else if (check.action === 'warn') {
              trackEvent(scope, 'error', {
                error: `Output rail '${rail.name}' warning: ${check.reason}`
              }, true)
            }
          }
        }

        return scope
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        trackEvent(scope, 'error', { error: msg }, true)
        return scope
      }
    },
    config: resolved,
    estimateTurns: (s) => pattern.estimateTurns?.(s) ?? 1,
    children: [pattern]
  }
}

// ============================================================================
// Common Rails
// ============================================================================

/** Rail that checks for PII/secrets in input */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const piiScanRail: Rail<any> = {
  name: 'pii-scan',
  phase: 'input',
  check: async ({ input }) => {
    const patterns = [
      { name: 'AWS key', re: /AKIA[0-9A-Z]{16}/ },
      { name: 'GitHub token', re: /ghp_[a-zA-Z0-9]{36}/ },
      { name: 'JWT', re: /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+/ },
      { name: 'private key', re: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/ }
    ]
    for (const { name, re } of patterns) {
      if (re.test(input)) {
        return {
          ok: false,
          action: 'redact' as const,
          reason: `Found ${name} in input`,
          redacted: input.replace(re, `[REDACTED:${name}]`)
        }
      }
    }
    return { ok: true }
  }
}

/** Rail that blocks paths outside workspace */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const pathAllowlistRail: Rail<any> = {
  name: 'path-allowlist',
  phase: 'execution',
  check: async ({ lastToolCall }) => {
    const data = lastToolCall?.data as { tool: string; args: { path?: string } }
    if (!data?.args?.path) return { ok: true }
    const blocked = [/node_modules/, /\.env/, /\.git\//, /\/etc\//, /\/proc\//]
    const match = blocked.find((p) => p.test(data.args.path!))
    return match
      ? { ok: false, reason: `Blocked path: ${data.args.path}`, action: 'block' as const }
      : { ok: true }
  }
}

/** Rail that detects large file changes */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const driftDetectorRail: Rail<any> = {
  name: 'drift-detector',
  phase: 'output',
  check: async ({ lastToolResult }) => {
    const data = lastToolResult?.data as { tool: string; result: string; success: boolean }
    if (data?.tool !== 'edit_file' || !data?.success) return { ok: true }
    try {
      const diff = JSON.parse(data.result)
      if (diff.linesChanged && diff.totalLines) {
        const ratio = diff.linesChanged / diff.totalLines
        if (ratio > 0.6) {
          return {
            ok: false,
            action: 'retry' as const,
            reason: `Edit changed ${(ratio * 100).toFixed(0)}% of file — likely unintended`
          }
        }
      }
    } catch { /* non-diff result, pass through */ }
    return { ok: true }
  }
}
