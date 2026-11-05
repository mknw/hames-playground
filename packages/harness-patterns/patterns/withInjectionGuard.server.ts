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
 * `sanitized` annotation on the affected `tool_result`. When the
 * injection-ingress-guard classification runs (its own opt-in, `ingressGuard`),
 * its answer lands as a `decision_made` event keyed `guard.ingress` and an
 * `ingress` mark on the affected `tool_result` — metadata only, never content.
 */

import { assertServerOnImport } from '../assert.server'
import { askHumanHolding, canPauseHere, held, hitlRunAttended } from '../hitl.server'
import { createEvent, createModelCallEvent, redactCall } from '../context.server'
import { emitLive } from '../live-event-context.server'
import { amendRunFrame, currentRunFrame, resolveByTier } from '../run-frame.server'
import { resumableStep, wrapperResumable } from '../resume.server'
import {
  announceNeutralised,
  applyScreenVerdict,
  fenceItemId,
  INGRESS_FLAG_KIND,
  INGRESS_FLAG_OPTIONS,
  INGRESS_TEXTS,
  ingressFlagResolution,
  redactReport,
  sanitizeUntrusted,
  SCREEN_WITHHELD,
  type ActiveInjectionGuard,
  type IngressClassification,
  type IngressFlagPayload,
  type IngressLabel,
  type IngressClass,
  type IngressClassifier,
  type IngressMark,
  type IngressMode,
  type InjectionGuardOptions,
  type InjectionIngressGuardConfig,
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
  if (config.ingressGuard) refuseUnreadableIngress(config.ingressGuard)

  /** The classification's answer as a `decision_made` event in the live scope,
   *  its call record redacted (the classification's state is the payload it
   *  read). Best effort, like the screen's `model_call`: a recording failure
   *  never changes a verdict. Returns the event's id, for the payload's
   *  attachment as the decision record's reference (O37). */
  const recordIngressDecision = (
    event: DecisionMadeEventData,
    call?: LLMCallRecord,
  ): string | undefined => {
    try {
      const recorded = createEvent('decision_made', patternId, event, redactCall(call))
      emit(recorded)
      return recorded.id
    } catch (recordErr) {
      console.error(
        '[withInjectionGuard] recording the classification decision failed; the verdict is unaffected:',
        recordErr,
      )
      return undefined
    }
  }

  /**
   * Whether the model screen runs on this payload, in this order:
   *   1. an `exempt` namespace: never (ruling L), whatever else holds;
   *   2. mode `'off'` on this call's tier: never — O41 ruled (a): a
   *      deterministic finding forces nothing past an `'off'`, because the
   *      classification replaced the finding-forces-model-call path and
   *      `'off'` means ingress is fully deterministic;
   *   3. a deterministic finding: always, with no model call in between — a
   *      hit is already a positive, and a model asked whether to look closer
   *      would only add a way to talk the screen out of running;
   *   4. an internal payload, by the declaration's classifier: never (ruling O).
   *
   * Only `'off'` can skip the screen, by its exact value. The declaration is
   * read on every call, so a value construction never saw (a cast, a later
   * write) fails safe: anything else runs the screen.
   */
  const shouldScreen = (
    screen: InjectionScreenConfig,
    p: {
      tool: string
      namespace: string
      data: unknown
      report: SanitizeReport
      external: boolean
    },
  ): boolean => {
    if (screen.exempt?.includes(p.namespace)) return false
    if (resolveByTier(screen.mode ?? 'always') === 'off') return false
    if (p.report.findings.length > 0) return true
    return p.external
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

      // Both model steps read the SAME projection: the sanitized one after a
      // deterministic finding (K1's markers are part of what each reads — one
      // rule, no branches: a payload's findings never change whether either
      // runs), the original otherwise.
      const projection = report.findings.length > 0 ? out : data
      // Recorded before the screen can add findings of its own: the label floor
      // below needs to know which layer flagged the payload.
      const deterministicFinding = report.findings.length > 0
      let screenPositive = false
      const external =
        classifyIngress(options.screen?.classify, { tool, namespace, data }) === 'external'
      // Ruling L named the gate and the screen: an `exempt` namespace meets
      // neither. The classification replaced the gate, so it inherits the
      // exemption rather than quietly widening what a declaration exempted.
      const exempt = options.screen?.exempt?.includes(namespace) === true

      // The injection-ingress-guard classification (O36): one Decide call per
      // external payload in `'on'`/`'shadow'`, beside the screen and reading
      // the same head, so a run that pays for both waits the slower of the two
      // rather than their sum. Label + friction, never withhold (O38): the
      // answer attaches as metadata and changes no content. In `'on'`, an
      // unavailable answer (a timeout, a transport failure, a state it could
      // not render, a runner that throws) attaches an ABSTAINED mark, so a
      // reader can tell "classified and failed" from "never classified"
      // (security review MUST-2). A per-call `ingress: false` opts a payload
      // out — the error channel and a hit's filename: neither is content a
      // reference surfaces, a deliberate narrowing of "where K1 runs" (code
      // review SHOULD-4) — and a mode that is not `'on'` by its exact value —
      // `'shadow'`, or a value construction never saw — records with
      // `shadow: true` and attaches no mark.
      const ingressGuard = call?.ingress === false ? undefined : options.ingressGuard
      const ingressMode = ingressGuard ? resolveByTier(ingressGuard.mode ?? 'off') : 'off'
      const classification =
        ingressGuard && ingressMode !== 'off' && external && !exempt
          ? (async () =>
              ingressGuard.run({
                tool,
                namespace,
                content:
                  typeof projection === 'string' ? projection : (JSON.stringify(projection) ?? ''),
                item: fenceItemId(item),
                ...(ingressMode !== 'on' && { shadow: true as const }),
                onDecision: recordIngressDecision,
              }))()
          : undefined

      // The model screen, as its declaration says (`shouldScreen`). After a
      // deterministic finding it reads the sanitized projection, never the
      // original spans. A screen outage is recorded on the report; the
      // declaration's `onUnavailable` decides whether the payload stands.
      const screen = call?.screen === false ? undefined : options.screen
      if (screen && shouldScreen(screen, { tool, namespace, data, report, external })) {
        const screenInput = projection
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
            screenPositive = true
            const screened = applyScreenVerdict(
              screenInput,
              verdict,
              { tool, namespace, item },
              report,
            )
            report = screened.report
            out = screen.askPerson
              ? await flagged(
                  {
                    namespace,
                    tool,
                    content: out,
                    screened: screened.data,
                    spans: verdict.spans,
                  },
                  item,
                )
              : screened.data
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
      // The classification ran beside the screen; its answer lands before this
      // result is returned. The runner's contract says it never throws; one
      // that does (a custom `run`) is an unavailable answer like any other.
      let classified: IngressClassification | undefined
      if (classification) {
        try {
          classified = await classification
        } catch {
          classified = undefined
        }
      }
      // Only an `'on'` answer attaches a mark. A `'shadow'` answer lives on its
      // `decision_made` event alone (stamped `shadow: true`, with the tool and
      // item id to correlate it): a mark a presentation reader could misread is
      // not attached at all, so "changes no presentation" holds by
      // construction rather than by every reader remembering a flag.
      //
      // In `'on'` every classification that RAN attaches a mark:
      //  - an answer: its label, FLOORED by what the other layers found
      //    (security review SHOULD-4) — a deterministic finding is already a
      //    positive, so the label is at least `possible-instructions-for-ai`,
      //    and a positive screen verdict makes it `instructions-for-ai-detected`.
      //    A floored label is never `safe`.
      //  - no answer: an abstained mark (no label, `safe: false`), which a
      //    reader presents as unchecked, never as safe (security MUST-2).
      // `truncated` says the label covers only the head it read (prompt S6,
      // security S5).
      let ingress: IngressMark | undefined
      if (ingressMode === 'on' && classification) {
        const markItem = fenceItemId(item)
        const base = {
          tool,
          ...(markItem !== undefined ? { item: markItem } : {}),
          ...(classified?.truncated ? { truncated: true as const } : {}),
          ...(classified?.eventId !== undefined ? { eventId: classified.eventId } : {}),
        }
        if (classified && !classified.abstained && classified.label !== null) {
          const floor: IngressLabel = screenPositive
            ? 'instructions-for-ai-detected'
            : deterministicFinding
              ? 'possible-instructions-for-ai'
              : 'safe'
          const label =
            INGRESS_RANK[classified.label] >= INGRESS_RANK[floor] ? classified.label : floor
          ingress = { ...base, label, safe: label === 'safe' && classified.safe }
        } else {
          ingress = { ...base, abstained: true, safe: false }
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
          return { data: out, summary: redactReport(report, event.id), ingress }
        }
        return { data: out, ingress }
      }

      const event = buildEvent(patternId, report)
      emit(event)
      // The REDACTED summary goes back to the caller (and onto the tool_result
      // event); the verbatim spans stay on `event` alone. See `SanitizeSummary`.
      return { data: out, summary: redactReport(report, event.id), ingress }
    },
  }
}

/**
 * A screen finding, handed to the person (boundary guards slice 10, rulings H
 * and N). In order:
 *
 * - nobody to ask (no attended run): the result is LEFT OUT, and its fixed
 *   line says so (ruling T);
 * - attended on a path that cannot pause (O14, ruled (b)): the flagged passages
 *   are replaced, as without a person, and the result says so in fixed text;
 * - otherwise an `ingress-flag` request holds the result in its payload row and
 *   the call returns the placeholder: the loop pauses, and the host's `resolve`
 *   returns what the person chose ({@link ingressFlagResolution}).
 *
 * Raised only on a screen verdict, never on a deterministic finding alone.
 */
async function flagged(payload: IngressFlagPayload, item?: string): Promise<unknown> {
  // The fence's item id names the source in the dialog (guard slice 8). It is
  // display-only, on the summary: an id of this invocation, it is not what the
  // person decides about, and in the payload it would rebind a re-run.
  const id = fenceItemId(item)
  if (!hitlRunAttended()) return INGRESS_TEXTS.leftOut(payload.tool)
  if (!canPauseHere()) return announceNeutralised(payload.tool, payload.screened)
  let outcome: Awaited<ReturnType<typeof askHumanHolding>>
  try {
    outcome = await askHumanHolding(
      {
        kind: INGRESS_FLAG_KIND,
        question: 'Use this result?',
        options: INGRESS_FLAG_OPTIONS,
        defaultOption: 'leave-out',
        summary: {
          namespace: payload.namespace,
          tool: payload.tool,
          ...(id !== undefined ? { item: id } : {}),
        },
      },
      payload,
    )
  } catch {
    // The payload could not be held (the host's store failed): nobody can be
    // asked here, so the O14 default, never the screen-outage path, which
    // would leave the flagged span in place (#804 review B1).
    return announceNeutralised(payload.tool, payload.screened)
  }
  if (outcome.status === 'rebound') return announceNeutralised(payload.tool, payload.screened)
  if (outcome.status === 'pending') return held(outcome, INGRESS_TEXTS.held)
  return ingressFlagResolution(outcome.choice ?? 'leave-out', payload)
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

/** The classification's labels in order of severity, for the floor above. */
const INGRESS_RANK: Readonly<Record<IngressLabel, number>> = {
  safe: 0,
  'possible-instructions-for-ai': 1,
  'instructions-for-ai-detected': 2,
}

/** The two screen modes; any other value is refused at construction. */
const SCREEN_MODES: ReadonlySet<unknown> = new Set<ScreenMode>(['off', 'always'])
/** The classification's three modes. */
const INGRESS_MODES: ReadonlySet<unknown> = new Set<IngressMode>(['off', 'shadow', 'on'])

/**
 * REFUSE a screen declaration that reads like protection and is not:
 *
 *  - a `run` that is not a function — every call would be a screen outage;
 *  - a `mode` that is not one of the two, on any tier, or a per-tier map with
 *    no own `default` (it would resolve to the map itself) — whatever it was
 *    meant to say, the guard would act on something else. The retired gate's
 *    `'shadow'`/`'gated'` are refused here because both asked a gate, and no
 *    gate can be passed any more (revision 6, #938). On main they already
 *    refused construction when no gate was passed;
 *  - an `onUnavailable` other than `'pass'` or `'withhold'`;
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
        `'off' or 'always'.`,
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

/**
 * REFUSE a classification declaration that reads like protection and is not:
 * a `run` that is not a function (every payload it covers would be unmarked
 * for a reason nobody can see), a `mode` that is not one of the three on any
 * tier, or a per-tier map with no own `default` — the same rule the screen's
 * declaration follows, so a JavaScript caller, a cast and a value read from
 * configuration cannot produce a declaration the guard would act on as
 * something else.
 */
function refuseUnreadableIngress(ingress: InjectionIngressGuardConfig): void {
  if (typeof ingress.run !== 'function') {
    throw new Error(
      `[withInjectionGuard] the classification's \`run\` is not a function, so every payload ` +
        'it covers would be unmarked. Pass `run: createIngressGuard(decide)` or your own.',
    )
  }
  const { mode } = ingress
  if (typeof mode === 'object' && mode !== null && !Object.hasOwn(mode, 'default')) {
    throw new Error(
      `[withInjectionGuard] the classification's per-tier mode has no \`default\`, so a ` +
        'tier it does not name would resolve to the map itself. Add `default`.',
    )
  }
  const unknown = (mode === undefined ? [] : tierValues(mode)).filter((m) => !INGRESS_MODES.has(m))
  if (unknown.length > 0) {
    throw new Error(
      `[withInjectionGuard] the classification's mode ${JSON.stringify(unknown[0])} is not ` +
        "one of 'off', 'shadow' or 'on'.",
    )
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
