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
 * ## Why not a rails-style pre/post check
 *
 * A check that runs before or after a pattern sees content only after the model
 * has, and cannot rewrite it mid-loop — which is the whole job here (ADR-0006).
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
import { isDegradedToolSurface } from '../gateway-health.server'
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
   * produces (`'web'`, `'graph'`, `'filesystem'`, …). Declare
   * these at the agent definition, not via a shared default: which sources an
   * agent treats as untrusted is a property of that agent's threat model and
   * should be readable where the agent is defined. Each declared namespace
   * is VERIFIED at construction against `catalog` — a namespace no catalog
   * name produces refuses the guard (#242 item 4). A source that never rides
   * a tool name (the retriever's own sanitize key) is declared under
   * `tools` by exact name instead. An explicit `namespaces: []` is the
   * deliberate "this agent trusts everything it calls" line.
   */
  namespaces?: string[]
  /**
   * Explicit tool names to treat as untrusted, in addition to `namespaces`.
   * For a single hostile tool inside an otherwise trusted namespace, and for
   * sanitize keys that are not namespaces at all (`'retriever'`) — exact
   * names need no catalog evidence: they match by literal membership.
   */
  tools?: string[]
  /**
   * The tool-name catalog to validate `namespaces` against at construction —
   * the `tools.all` the agent just built with `Tools()`, passed by every
   * production agent (#225 L5). REQUIRED whenever `namespaces` is non-empty:
   * a declaration the guard cannot verify against the tool names it will
   * actually see is refused like an unmatchable one (#242 item 4). Without
   * this argument the second check has no name universe to walk. The
   * namespace also rides `SanitizeSummary`/`injectionGuard` projections,
   * which carry counts and ids only (SD-3), so this is a label input, never a
   * content input.
   */
  catalog?: string[]
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
  // A guard that declares neither namespaces nor tools covers nothing and
  // would read as protection while doing none (#242 item 4). Omission is not
  // indistinguishable from decision: `namespaces: []` is the explicit line
  // that says "this agent trusts everything it calls", and it still unions
  // with any outer guard (SD-5).
  if (
    config.namespaces === undefined &&
    (config.tools === undefined || config.tools.length === 0)
  ) {
    throw new Error(
      `[withInjectionGuard] the guard declares no namespaces and no tools, so it ` +
        `would sanitize nothing. Declare the namespaces it must screen, or write ` +
        '`namespaces: []` explicitly if this agent trusts everything it calls.',
    )
  }
  // REQUIRED whenever namespaces are declared: a declaration the guard cannot
  // verify against the tool names it will actually see is refused below like
  // an unmatchable one (#242 item 4).
  const namespaces = new Set(config.namespaces ?? [])
  const tools = new Set(config.tools ?? [])
  if (namespaces.size > 0) {
    if (!config.catalog) {
      throw new Error(
        `[withInjectionGuard] namespaces are declared but no catalog was passed. ` +
          `Pass \`catalog: tools.all\` (the ToolSet you just built with \`Tools()\`) ` +
          `so the guard can verify every declared namespace is actually produced — ` +
          `an unverifiable boundary is refused, not trusted. (#242 item 4)`,
      )
    }
    refuseUnmatchableNamespaces(namespaces, config.catalog)
  }

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
 *  repeat the degraded-surface warning for the whole process lifetime. */
const warnedNamespaces = new Set<string>()

/**
 * REFUSE a guard whose declared namespaces cannot be verified (#242 item 4).
 *
 * `isUntrusted` asks `namespaces.has(inferServer(tool))`, so the only strings
 * that can ever match are the ones `inferServer` actually PRODUCES. A
 * namespace nothing produces is a guard that is present, reports green, and
 * neutralizes nothing — the exact failure mode the extraction shipped to
 * external consumers, where the catalog lives in a third package nobody is
 * obliged to register. The repo's rule everywhere else applies here: fail
 * closed, at the seam where the catalog is in hand, before any LLM call.
 *
 * Three cases, each its own decision:
 *
 * 1. **Fixed-point violation** — the declared string is not a fixed point of
 *    `inferServer`: `inferServer('web_search')` is `'web'`,
 *    `inferServer('rust-mcp-filesystem')` is `'rust'`. It type-checks, reads
 *    like protection, and sanitizes exactly nothing (sf-H5). Always refused:
 *    a string property of the config, independent of any catalog, with zero
 *    false positives.
 * 2. **Healthy catalog, nothing produces the namespace** — the string IS a
 *    fixed point (`inferServer('wikipedia') === 'wikipedia'`), yet no name in
 *    the catalog resolves to it. This is the unregistered-catalog signature:
 *    the gateway answered its 86 names and none lands in the declared
 *    namespace, because `registerToolNamespaces(mcpNamespace)` never ran.
 *    Refused, with a message naming the registration and the package that
 *    exports it.
 * 3. **Degraded surface** (#278 F1) — the catalog itself was built while the
 *    gateway was unreachable (`isDegradedToolSurface`), so it is amputated by
 *    provenance, not by misregistration. No untrusted tool can be reached
 *    through it, so a refusal here would fail a turn for an outage that costs
 *    the guard nothing and contradict #276's "one dead transport must not take
 *    a turn down". The deduped warning stays for exactly this case.
 *
 * The catalog is REQUIRED whenever namespaces are declared (checked by the
 * caller): a declaration the guard cannot verify is refused like an
 * unmatchable one.
 */
function refuseUnmatchableNamespaces(namespaces: Set<string>, catalog: string[]): void {
  for (const ns of namespaces) {
    const canonical = inferServer(ns)
    if (canonical !== ns) {
      throw new Error(
        `[withInjectionGuard] declared namespace '${ns}' can never match a tool: ` +
          `inferServer('${ns}') is '${canonical}'. Refusing to build a guard that ` +
          `would sanitize nothing — declare '${canonical}' instead, or list the exact ` +
          `tool names under \`tools\`. (#242 item 4)`,
      )
    }
    if (!catalog.some((tool) => inferServer(tool) === ns)) {
      if (isDegradedToolSurface(catalog)) {
        // Outage-provenance amputation, not misregistration: warn, deduped.
        if (warnedNamespaces.has(ns)) continue
        warnedNamespaces.add(ns)
        console.warn(
          `[withInjectionGuard] declared namespace '${ns}' matches no tool in the ` +
            `current catalog (${catalog.length} names), which was built while the ` +
            `gateway was unreachable — the guard cannot verify it this turn. If the ` +
            `namespace is real, this is the outage, not a missing registration.`,
        )
        continue
      }
      throw new Error(
        `[withInjectionGuard] declared namespace '${ns}' matches no tool in the ` +
          `catalog (${catalog.length} names). NOTHING would be sanitized for it — ` +
          `most likely the tool→namespace resolver was never registered: call ` +
          `\`registerToolNamespaces(mcpNamespace)\` once at boot (the resolver ships ` +
          `in \`@hames/connectors/mcp-catalog\`). If the gateway is down instead, the ` +
          `degraded-surface provenance (#278 F1) suppresses this refusal. (#242 item 4)`,
      )
    }
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
 * The declared namespaces are VERIFIED against `catalog` at construction —
 * a namespace nothing produces refuses the guard (#242 item 4), so pass the
 * `tools.all` the pattern's tools were built from.
 *
 * @example
 * withInjectionGuard({ namespaces: ['web'], catalog: tools.all })(
 *   simpleLoop(webController, tools.web, { patternId: 'web-search' }),
 * )
 *
 * @example
 * // Guards every route at once — the ALS scope reaches nested patterns.
 * withInjectionGuard({ namespaces: ['web', 'graph'], catalog: tools.all })(
 *   routes({ … }),
 * )
 */
export function withInjectionGuard(config: InjectionGuardConfig) {
  return <T>(pattern: ConfiguredPattern<T>): ConfiguredPattern<T> => {
    const patternId = pattern.config.patternId ?? pattern.name

    const fn = (scope: PatternScope<T>, view: Parameters<typeof pattern.fn>[1]) => {
      // Push directly rather than via `trackEvent`: a loop's `trackHistory` is
      // `['controller_action','tool_call','tool_result']`, which would filter a
      // guard firing out of existence. A security event is not optional
      // history — `content_sanitized` is in ALWAYS_COMMIT_TYPES for the same
      // reason `error` is.
      const guard = createInjectionGuard(
        config,
        (event) => {
          scope.events.push(event)
          // `trackEvent` is what normally calls `emitLive`, and we bypass it —
          // so call it here, or a guard firing would be the ONE event
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
