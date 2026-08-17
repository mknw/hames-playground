/**
 * `withInjectionGuard` — the composable primitive that protects an agent from
 * prompt injection carried in untrusted tool results.
 *
 * ## Why a wrapper and not a chain step
 *
 * A pattern placed IN a chain runs before or after the loop, so it can only
 * ever see tool results that have already been fed to the controller. Prompt
 * injection has to be stopped mid-loop, on the turn the content arrives. So
 * this is an AsyncLocalStorage wrapper in the shape of `withSandbox`: it
 * attaches a guard for the wrapped pattern's lifetime, and the enforcement
 * happens at the two points where untrusted content is actually produced
 * (`callTool`, and the retriever's own result assembly). Nothing in between —
 * `chain`, `router`, `routes`, `parallel`, `withReferences` — needs to know.
 *
 * ## Why not the existing `guardrail()` pattern
 *
 * `guardrail(pattern, { rails })` is a different tool for a different job and
 * cannot do this one: its output rails run only AFTER the inner pattern has
 * fully completed (by which point every injected instruction has already been
 * through the controller), and a `RailResult` can block, warn or retry but
 * never REWRITE content. Note also that its `phase: 'execution'` rails are
 * never dispatched, and its input rails read `scope.data.input`, which nothing
 * in the framework populates.
 *
 * ## Config transparency
 *
 * The wrapper spreads `...pattern`, so the inner pattern's `config`
 * (commitStrategy, trackHistory, viewConfig, estimateTurns) governs everything
 * exactly as it did unwrapped, and the inner pattern runs in the SAME scope —
 * no extra `pattern_enter`/`pattern_exit` noise, no change to
 * `view.fromLastPattern()` resolution. The only observable difference on a
 * clean run is nothing at all; on detection, a `content_sanitized` event and a
 * `sanitized` annotation on the affected `tool_result`.
 */

import { assertServerOnImport } from '../assert.server'
import { createEvent } from '../context.server'
import { runWithInjectionGuard, type ActiveInjectionGuard } from '../injection-guard-scope.server'
import {
  applyScreenVerdict,
  sanitizeUntrusted,
  type InjectionGuardOptions,
  type SanitizeReport,
} from '../injection-guard'
import { inferServer } from '../tools.server'
import type {
  ConfiguredPattern,
  ContentSanitizedEventData,
  ContextEvent,
  PatternScope,
} from '../types'

assertServerOnImport()

// ============================================================================
// Config
// ============================================================================

export interface InjectionGuardConfig extends InjectionGuardOptions {
  /**
   * Tool namespaces whose results are UNTRUSTED — the names `inferServer()`
   * produces (`'web'`, `'graph'`, `'filesystem'`, `'retriever'`, …). Declare
   * these at the agent definition, not via a shared default: which sources an
   * agent treats as untrusted is a property of that agent's threat model and
   * should be readable where the agent is defined.
   */
  namespaces?: string[]
  /**
   * Explicit tool names to treat as untrusted, in addition to `namespaces`.
   * For a single hostile tool inside an otherwise trusted namespace.
   */
  tools?: string[]
}

// ============================================================================
// Guard construction
// ============================================================================

/**
 * Build the guard object the ALS readers consult. Exported for tests and for
 * callers that need a guard without a pattern to wrap.
 *
 * `emit` receives a fully-formed `content_sanitized` event; the wrapper points
 * it at the live scope so findings interleave with the tool events they
 * describe in real time order.
 */
export function createInjectionGuard(
  config: InjectionGuardConfig,
  emit: (event: ContextEvent) => void,
  patternId: string,
): ActiveInjectionGuard {
  const namespaces = new Set(config.namespaces ?? [])
  const tools = new Set(config.tools ?? [])

  const isUntrusted = (tool: string): boolean =>
    tools.has(tool) || namespaces.has(inferServer(tool))

  return {
    isUntrusted,

    async sanitize(tool, data) {
      if (!isUntrusted(tool)) return { data }

      const namespace = inferServer(tool)
      let { data: out, report } = sanitizeUntrusted(data, { tool, namespace }, config)

      // The optional LLM screen is a SECOND OPINION on content the
      // deterministic layer passed clean — if regexes already fired we have
      // neutralized and fenced the content, and a second call would buy
      // nothing. Its failure is non-fatal: a screen that throws (rate limit,
      // timeout) must not turn a working tool call into an error, so the
      // deterministic verdict stands and the reason is recorded.
      if (config.screen && !report.neutralized) {
        try {
          const verdict = await config.screen({
            tool,
            namespace,
            content: typeof data === 'string' ? data : JSON.stringify(data),
          })
          if (verdict.injection_detected) {
            const screened = applyScreenVerdict(data, verdict, { tool, namespace }, report)
            out = screened.data
            report = screened.report
          }
        } catch (err) {
          report = {
            ...report,
            screenReason: `screen unavailable: ${err instanceof Error ? err.message : String(err)}`,
          }
        }
      }

      if (!report.neutralized) {
        // Nothing changed. Still surface a screen outage, so a silently
        // degraded second layer is visible rather than invisible.
        if (report.screenReason) emit(buildEvent(patternId, report))
        return { data }
      }

      emit(buildEvent(patternId, report))
      return { data: out, report }
    },
  }
}

function buildEvent(patternId: string, report: SanitizeReport): ContextEvent {
  return createEvent('content_sanitized', patternId, {
    tool: report.tool,
    namespace: report.namespace,
    findings: report.findings,
    neutralized: report.neutralized,
    spotlighted: report.spotlighted,
    scanned: report.scanned,
    ...(report.screenReason ? { screenReason: report.screenReason } : {}),
  } as ContentSanitizedEventData)
}

// ============================================================================
// Pattern
// ============================================================================

/**
 * Wrap a pattern so every untrusted tool result produced inside it is
 * sanitized before it can reach an LLM-visible surface.
 *
 * @example
 * withInjectionGuard({ namespaces: ['web'] })(
 *   simpleLoop(webController, tools.web, { patternId: 'web-search' }),
 * )
 *
 * @example
 * // Guards every route at once — the ALS scope reaches nested patterns.
 * withInjectionGuard({ namespaces: ['web', 'graph'] })(routes({ … }))
 */
export function withInjectionGuard(config: InjectionGuardConfig) {
  return <T>(pattern: ConfiguredPattern<T>): ConfiguredPattern<T> => {
    const patternId = pattern.config.patternId ?? pattern.name

    const fn = (scope: PatternScope<T>, view: Parameters<typeof pattern.fn>[1]) => {
      // Push directly rather than via `trackEvent`: a loop's `trackHistory` is
      // `['controller_action','tool_call','tool_result']`, which would filter a
      // guardrail firing out of existence. A security event is not optional
      // history — `content_sanitized` is in ALWAYS_COMMIT_TYPES for the same
      // reason `error` is.
      const guard = createInjectionGuard(config, (event) => scope.events.push(event), patternId)
      return runWithInjectionGuard(guard, () => pattern.fn(scope, view))
    }

    return {
      ...pattern,
      name: `withInjectionGuard(${pattern.name})`,
      fn,
      // Expose the wrapped pattern so static introspection (pattern-capabilities)
      // still sees patterns nested inside the guard.
      children: [pattern],
    }
  }
}
