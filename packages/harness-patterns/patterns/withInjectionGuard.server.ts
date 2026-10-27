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
import { createEvent, createModelCallEvent, redactCall } from '../context.server'
import { emitLive } from '../live-event-context.server'
import { amendRunFrame, currentRunFrame, resolveByTier } from '../run-frame.server'
import { resumableStep, wrapperResumable } from '../resume.server'
import {
  applyScreenVerdict,
  redactReport,
  sanitizeUntrusted,
  SCREEN_WITHHELD,
  type ActiveInjectionGuard,
  type IngressClass,
  type IngressClassifier,
  type InjectionGuardOptions,
  type InjectionScreenConfig,
  type SanitizeReport,
  type ScreenMode,
} from '../injection-guard'
import { inferServer } from '../tools.server'
import { isDegradedToolSurface } from '../gateway-health.server'
import type {
  ByTier,
  ConfiguredPattern,
  ContentSanitizedEventData,
  ContextEvent,
  DecisionMadeEventData,
  LLMCallRecord,
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
  // COVERAGE unions with any outer guard, never shadows it. ALS nesting would
  // otherwise let an inner `withInjectionGuard({ namespaces: ['graph'] })`
  // silently REMOVE the outer wrapper's `web` protection for its whole subtree —
  // the one composition mistake a security control must not permit. Widening is
  // always safe; narrowing is what needs an explicit decision, and there is no
  // way to ask for it (deliberately). OPTIONS do not union: a tool is sanitized
  // with the options of the guard that DECLARED it (see `optionsFor` below).
  const outer = currentRunFrame()?.guard
  // A guard that declares neither namespaces nor tools covers nothing and
  // would read as protection while doing none (#242 item 4). Omission is not
  // indistinguishable from decision: `namespaces: []` is the explicit line
  // that says "this agent trusts everything it calls", and its coverage still
  // unions with any outer guard (SD-5).
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

  const declares = (tool: string): boolean => tools.has(tool) || namespaces.has(inferServer(tool))
  const isUntrusted = (tool: string): boolean =>
    declares(tool) || (outer?.isUntrusted(tool) ?? false)

  // A tool is sanitized with the options of the INNERMOST guard that declares
  // it. A guard that does not declare the tool hands the question outward, so
  // the options that govern an outer guard's namespace are always that guard's
  // own: an inner `disableRules`, a weaker `spotlight` or a missing `screen`
  // cannot reach a tool the inner wrapper never mentioned, and an outer
  // `screen` is not inherited by a tool the inner guard declares. Each guard's
  // declaration is therefore readable where the guard is written. The fallback
  // is this guard's own options for a tool nobody declares, which `sanitize`
  // never asks about.
  const optionsFor = (tool: string): InjectionGuardOptions =>
    declares(tool) ? config : (outer?.optionsFor(tool) ?? config)

  if (config.screen) refuseUnreadableScreen(config.screen, namespaces)

  /** The gate's answer as a `decision_made` event in the live scope, its call
   *  record redacted (the gate's state is the payload it read). Best effort, like
   *  the screen's `model_call`: a recording failure never changes a verdict. */
  const recordGateDecision = (event: DecisionMadeEventData, call?: LLMCallRecord): void => {
    try {
      emit(createEvent('decision_made', patternId, event, redactCall(call)))
    } catch (recordErr) {
      console.error(
        '[withInjectionGuard] recording the gate decision failed; the verdict is unaffected:',
        recordErr,
      )
    }
  }

  /**
   * Whether the model screen runs on this payload, in this order:
   *   1. an `exempt` namespace: never (ruling L), whatever else holds;
   *   2. mode `'off'` on this call's tier: never;
   *   3. a deterministic finding: always, with no gate call — a hit is already
   *      a positive, and the gate would only add a way to talk the screen out;
   *   4. an internal payload, by the declaration's classifier: never (ruling O);
   *   5. `'always'`: always; `'shadow'`: the gate is asked and recorded, and the
   *      screen runs whatever it said; `'gated'`: the gate decides, and a gate
   *      that is unavailable or throws runs the screen (the safe direction).
   *
   * Only `'off'` and `'gated'` can skip the screen, each by its exact value. The
   * declaration is read on every call, so a value construction never saw (a cast,
   * a later write) fails safe: anything else runs the screen, as `'shadow'` does.
   *
   * A gate whose answer is not obeyed is not waited for: its call is returned
   * as `shadowGate`, to run beside the screen and be awaited after it, so a
   * `'shadow'` result costs the slower of the two calls rather than their sum,
   * and the gate's decision is still recorded inside this scope. It never
   * rejects.
   */
  const shouldScreen = async (
    screen: InjectionScreenConfig,
    p: { tool: string; namespace: string; data: unknown; report: SanitizeReport },
  ): Promise<{ run: boolean; shadowGate?: Promise<void> }> => {
    if (screen.exempt?.includes(p.namespace)) return { run: false }
    const mode = resolveByTier(screen.mode ?? (screen.gate ? 'shadow' : 'always'))
    if (mode === 'off') return { run: false }
    if (p.report.findings.length > 0) return { run: true }
    if (classifyIngress(screen.classify, p) === 'internal') return { run: false }
    const gate = screen.gate
    if (mode === 'always' || !gate) return { run: true }
    const asked = (async () =>
      gate({
        tool: p.tool,
        namespace: p.namespace,
        content: typeof p.data === 'string' ? p.data : (JSON.stringify(p.data) ?? ''),
        ...(mode !== 'gated' && { shadow: true }),
        onDecision: recordGateDecision,
      }))()
    if (mode !== 'gated') {
      return {
        run: true,
        shadowGate: asked.then(
          () => undefined,
          () => undefined,
        ),
      }
    }
    try {
      return { run: (await asked).run }
    } catch {
      return { run: true }
    }
  }

  return {
    isUntrusted,
    optionsFor,

    async sanitize(tool, data, call) {
      if (!isUntrusted(tool)) return { data }

      const namespace = inferServer(tool)
      const item = call?.item
      const options = optionsFor(tool)
      // Per-CALL overrides still win: they are a deliberate, local decision by a
      // known call site (the retriever's `spotlight: 'off'` on a filename), not
      // an agent-level config that could silently weaken a nested boundary.
      const effective = { ...options, spotlight: call?.spotlight ?? options.spotlight }
      let { data: out, report } = sanitizeUntrusted(data, { tool, namespace, item }, effective)

      // The model screen, as its declaration says (`shouldScreen`). After a
      // deterministic finding it reads the sanitized projection, never the
      // original spans. A screen outage is recorded on the report; the
      // declaration's `onUnavailable` decides whether the payload stands.
      const screen = call?.screen === false ? undefined : options.screen
      const decided = screen
        ? await shouldScreen(screen, { tool, namespace, data, report })
        : { run: false }
      if (screen && decided.run) {
        const screenInput = report.findings.length > 0 ? out : data
        try {
          const verdict = await screen.run({
            tool,
            namespace,
            content: typeof screenInput === 'string' ? screenInput : JSON.stringify(screenInput),
            // The screen's own model call, recorded as it finishes — a failed
            // one too, since it was billed. Emitted on the live scope beside
            // the `content_sanitized` it may lead to, so the call shows in the
            // run's observability with the client it actually ran on. Best
            // effort: this closure is the guard's own, so whatever `emit` throws
            // is contained here rather than left to a screen that may not catch
            // it — a recording failure must never become a screen outage.
            onCall: (call) => {
              try {
                emit(
                  createModelCallEvent(
                    patternId,
                    { role: 'screen', source: `${namespace}/${tool}` },
                    call,
                  ),
                )
              } catch (recordErr) {
                console.error(
                  '[withInjectionGuard] recording the screen call failed; the verdict is unaffected:',
                  recordErr,
                )
              }
            },
          })
          if (verdict.injection_detected) {
            const screened = applyScreenVerdict(
              screenInput,
              verdict,
              { tool, namespace, item },
              report,
            )
            out = screened.data
            report = screened.report
          }
        } catch (err) {
          report = {
            ...report,
            screenReason: `screen unavailable: ${err instanceof Error ? err.message : String(err)}`,
            screenUnavailable: true,
          }
          // Any value but `'pass'` withholds: one construction never saw fails
          // safe, like the mode.
          if (screen.onUnavailable !== undefined && screen.onUnavailable !== 'pass') {
            out = SCREEN_WITHHELD
            report = { ...report, neutralized: true }
          }
        }
      }
      // A shadow gate ran beside the screen; its decision lands before this
      // result is returned.
      await decided.shadowGate

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

/**
 * A payload's class under the declaration's classifier. No classifier: every
 * payload is external (the library default). A throw, or any answer but
 * `'internal'`, is external: an unknown source is never trusted by accident.
 */
function classifyIngress(
  classify: IngressClassifier | undefined,
  p: { tool: string; namespace: string; data: unknown },
): IngressClass {
  if (!classify) return 'external'
  try {
    return classify({ namespace: p.namespace, tool: p.tool, data: p.data }) === 'internal'
      ? 'internal'
      : 'external'
  } catch {
    return 'external'
  }
}

/** The four screen modes; any other value is refused at construction. */
const SCREEN_MODES: ReadonlySet<unknown> = new Set<ScreenMode>(['off', 'shadow', 'gated', 'always'])

/**
 * REFUSE a screen declaration that reads like protection and is not:
 *
 *  - a `run` that is not a function — every call would be a screen outage;
 *  - a `mode` that is not one of the four, on any tier, or a per-tier map with
 *    no own `default` (it would resolve to the map itself) — whatever it was
 *    meant to say, the guard would act on something else;
 *  - an `onUnavailable` other than `'pass'` or `'withhold'`;
 *  - a mode that asks the gate (`'shadow'`, `'gated'`) on any tier, with no
 *    gate passed — it would run as nothing anyone declared;
 *  - an `exempt` namespace the guard does not declare — it would match nothing
 *    while reading like a decision (#242 item 4's rule, applied here).
 *
 * TypeScript catches a literal typo; this catches a JavaScript caller, a cast
 * and a value read from configuration.
 */
function refuseUnreadableScreen(screen: InjectionScreenConfig, namespaces: Set<string>): void {
  if (typeof screen.run !== 'function') {
    throw new Error(
      `[withInjectionGuard] the screen's \`run\` is not a function, so every payload ` +
        `would record a screen outage. Pass \`run: createInjectionScreen()\` or your own.`,
    )
  }
  const { mode } = screen
  if (typeof mode === 'object' && mode !== null && !Object.hasOwn(mode, 'default')) {
    throw new Error(
      `[withInjectionGuard] the screen's per-tier mode has no \`default\`, so a tier it ` +
        `does not name would resolve to the map itself. Add \`default\`.`,
    )
  }
  const modes = mode === undefined ? [] : tierValues(mode)
  const unknown = modes.filter((m) => !SCREEN_MODES.has(m))
  if (unknown.length > 0) {
    throw new Error(
      `[withInjectionGuard] the screen's mode ${JSON.stringify(unknown[0])} is not one of ` +
        `'off', 'shadow', 'gated' or 'always'.`,
    )
  }
  if (
    screen.onUnavailable !== undefined &&
    screen.onUnavailable !== 'pass' &&
    screen.onUnavailable !== 'withhold'
  ) {
    throw new Error(
      `[withInjectionGuard] the screen's onUnavailable ${JSON.stringify(screen.onUnavailable)} ` +
        `is not 'pass' or 'withhold'.`,
    )
  }
  if (!screen.gate && modes.some((m) => m === 'shadow' || m === 'gated')) {
    throw new Error(
      `[withInjectionGuard] the screen's mode asks the guard gate ('shadow' or 'gated') ` +
        `but no gate was passed. Pass \`gate: createGuardGate(decide)\`, or declare ` +
        `'always' or 'off'.`,
    )
  }
  for (const ns of screen.exempt ?? []) {
    if (!namespaces.has(ns)) {
      throw new Error(
        `[withInjectionGuard] the screen exempts namespace '${ns}', which this guard does ` +
          `not declare. An exemption must name one of the guard's own namespaces, or it ` +
          `exempts nothing while reading like a decision. (#242 item 4)`,
      )
    }
  }
}

/** Every value a `ByTier` setting can take, whichever tier a call is on. */
function tierValues<T>(value: ByTier<T>): T[] {
  return typeof value === 'object' && value !== null && Object.hasOwn(value, 'default')
    ? Object.values(value as Record<string, T>)
    : [value as T]
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
 *    the gateway answered its 77 names and none lands in the declared
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
          `in \`@hames-ai/connectors/mcp-catalog\`). If the gateway is down instead, the ` +
          `degraded-surface provenance (#278 F1) suppresses this refusal. (#242 item 4)`,
      )
    }
  }
}

/** Test-only: forget which namespaces have already been warned about. */
export function __resetInjectionGuardNamespaceWarnings(): void {
  warnedNamespaces.clear()
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
    // It holds no per-invocation state, so a resume passes straight through it
    // (slice 6).
    const resumable = wrapperResumable('withInjectionGuard', pattern)

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
      return resumableStep('withInjectionGuard', resumable, () =>
        amendRunFrame({ guard }, () => pattern.fn(scope, view)),
      )
    }

    return {
      ...pattern,
      name: `withInjectionGuard(${pattern.name})`,
      fn,
      capabilities: { ...pattern.capabilities, resumable },
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
