/**
 * decisionLoop (#507 S1)
 *
 * A loop over `routes` in which a DECISIONS MODEL (the systemone `decide` seam,
 * one `choice` question) picks the next route each time round, until it picks
 * `answer` or the iteration bound is reached. It is a pattern, not an
 * orchestrator in ADR-0005's sense: every decision, every route record and every
 * child's events are events in the one context, and it composes with
 * `harness(...)` like `routes()` does. Design: docs/plan/decision-loop-agent.md.
 *
 * One iteration:
 *   1. build the state (conversation, a one-line stats list of every step this
 *      turn, the last N outputs in full) and ask "Which step should run next?";
 *   2. `answer` ends the loop — it runs nothing; a `compactExecution` after the
 *      loop writes the reply;
 *   3. otherwise run the route's pattern in a CHILD scope (below);
 *   4. record what it produced as a route output and go to 1.
 *
 * ## What a child sees
 *
 * Its own synthetic context (as `chain()` builds one) and its own `viewConfig`:
 * the committed events plus this turn's earlier children's events, with every
 * event of a sibling it is not allowed to see PHYSICALLY REMOVED — so not even
 * `view.unfiltered()` or an `expandPreviousResult` of a known event id can reach
 * it — and with this loop's own route records removed (they carry copies of
 * those results). The user's message is not a route event and always stays. Its
 * `data` is built fresh: the latest sanitized plan, the separately headed
 * handoff and, for a planner route, the agent map. Never `memories`,
 * `memoryContext` or `intent`. Nothing a child writes to `data` flows back.
 *
 * ## What comes back
 *
 * One record per iteration, built by code from the child's COMMITTED events
 * (`decisionLoop-records.server.ts`). Both its text fields are capped and then
 * passed through `currentRunFrame()?.guard?.sanitize('decision_loop_output', …)`:
 * route output is untrusted and reaches an instruction-adjacent slot (the next
 * child's `plan_context`) and the decisions model. The key must be declared in
 * the enclosing guard's `tools`, or `sanitize` is a no-op (that is the opt-in
 * every guard has). A screen that could not run withholds the output (S-d).
 *
 * ## Failure — never a silent fallback
 *
 *   - a non-decision (error, abstention, a label outside the options, a state
 *     builder that threw) NEVER dispatches a route. Iteration 1: the turn ends
 *     with a visible, irrecoverable error. Later: the loop stops as `answer` and
 *     the recoverable error stays for the synthesizer (N3).
 *   - a route that throws, or yields no usable result, is a FAILED record; the
 *     loop decides again (A3). Its own `error` events are committed as
 *     `recoverable`, or `runChain` would end the turn on a child's irrecoverable
 *     error.
 *   - `maxIterations` (default {@link DECISION_LOOP_MAX_ITERATIONS}) stops the
 *     loop as `answer`, with a recoverable `budget_exhausted` error so the
 *     synthesizer says the work is partial (N5).
 */

import { assertServerOnImport } from '../assert.server'
import type {
  ConfiguredPattern,
  ContextEvent,
  DecideFn,
  DecisionLabel,
  DecisionSpec,
  ErrorEventData,
  EventView,
  PatternConfig,
  PatternScope,
  PlanResult,
  UnifiedContext,
} from '../types'
import { createEvent, createScope, dropHitl, resolveConfig, trackEvent } from '../context.server'
import { getErrorHint } from '../error-hints'
import { hitlPending } from '../hitl.server'
import { emitLive } from '../live-event-context.server'
import { currentRunFrame } from '../run-frame.server'
import { trimToFit } from '../token-budget.server'
import { createEventView } from './event-view.server'
import {
  conversationTurns,
  decide,
  decisionWindowView,
  readContextWindow,
  type TypedDecisionData,
} from './typedDecision.server'
import {
  capText,
  collectPatternIds,
  collectToolNames,
  computeStats,
  extract,
  leafPattern,
  renderHandoff,
  resultBlock,
  routeKind,
  stepLine,
  type RouteKind,
  type RouteOutput,
} from './decisionLoop-records.server'
import type { PlannerData } from './planner.server'

assertServerOnImport()

// ============================================================================
// Public vocabulary
// ============================================================================

/** The iteration bound's default (N5). Exported so a host that mirrors the
 *  bound — the stuck-run reaper's arithmetic — can pin its copy to this one. */
export const DECISION_LOOP_MAX_ITERATIONS = 6

/** The `data.decisions` key the loop records its latest decision under. */
export const DECISION_LOOP_KEY = 'next_step'

/** The option that ends the loop. A choice, not a route: it runs nothing. */
export const DECISION_LOOP_ANSWER = 'answer'

/** The fixed sanitize key for every route output. The enclosing
 *  `withInjectionGuard` must list it in `tools` (and `spotlight: 'always'` to
 *  fence everything handed up). Never the route's name. */
export const DECISION_LOOP_OUTPUT_KEY = 'decision_loop_output'

/** Cap on each of a record's `result` and `reasoning`, in characters. */
export const DECISION_LOOP_RESULT_CHARS = 2000

/** The withheld marker that replaces a record's result when the guard's screen
 *  could not run (S-d). */
export const WITHHELD_SCREEN_UNAVAILABLE = 'withheld: screen unavailable'

export interface DecisionLoopRoute<T> {
  readonly pattern: ConfiguredPattern<T>
  /** The only text the decisions model sees for this option. */
  readonly description: string
  /** One or two high-level capability lines for the planner's agent map. */
  readonly capability?: string
  /** `patternId`s of OTHER routes' patterns whose events this route may see
   *  (same vocabulary as `withReferences.source`). Default: none — a route sees
   *  its own work, the committed non-route events and the handoff text, and
   *  nothing else. Naming an id no route's pattern emits under is refused. */
  readonly siblingResults?: readonly string[]
}

/** What an overridden `state` builder receives. */
export interface DecisionLoopStateInput {
  /** Conversation lines, oldest first (user and final assistant messages). */
  readonly conversation: readonly string[]
  /** This turn's finished iterations, oldest first. */
  readonly records: readonly RouteOutput[]
  readonly lastN: number
  readonly iteration: number
}

export interface DecisionLoopConfig extends PatternConfig {
  /** REQUIRED: the raw decision seam (`bamlPatterns().decide`, or your own). */
  readonly decide: DecideFn
  /** The description of the `answer` option — what the model reads for it. */
  readonly answer: string
  /** `lastN` outputs shown in full to the decisions model AND handed to the next
   *  child, counted in ITERATIONS of this loop (default 2, N2). */
  readonly handoff?: { readonly lastN?: number }
  /** Default {@link DECISION_LOOP_MAX_ITERATIONS}. */
  readonly maxIterations?: number
  /** Cap on a record's `result` and `reasoning` (default 2000 characters). */
  readonly maxResultChars?: number
  /** Replace the state the decision is asked over. A throw is a non-decision. */
  readonly state?: (input: DecisionLoopStateInput) => string
}

export interface DecisionLoopData extends TypedDecisionData, PlannerData {}

// ============================================================================
// The agent map (static, built once)
// ============================================================================

function buildAgentMap<T>(routes: Record<string, DecisionLoopRoute<T>>): string {
  return Object.entries(routes)
    .map(([name, route]) => {
      const tools = collectToolNames(route.pattern)
      return [
        `- ${name}: ${route.description}`,
        ...(route.capability ? [`  Can: ${route.capability}`] : []),
        ...(tools.length > 0 ? [`  Tools: ${tools.join(', ')}`] : []),
      ].join('\n')
    })
    .join('\n')
}

/** Warned once per process, like the guard's namespace warning. */
let warnedUnguarded = false

/** Test-only: forget that the unguarded-output warning has fired. */
export function __resetDecisionLoopWarnings(): void {
  warnedUnguarded = false
}

// ============================================================================
// Pattern
// ============================================================================

export function decisionLoop<T extends DecisionLoopData & Record<string, unknown>>(
  routes: Record<string, DecisionLoopRoute<T>>,
  config: DecisionLoopConfig,
): ConfiguredPattern<T> {
  const {
    decide: decideFn,
    answer,
    handoff,
    maxIterations: maxIterationsConfig,
    maxResultChars: maxResultCharsConfig,
    state: stateOverride,
    ...patternConfig
  } = config

  const names = Object.keys(routes)
  if (names.length === 0) throw new Error('decisionLoop: at least one route is required')
  if (names.includes(DECISION_LOOP_ANSWER)) {
    throw new Error(
      `decisionLoop: a route may not be named '${DECISION_LOOP_ANSWER}' — that is the option that ends the loop`,
    )
  }
  const maxIterations = maxIterationsConfig ?? DECISION_LOOP_MAX_ITERATIONS
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    throw new Error(`decisionLoop: maxIterations must be an integer >= 1, got ${maxIterations}`)
  }
  const lastN = handoff?.lastN ?? 2
  if (!Number.isInteger(lastN) || lastN < 0) {
    throw new Error(`decisionLoop: handoff.lastN must be an integer >= 0, got ${lastN}`)
  }
  const maxChars = maxResultCharsConfig ?? DECISION_LOOP_RESULT_CHARS
  if (!decideFn.supportedTypes?.includes('choice') && decideFn.supportedTypes !== undefined) {
    throw new Error("decisionLoop: the decide seam does not support 'choice' questions")
  }

  // Route kinds are found by unwrapping single-child wrappers. A leaf with no
  // default extractor is REFUSED here: a generic fallback would invent a result
  // out of events nobody reviewed, and a record is what the model decides on.
  const kinds = new Map<string, RouteKind>()
  const leafIds = new Map<string, string>()
  for (const name of names) {
    const leaf = leafPattern(routes[name].pattern)
    const kind = routeKind(routes[name].pattern)
    if (!leaf || !kind) {
      throw new Error(
        `decisionLoop: route '${name}' is not a simpleLoop, actorCritic, retriever or planner (possibly inside single-child wrappers); there is no default way to read its result`,
      )
    }
    kinds.set(name, kind)
    leafIds.set(name, leaf.config.patternId ?? leaf.name)
  }

  // Which patternIds each route owns, and which each route may NOT see.
  const owned = new Map(names.map((n) => [n, collectPatternIds(routes[n].pattern)]))
  const allRouteIds = new Set([...owned.values()].flatMap((s) => [...s]))
  const hidden = new Map<string, Set<string>>()
  for (const name of names) {
    const allowed = routes[name].siblingResults ?? []
    for (const id of allowed) {
      if (!allRouteIds.has(id)) {
        throw new Error(
          `decisionLoop: route '${name}' lists siblingResults '${id}', which no route's pattern emits events under — a declaration that matches nothing reads like access control and does nothing`,
        )
      }
    }
    hidden.set(
      name,
      new Set([...allRouteIds].filter((id) => !owned.get(name)!.has(id) && !allowed.includes(id))),
    )
  }

  const labels: DecisionLabel[] = [
    ...names.map((id) => ({ id, description: routes[id].description })),
    { id: DECISION_LOOP_ANSWER, description: answer },
  ]
  const spec: DecisionSpec = {
    key: DECISION_LOOP_KEY,
    question: 'Which step should run next?',
    labels,
  }
  const optionIds = labels.map((l) => l.id)
  const agentMap = buildAgentMap(routes)

  const resolved = resolveConfig('decisionLoop', {
    viewConfig: decisionWindowView(false),
    ...patternConfig,
  })
  const loopId = resolved.patternId

  // Visibility is decided PER patternId, so an id that two routes both emit
  // under — two routes given one id, one pattern object reused in two routes —
  // is never hidden from either of them, and `siblingResults: []` would read
  // like access control while granting it. An id equal to the loop's own would
  // strip the route's own events with the loop's records. Both are refused here,
  // where the declaration is made, rather than discovered as a leak.
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const shared = [...owned.get(names[i])!].find((id) => owned.get(names[j])!.has(id))
      if (shared !== undefined) {
        throw new Error(
          `decisionLoop: routes '${names[i]}' and '${names[j]}' both emit under patternId '${shared}'; visibility is per patternId, so they would read each other's events — give each route's pattern its own patternId`,
        )
      }
    }
    if (owned.get(names[i])!.has(loopId)) {
      throw new Error(
        `decisionLoop: route '${names[i]}' emits under the loop's own patternId '${loopId}'; its events would be removed with the loop's records`,
      )
    }
  }

  // --------------------------------------------------------------------------

  /** Cap, then sanitize under the declared key. `unavailable` is the typed
   *  screen-outage flag, never inferred from prose. No guard in the frame, or a
   *  key the guard does not list, passes the text through (the opt-in). */
  const sanitizeField = async (text: string): Promise<{ text: string; unavailable: boolean }> => {
    if (!text) return { text: '', unavailable: false }
    const capped = capText(text, maxChars)
    const guard = currentRunFrame()?.guard
    if (!guard) return { text: capped, unavailable: false }
    const { data, summary } = await guard.sanitize(DECISION_LOOP_OUTPUT_KEY, capped)
    return {
      text: typeof data === 'string' ? data : JSON.stringify(data),
      unavailable: summary?.screenUnavailable === true,
    }
  }

  const renderState = (input: DecisionLoopStateInput, fn: DecideFn): string => {
    if (stateOverride) return stateOverride(input)
    const window = readContextWindow(fn)
    const steps = input.records.map(stepLine)
    const latest = input.lastN > 0 ? input.records.slice(-input.lastN).map(resultBlock) : []
    const render = (c: readonly string[], s: readonly string[], r: readonly string[]): string =>
      [
        'Conversation (recent turns):',
        c.join('\n\n'),
        '',
        'This turn so far:',
        s.length > 0 ? s.join('\n') : '(nothing yet)',
        ...(r.length > 0 ? ['', 'Latest results (most recent last):', ...r] : []),
      ].join('\n')
    // Oldest first, in this order: conversation, then full outputs, then step
    // lines. The state is APPEND-ONLY within a turn so a provider prefix cache
    // can reuse everything but the tail.
    let c = [...input.conversation]
    let r = latest
    let s = steps
    c = trimToFit(c, (x) => render(x, s, r), 300, window)
    r = trimToFit(r, (x) => render(c, s, x), 300, window)
    s = trimToFit(s, (x) => render(c, x, r), 300, window)
    return render(c, s, r)
  }

  /** Record a failure that is not a decision (a state builder that threw, or a
   *  decision with no usable label and no error of its own). */
  const recordError = (scope: PatternScope<T>, message: string, iteration: number): void => {
    trackEvent(
      scope,
      'error',
      {
        error: message,
        severity: iteration === 1 ? 'irrecoverable' : 'recoverable',
        hint: getErrorHint(message),
        iteration: iteration - 1,
      } as ErrorEventData,
      true,
    )
  }

  const fn = async (scope: PatternScope<T>, view: EventView): Promise<PatternScope<T>> => {
    // The opt-in is silent by construction (`sanitize` is a no-op for an
    // undeclared key), which here means raw route output reaching the decision
    // state and every child's plan_context. Say so once.
    if (!warnedUnguarded && !currentRunFrame()?.guard?.isUntrusted(DECISION_LOOP_OUTPUT_KEY)) {
      warnedUnguarded = true
      console.warn(
        `[decisionLoop] no guard in this run declares '${DECISION_LOOP_OUTPUT_KEY}' in its tools: route output is NOT sanitized before it reaches the decision state and the next child's plan_context. Wrap the loop in withInjectionGuard({ tools: ['${DECISION_LOOP_OUTPUT_KEY}'], spotlight: 'always' }).`,
      )
    }
    const outerCtx = (view as unknown as { ctx: UnifiedContext }).ctx
    const records: RouteOutput[] = []
    // Events withheld by an earlier screen outage (S-d, ruling on finding 7): the
    // ids ride the marker record, which is in the context and so persists with
    // the run — read them back here so a LATER TURN's children skip them too.
    const withheld = new Set<string>()
    for (const e of outerCtx.events) {
      if (e.patternId !== loopId || e.type !== 'tool_result') continue
      for (const id of (e.data as { withheldEventIds?: string[] }).withheldEventIds ?? []) {
        withheld.add(id)
      }
    }
    let latestPlan: { text: string; steps: number } | undefined
    let ended: 'answer' | 'stopped' | 'bound' = 'bound'

    for (let iteration = 1; iteration <= maxIterations; iteration++) {
      // 1. State and decision. Any failure to get a usable decision stops here.
      let state = ''
      let stateError: string | undefined
      try {
        state = renderState(
          { conversation: conversationTurns(view), records, lastN, iteration },
          decideFn,
        )
      } catch (e) {
        stateError = `decisionLoop state builder failed: ${e instanceof Error ? e.message : String(e)}`
      }
      if (stateError !== undefined) {
        recordError(scope, stateError, iteration)
        ended = 'stopped'
        break
      }

      const before = scope.events.length
      const decision = await decide(
        scope,
        { decide: decideFn, spec, state },
        {
          trackHistory: resolved.trackHistory,
          errorSeverity: iteration === 1 ? 'irrecoverable' : 'recoverable',
        },
      )
      scope.data = {
        ...scope.data,
        decisions: { ...scope.data.decisions, [DECISION_LOOP_KEY]: decision },
      }

      // NEVER act on a label unless there is a usable decision: not on an
      // abstention for any reason, not on a null label, not on a label outside
      // the options. (The old fallback-label dispatch is exactly what this is
      // not.)
      const label = decision.label
      if (decision.abstained || label === null || !optionIds.includes(label)) {
        const recorded = scope.events.slice(before).some((e) => e.type === 'error')
        if (!recorded) {
          recordError(scope, `Decision '${DECISION_LOOP_KEY}' returned no usable option`, iteration)
        }
        ended = 'stopped'
        break
      }
      if (label === DECISION_LOOP_ANSWER) {
        ended = 'answer'
        break
      }

      // 2. Run the route in a child scope.
      const route = routes[label]
      const pattern = route.pattern
      const childId = pattern.config.patternId ?? pattern.name
      const enter = createEvent('pattern_enter', childId, { pattern: pattern.name, route: label })
      scope.events.push(enter)
      emitLive(enter)

      const hide = hidden.get(label)!
      const syntheticCtx: UnifiedContext = {
        ...outerCtx,
        events: [...outerCtx.events, ...scope.events].filter(
          (e) =>
            e.patternId !== loopId &&
            (e.id === undefined || !withheld.has(e.id)) &&
            (!hide.has(e.patternId) || e.type === 'pattern_enter' || e.type === 'pattern_exit'),
        ),
      }
      const childView = createEventView(syntheticCtx, pattern.config.viewConfig, childId)

      const handoffText = renderHandoff(records, lastN)
      const childData = {
        ...(latestPlan
          ? {
              plan: {
                reasoning: '',
                plan: latestPlan.text,
                n_steps: latestPlan.steps,
              } satisfies PlanResult,
            }
          : {}),
        ...(handoffText ? { handoff: handoffText } : {}),
        ...(kinds.get(label) === 'planner' ? { agentMap } : {}),
      } as unknown as T
      const childScope = createScope<T>(childId, childData)

      const started = Date.now()
      let thrown: unknown
      let finished: PatternScope<T> = childScope
      try {
        finished = await pattern.fn(childScope, childView)
      } catch (e) {
        thrown = e
      }
      const wallMs = Date.now() - started
      // A throw leaves whatever the child tracked up to then on the scope we
      // handed it; use that.
      const childEvents = dropHitl(finished.events)

      // Committed copy: the child's own `error` events stay inside its enter/exit
      // but as `recoverable`, or `runChain` would end the turn on them.
      scope.events.push(
        ...childEvents.map((e): ContextEvent =>
          e.type === 'error'
            ? { ...e, data: { ...(e.data as ErrorEventData), severity: 'recoverable' } }
            : e,
        ),
      )
      const exit = createEvent('pattern_exit', childId, {
        status: thrown === undefined ? 'completed' : 'error',
      })
      scope.events.push(exit)
      emitLive(exit)

      if (hitlPending()) return scope

      // 3. The record: from committed events only, capped, then sanitized.
      const kind = kinds.get(label)!
      const leafId = leafIds.get(label)!
      const ownEvents = childEvents.filter((e) => e.patternId === leafId)
      const stats = computeStats(kind, childEvents, leafId, wallMs)
      const extracted =
        thrown !== undefined
          ? ({
              ok: false,
              failure: 'the step threw an error',
              text: thrown instanceof Error ? thrown.message : String(thrown),
            } as const)
          : extract(kind, ownEvents)

      const resultField = await sanitizeField(extracted.ok ? extracted.result : extracted.text)
      const reasoningField = await sanitizeField(extracted.ok ? extracted.reasoning : '')

      let record: RouteOutput
      if (resultField.unavailable || reasoningField.unavailable) {
        // Marker only: every byte of the original output is discarded BEFORE the
        // record exists, so no projection of it (state, handoff, synthesis) can
        // carry it.
        // The screen did not clear this child's events either (inner guards
        // inherit the screen and fail open on an outage): withhold them from
        // every child context this loop builds from here on.
        const ids = childEvents.flatMap((e) => (e.id ? [e.id] : []))
        for (const id of ids) withheld.add(id)
        record = {
          iteration,
          route: label,
          status: 'failed',
          stats,
          result: WITHHELD_SCREEN_UNAVAILABLE,
          reasoning: '',
          failure: 'screen unavailable',
          withheldEventIds: ids,
        }
      } else if (extracted.ok) {
        record = {
          iteration,
          route: label,
          status: 'succeeded',
          stats,
          result: resultField.text,
          reasoning: reasoningField.text,
          ...(kind === 'planner'
            ? {
                plan: {
                  text: resultField.text,
                  steps: extracted.planSteps ?? stats.planSteps ?? 0,
                },
              }
            : {}),
        }
      } else {
        record = {
          iteration,
          route: label,
          status: 'failed',
          stats,
          result: resultField.text,
          reasoning: '',
          failure: extracted.failure,
        }
      }
      records.push(record)
      if (record.plan) latestPlan = record.plan

      // The record as events: the controller_action / tool_result pair
      // `compactExecution`'s thread mode already reads, under THIS loop's id.
      trackEvent(
        scope,
        'controller_action',
        {
          action: {
            reasoning: record.reasoning,
            tool_name: label,
            tool_args: '',
            status: stepLine(record),
            is_final: false,
          },
          turn: iteration - 1,
          maxTurns: maxIterations,
        },
        resolved.trackHistory,
      )
      trackEvent(
        scope,
        'tool_result',
        record.status === 'succeeded'
          ? { tool: label, result: record.result, success: true }
          : {
              tool: label,
              result: null,
              success: false,
              error: record.result || record.failure,
              ...(record.withheldEventIds ? { withheldEventIds: record.withheldEventIds } : {}),
            },
        resolved.trackHistory,
      )
    }

    if (ended === 'bound') {
      const message = `Decision loop exhausted: reached maxIterations (${maxIterations}) without an '${DECISION_LOOP_ANSWER}' decision. Partial results from ${records.length} completed step(s) are preserved.`
      trackEvent(
        scope,
        'error',
        {
          error: message,
          severity: 'recoverable',
          hint: `This loop declares its own bound of ${maxIterations} iterations; raise \`maxIterations\` on the \`${loopId}\` pattern in its agent config. Nothing failed — the loop was still working when the bound was reached, so the answer is composed from the completed steps only.`,
          iteration: maxIterations - 1,
          maxTurns: maxIterations,
          kind: 'budget_exhausted',
        } as ErrorEventData,
        true,
      )
    }
    return scope
  }

  return {
    name: 'decisionLoop',
    fn,
    config: resolved,
    // ITERATIONS, not iterations × a child's own budget: a child's turns do not
    // show on the chain's progress, and projecting every route at its worst case
    // would size the bar for a run that never happens.
    estimateTurns: () => maxIterations,
    children: names.map((n) => routes[n].pattern),
    capabilities: { decisionKeys: [DECISION_LOOP_KEY] },
  }
}
