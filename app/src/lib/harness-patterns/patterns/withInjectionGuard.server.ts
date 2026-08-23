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
import { emitLive } from '../live-event-context.server'
import {
  getActiveInjectionGuard,
  runWithInjectionGuard,
  type ActiveInjectionGuard,
} from '../injection-guard-scope.server'
import {
  applyScreenVerdict,
  redactReport,
  sanitizeUntrusted,
  strictestSpotlight,
  type InjectionGuardOptions,
  type InjectionRule,
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
  // UNION with any outer guard, never shadow it. ALS nesting would otherwise
  // let an inner `withInjectionGuard({ namespaces: ['graph'] })` silently
  // REMOVE the outer wrapper's `web` protection for its whole subtree — the one
  // composition mistake a security control must not permit. Widening is always
  // safe; narrowing is what needs an explicit decision, and there is no way to
  // ask for it (deliberately).
  const outer = getActiveInjectionGuard()
  const namespaces = new Set(config.namespaces ?? [])
  const tools = new Set(config.tools ?? [])
  warnOnUnmatchableNamespaces(namespaces)

  const isUntrusted = (tool: string): boolean =>
    tools.has(tool) || namespaces.has(inferServer(tool)) || (outer?.isUntrusted(tool) ?? false)

  // The SANITIZER options are unioned on exactly the same charter as
  // `isUntrusted` above — and unioning the namespaces alone was not enough.
  // Once an inner guard widens the boundary, its `config` is what sanitizes the
  // OUTER guard's namespaces too, so an inner `disableRules` or a weaker
  // `spotlight` re-opened a hole for tools the inner wrapper never mentioned.
  const options = unionOptions(config, outer?.options)

  return {
    isUntrusted,
    options,

    async sanitize(tool, data, overrides) {
      if (!isUntrusted(tool)) return { data }

      const namespace = inferServer(tool)
      // Per-CALL overrides still win: they are a deliberate, local decision by a
      // known call site (the retriever's `spotlight: 'off'` on a filename), not
      // an agent-level config that could silently weaken a nested boundary.
      const effective = overrides ? { ...options, ...overrides } : options
      let { data: out, report } = sanitizeUntrusted(data, { tool, namespace }, effective)

      // The optional LLM screen is a SECOND OPINION on content the
      // deterministic layer passed clean — if regexes already fired we have
      // neutralized and fenced the content, and a second call would buy
      // nothing. Its failure is non-fatal: a screen that throws (rate limit,
      // timeout) must not turn a working tool call into an error, so the
      // deterministic verdict stands and the reason is recorded.
      //
      // Gated on FINDINGS, not on `report.neutralized`: with
      // `spotlight: 'always'` every result comes back "neutralized" (it was
      // fenced), which silently switched the screen off entirely for the agents
      // that asked for the STRICTEST setting — a fail-open the tests now pin.
      if (options.screen && report.findings.length === 0) {
        try {
          const verdict = await options.screen({
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

      if (report.findings.length === 0) {
        // Nothing was DETECTED. `out` may still differ from `data` — a bare
        // `spotlight: 'always'` fence — and that rewritten content is returned
        // either way, so the caller never loses the fence.
        //
        // What it does NOT get is a finding-less `content_sanitized` event: with
        // `spotlight: 'always'` that fired on every single tool result, and the
        // ObservabilityPanel renders it as "0 neutralized ()" — pure noise that
        // buries the events where the guard actually caught something. The fence
        // needs no annotation anyway; it states its own provenance in the text.
        if (report.screenReason) {
          // A screen OUTAGE is the exception: a silently degraded second layer
          // must be visible rather than invisible.
          const event = buildEvent(patternId, report)
          emit(event)
          return { data: out, summary: redactReport(report, event.id) }
        }
        return { data: out }
      }

      const event = buildEvent(patternId, report)
      emit(event)
      // The REDACTED summary goes back to the caller (and onto the tool_result
      // event); the verbatim spans stay on `event` alone. See `SanitizeSummary`.
      return { data: out, summary: redactReport(report, event.id) }
    },
  }
}

/** Declared namespaces already reported, so a per-turn pattern build doesn't
 *  repeat the warning for the whole process lifetime. */
const warnedNamespaces = new Set<string>()

/**
 * Warn about a declared namespace that can never match anything.
 *
 * `isUntrusted` asks `namespaces.has(inferServer(tool))`, so the only strings
 * that can ever match are the ones `inferServer` actually PRODUCES — i.e. its
 * fixed points. Catalog/server names are not: `inferServer('web_search')` is
 * `'web'`, `inferServer('rust-mcp-filesystem')` is `'rust'`,
 * `inferServer('database-server')` is `'database'` (the same three renames
 * `tool-config/server-catalog.server.ts` keeps in `NAMESPACE_TO_SERVER`). So
 * `namespaces: ['web_search']` type-checks, reads like protection, and
 * sanitizes exactly nothing — the failure mode a security control must never
 * have (sf-H5).
 *
 * The check is a fixed-point test rather than a live-catalog lookup on purpose:
 * it is synchronous, needs no gateway, and cannot false-positive on a server
 * that merely happens to be disabled right now. It cannot catch a plausible-
 * but-nonexistent namespace (`'wikipedia'`), only one that is unmatchable *by
 * construction* — which is the whole of the reported class.
 */
function warnOnUnmatchableNamespaces(namespaces: Set<string>): void {
  for (const ns of namespaces) {
    const canonical = inferServer(ns)
    if (canonical === ns || warnedNamespaces.has(ns)) continue
    warnedNamespaces.add(ns)
    console.warn(
      `[withInjectionGuard] declared namespace '${ns}' can never match a tool: ` +
        `inferServer('${ns}') is '${canonical}'. NOTHING is being sanitized for it — ` +
        `declare '${canonical}' instead, or list the exact tool names under \`tools\`.`,
    )
  }
}

/** Test-only: forget which namespaces have already been warned about. */
export function __resetInjectionGuardNamespaceWarnings(): void {
  warnedNamespaces.clear()
}

/**
 * Merge a guard's own sanitizer options with the enclosing guard's, taking the
 * STRICTEST of each. Every arm exists because the loose version was a way for a
 * nested guard to weaken a boundary it did not own:
 *
 *   - `disableRules` INTERSECTS. A rule is only switched off if every guard in
 *     the nest agreed to switch it off. `disableRules` is a false-positive
 *     escape hatch for one agent's corpus; inheriting it outward would let that
 *     agent's exemption apply to the outer wrapper's namespaces.
 *   - `rules` UNION (deduped by id) — extra detection is always safe to inherit.
 *   - `spotlight` takes the strictest mode (`always` > `on-detection` > `off`).
 *   - `screen` is kept if EITHER guard has one; a nested guard cannot remove the
 *     outer wrapper's paid-for second layer. The inner one wins when both are
 *     set, since it is the more specific declaration.
 */
function unionOptions(
  own: InjectionGuardOptions,
  outer: InjectionGuardOptions | undefined,
): InjectionGuardOptions {
  if (!outer) return own

  const outerDisabled = new Set(outer.disableRules ?? [])
  const disableRules = (own.disableRules ?? []).filter((id) => outerDisabled.has(id))

  const byId = new Map<string, InjectionRule>()
  for (const r of [...(outer.rules ?? []), ...(own.rules ?? [])]) byId.set(r.id, r)

  return {
    ...own,
    disableRules,
    ...(byId.size > 0 ? { rules: [...byId.values()] } : {}),
    spotlight: strictestSpotlight(own.spotlight, outer.spotlight),
    screen: own.screen ?? outer.screen,
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
      const guard = createInjectionGuard(
        config,
        (event) => {
          scope.events.push(event)
          // `trackEvent` is what normally calls `emitLive`, and we bypass it —
          // so call it here, or a guardrail firing would be the ONE event
          // missing from the live SSE stream, arriving only in `runChain`'s
          // post-commit sweep after the whole pattern finished. It is also the
          // only copy that survives if the inner pattern THROWS, since a throw
          // skips `commitEvents` entirely and discards the scope.
          emitLive(event)
        },
        patternId,
      )
      return runWithInjectionGuard(guard, () => pattern.fn(scope, view))
    }

    return {
      ...pattern,
      name: `withInjectionGuard(${pattern.name})`,
      fn,
      // Expose the wrapped pattern so static introspection (pattern-capabilities)
      // still sees patterns nested inside the guard.
      children: [pattern],
      // Declared trust boundary, readable without running the agent. See
      // `ConfiguredPattern.injectionGuard` for why this is a sibling field
      // rather than something on `config`.
      injectionGuard: {
        namespaces: [...(config.namespaces ?? [])],
        tools: [...(config.tools ?? [])],
      },
    }
  }
}
