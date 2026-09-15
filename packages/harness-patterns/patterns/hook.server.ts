/**
 * Hook Pattern
 *
 * Side-effect pattern triggered by lifecycle events.
 * Can run synchronously or as background fire-and-forget.
 */

import { assertServerOnImport } from '../assert.server'
import type {
  ConfiguredPattern,
  PatternConfig
} from '../types'
import { resolveConfig, createEvent, createScope } from '../context.server'

assertServerOnImport()

// ============================================================================
// Types
// ============================================================================

export type HookTrigger = 'session_close' | 'error' | 'approval_timeout' | 'custom'

export interface HookConfig extends PatternConfig {
  trigger: HookTrigger
  /** Run async, don't block response */
  background?: boolean
}

// ============================================================================
// Pattern
// ============================================================================

/**
 * Wrap a pattern as a lifecycle hook.
 *
 * Hooks run the wrapped pattern but can optionally run in the background
 * without blocking the main chain. Useful for session cleanup, distillation,
 * logging, etc.
 *
 * @param pattern - The pattern to run as a hook
 * @param config - Hook configuration (trigger, background)
 * @returns ConfiguredPattern ready for chain
 *
 * @example
 * const distillHook = hook(distillChain, {
 *   patternId: 'session-close-hook',
 *   trigger: 'session_close',
 *   background: true
 * })
 */
export function hook<T extends Record<string, unknown>>(
  pattern: ConfiguredPattern<T>,
  config: HookConfig
): ConfiguredPattern<T> {
  const resolved = resolveConfig('hook', config)

  return {
    name: `hook:${config.trigger}(${pattern.name})`,
    fn: async (scope, view) => {
      try {
        const innerPatternId = pattern.config.patternId ?? pattern.name

        if (config.background) {
          // Fire-and-forget: schedule for execution after response. Uses a
          // detached child scope so the hook's events (if anything ever
          // reads them) are tagged with the hook's patternId, not the
          // outer pattern's. Mirrors the sync path below.
          queueMicrotask(async () => {
            try {
              const childScope = createScope(innerPatternId, scope.data) as typeof scope
              await pattern.fn(childScope, view)
            } catch (e) {
              console.error(`Hook ${config.trigger} failed:`, e)
            }
          })
          return scope
        }

        // Synchronous: run wrapped pattern in a fresh child scope so its
        // events carry its own patternId. Without this, the wrapped
        // pattern's events are tagged with the hook's id and become
        // invisible to `view.fromLastPattern()`. Mirrors
        // `with-references.server.ts`'s child-scope wrapping.
        const childScope = createScope(innerPatternId, scope.data) as typeof scope
        const result = await pattern.fn(childScope, view)

        // Wrap inner pattern events with enter/exit markers and merge back
        scope.events.push(createEvent('pattern_enter', innerPatternId, { pattern: pattern.name }))
        scope.events.push(...result.events)
        scope.events.push(createEvent('pattern_exit', innerPatternId, { status: 'completed' }))
        scope.data = { ...scope.data, ...result.data }

        return scope
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        // Hooks should not block the main flow on error
        console.error(`Hook ${config.trigger} error:`, msg)
        return scope
      }
    },
    config: resolved,
    // Background hooks don't add perceived turns; sync hooks delegate to child.
    estimateTurns: (s) =>
      config.background ? 0 : pattern.estimateTurns?.(s) ?? 1,
    children: [pattern]
  }
}
