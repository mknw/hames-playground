import { assertServerOnImport } from '../assert.server'
import { DIRECT_RESPONSE_ROUTE, LLMCallError, MAX_SCORE_LEVELS } from '../types'
import type {
  AnyDecision,
  AnyDecisionSpec,
  DecisionFor,
  MixedDecisionSet,
  ScoreSpec,
  NoulSpec,
  ScoreDecision,
  NoulDecision,
  AssistantMessageEventData,
  ConfiguredPattern,
  ContextEvent,
  DecideAllFn,
  DecideFn,
  DecideResult,
  Decision,
  DecisionLabel,
  DecisionMadeEventData,
  DecisionSpec,
  ErrorEventData,
  EventView,
  LLMCallRecord,
  PatternConfig,
  PatternScope,
  TrackHistory,
  UserMessageEventData,
  ViewConfig,
} from '../types'
import { redactCall, resolveConfig, trackEvent } from '../context.server'
import { getErrorHint } from '../error-hints'
import { currentRunFrame } from '../run-frame.server'
import { DEFAULT_RUNTIME_CONFIG } from '../runtime-config'
import { stripThinkBlocks } from '../content-transforms'
import { trimToFit } from '../token-budget.server'
import type { RouterData, Routes } from './router.server'

assertServerOnImport()

/** Declaration checks run where a developer writes the spec, never at inference. */
function assertOptions(owner: string, labels: readonly DecisionLabel[], cap: number): void {
  if (labels.length < 2 || labels.length > cap) {
    throw new Error(`${owner}: expected 2..${cap} options, got ${labels.length}`)
  }
  if (new Set(labels.map((l) => l.id)).size !== labels.length) {
    throw new Error(`${owner}: option ids must be unique`)
  }
}

export function defineChoice<const L extends string>(spec: DecisionSpec<L>): DecisionSpec<L> {
  assertOptions('defineChoice', spec.labels, Infinity)
  return spec
}

export function defineScore<const L extends string>(
  spec: Omit<ScoreSpec<L>, 'type'>,
): ScoreSpec<L> {
  assertOptions('defineScore', spec.levels, MAX_SCORE_LEVELS)
  return { ...spec, type: 'score' }
}

export function defineNoul(spec: Omit<NoulSpec, 'type'>): NoulSpec {
  return { ...spec, type: 'noul' }
}

/** A declared spec fixes both the key and the type of a stored verdict.
 *  Missing type is a choice, including decisions read from older blobs. */
export function readDecision<S extends AnyDecisionSpec>(
  data: TypedDecisionData,
  spec: S,
): DecisionFor<S> | undefined {
  const d = data.decisions?.[spec.key]
  if (!d || (d.type ?? 'choice') !== (spec.type ?? 'choice')) return undefined
  return d as DecisionFor<S>
}

/** Convert an endpoint distribution to its typed verdict and event metadata.
 * Probability values remain exactly as returned. */
function scoreDecision(input: {
  spec: AnyDecisionSpec
  state: string
  result?: DecideResult<string>
  error?: ErrorEventData
  shadow?: true
}): { decision: AnyDecision; event: DecisionMadeEventData } {
  const { spec, result } = input
  const labels = categoricalOptions(spec)
  const probs = result?.probs ?? {}
  const mass = labels.reduce((sum, l) => sum + (probs[l.id] ?? NaN), 0)
  const usable =
    !input.error &&
    labels.every((l) => Number.isFinite(probs[l.id]) && probs[l.id] >= 0 && probs[l.id] <= 1) &&
    Math.abs(mass - 1) <= 0.01
  const top = usable ? labels.reduce((a, b) => (probs[b.id] > probs[a.id] ? b : a)).id : null
  const common = {
    key: spec.key,
    top,
    probs: usable ? probs : {},
    confidence: result?.confidence,
    abstained: !usable,
    ...(!usable && { reason: 'error' as const }),
    method: result?.method,
    calibrated: result?.calibrated === true,
  }
  const decision: AnyDecision =
    spec.type === 'score'
      ? {
          ...common,
          type: 'score',
          level: top,
          value: top === null ? null : labels.findIndex((l) => l.id === top),
          expected: usable ? labels.reduce((sum, l, i) => sum + i * probs[l.id], 0) : null,
        }
      : spec.type === 'noul'
        ? {
            ...common,
            type: 'noul',
            holds: top === null ? null : top === 'true',
            pTrue: usable ? probs.true : null,
          }
        : {
            ...common,
            label: top,
            margin: usable
              ? Math.max(...labels.map((l) => probs[l.id])) -
                [...labels.map((l) => probs[l.id])].sort((a, b) => b - a)[1]
              : 0,
          }
  return {
    decision,
    event: {
      ...common,
      question: spec.question,
      labels: [...labels],
      probs: { ...common.probs },
      label: top,
      margin: 'margin' in decision ? decision.margin : 0,
      stateChars: input.state.length,
      ...(spec.type === 'score' && {
        type: 'score',
        value: (decision as ScoreDecision).value,
        expected: (decision as ScoreDecision).expected,
      }),
      ...(spec.type === 'noul' && { type: 'noul', pTrue: (decision as NoulDecision).pTrue }),
      ...(input.shadow && { shadow: true }),
    },
  }
}

// ============================================================================
// The awaited wrapper — evaluateDecision / decide / decideFields (T2)
// ============================================================================

/** A string type argument retains the legacy choice-label form. */
type SpecFor<S extends AnyDecisionSpec | string> = [S] extends [string]
  ? DecisionSpec<S & string>
  : Extract<S, AnyDecisionSpec>

export interface DecisionCall<S extends AnyDecisionSpec | string = DecisionSpec> {
  readonly decide: DecideFn
  readonly spec: SpecFor<S>
  /** The text the decision is asked over. Only its LENGTH is recorded. */
  readonly state: string
  /** A shadow-mode caller: recorded on the event, changes no verdict. */
  readonly shadow?: true
  /** Handed to the transport as `DecideInput.signal`. */
  readonly signal?: AbortSignal
}

/** What {@link evaluateDecision} hands back: the verdict, the event data to
 *  record, and — when something failed — the error to record beside it. */
export type EvaluatedDecision<S extends AnyDecisionSpec | string = DecisionSpec> = Evaluation<
  DecisionFor<SpecFor<S>>
>

interface Evaluation<D extends AnyDecision> {
  readonly decision: D
  readonly event: DecisionMadeEventData
  /** The transport's call record. Rides on the `error` event when `error.kind`
   *  is `'llm_call'` (the call threw), otherwise on `decision_made`: the record
   *  is attached to exactly ONE event, so its cost is counted once. */
  readonly llmCall?: LLMCallRecord
  /** Present when the seam threw OR returned no usable distribution. */
  readonly error?: ErrorEventData
}

/** Options for the in-scope entries. */
export interface DecideOptions {
  /** Which event types the scope records. Default `'decision_made'`. `error`
   *  is always recorded, whatever this says. */
  readonly trackHistory?: TrackHistory

  readonly errorSeverity?: 'recoverable' | 'irrecoverable'
  /** Record the call WITHOUT what it read (`redactCall`): for a state quoting
   *  text that must not reach the persisted blob through the event — recalled
   *  memory, which `serializeContext` keeps out of `data` for the same reason
   *  (#419 F1). Usage, cost and the client survive. */
  readonly redact?: boolean
}

export function readContextWindow(fn: { limits?: DecideFn['limits'] } | undefined): number {
  try {
    const w = fn?.limits?.().contextWindow
    return typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : DEFAULT_CONTEXT_WINDOW
  } catch {
    return DEFAULT_CONTEXT_WINDOW
  }
}

/** The state window when the transport reports none — the router's own default. */
const DEFAULT_CONTEXT_WINDOW = 16_384

/** Longest transport message an `error` event carries. */
const MAX_ERROR_CHARS = 500

/** A thrown value → the error event data, carrying the call record when the
 *  adapter attached one (`LLMCallError`). The message is REDACTED of the call's
 *  `state` and capped: a transport that echoes its request (an HTTP client, a
 *  BAML validation error with the prompt) would otherwise copy the state —
 *  which can hold sanitized mail or tool results — into an event that is
 *  JSON-dumped into LLM-facing views (SD-3). The state survives only in
 *  `llmCall.variables`. */
function errorFrom(e: unknown, state?: string): { error: ErrorEventData; llmCall?: LLMCallRecord } {
  const llmCall = e instanceof LLMCallError ? e.llmCall : undefined
  let message = e instanceof Error ? e.message : String(e)
  if (state) message = message.split(state).join('[state]')
  if (message.length > MAX_ERROR_CHARS) message = `${message.slice(0, MAX_ERROR_CHARS)}…`
  return {
    error: { error: message, ...(llmCall ? { kind: 'llm_call' as const } : {}) },
    ...(llmCall ? { llmCall } : {}),
  }
}

export async function evaluateDecision<S extends AnyDecisionSpec>(
  call: Omit<DecisionCall<S>, 'spec'> & { readonly spec: S },
): Promise<EvaluatedDecision<S>> {
  let result: DecideResult<string> | undefined
  let failure: ReturnType<typeof errorFrom> | undefined
  try {
    if (!(call.decide.supportedTypes ?? ['choice']).includes(call.spec.type ?? 'choice'))
      throw new Error('Unsupported decision type')
    result = await call.decide({
      spec: call.spec,
      state: call.state,
      ...(call.signal && { signal: call.signal }),
    })
  } catch (e) {
    failure = errorFrom(e, call.state)
  }
  const scored = scoreDecision({ ...call, result, error: failure?.error })
  return {
    ...scored,
    llmCall: failure?.llmCall ?? result?.llmCall,
    ...(scored.decision.reason === 'error' && {
      error: failure?.error ?? {
        error: `Decision '${call.spec.key}' returned no usable distribution`,
      },
    }),
  } as EvaluatedDecision<S>
}

/** Record one evaluated decision on the scope: exactly ONE `decision_made`,
 *  and — when it failed — ONE `error`. Returns the decision stamped with the
 *  recorded event's id (absent when `trackHistory` filtered the event out). */
function record(
  scope: PatternScope<unknown>,
  evaluated: EvaluatedDecision<AnyDecisionSpec>,
  opts: DecideOptions,
  recordError = true,
): AnyDecision {
  const errorOwnsCall = evaluated.error?.kind === 'llm_call'
  const call = opts.redact ? redactCall(evaluated.llmCall) : evaluated.llmCall
  const before = scope.events.length
  trackEvent(
    scope,
    'decision_made',
    evaluated.event,
    opts.trackHistory ?? 'decision_made',
    errorOwnsCall ? undefined : call,
  )
  const recorded = scope.events[before]
  const eventId = recorded?.type === 'decision_made' ? recorded.id : undefined
  if (evaluated.error && recordError) {
    trackEvent(
      scope,
      'error',
      {
        ...evaluated.error,
        severity: opts.errorSeverity ?? 'recoverable',
        hint: getErrorHint(evaluated.error.error),
      } as ErrorEventData,
      true,
      errorOwnsCall ? call : undefined,
    )
  }
  return (eventId ? { ...evaluated.decision, eventId } : evaluated.decision) as AnyDecision
}

/** Record one decision and its call or error exactly once. */
export async function decide<S extends AnyDecisionSpec>(
  scope: PatternScope<unknown>,
  call: Omit<DecisionCall<S>, 'spec'> & { readonly spec: S },
  opts: DecideOptions = {},
): Promise<DecisionFor<S>> {
  return record(scope, await evaluateDecision(call), opts) as DecisionFor<S>
}

// --- decideFields ---------------------------------------------------------

/** Several typed fields over ONE state. */
type SpecsFor<F extends Record<string, string | AnyDecisionSpec>> = {
  readonly [K in keyof F]: F[K] extends AnyDecisionSpec ? F[K] : DecisionSpec<F[K] & string>
}

export interface DecideFieldsCall<F extends Record<string, string | AnyDecisionSpec>> {
  readonly decide: DecideFn

  readonly decideAll?: DecideAllFn
  readonly set: MixedDecisionSet<SpecsFor<F>>
  readonly state: string
}

/** Validate each question independently; systemone serves the set in one request. */
export function assertDecisionSetSpec(
  set: MixedDecisionSet<Record<string, AnyDecisionSpec>>,
): void {
  for (const spec of Object.values(set.fields)) {
    if (spec.type !== 'noul')
      assertOptions(
        'defineDecisionSet',
        categoricalOptions(spec),
        spec.type === 'score' ? MAX_SCORE_LEVELS : Infinity,
      )
  }
}

export async function decideFields<F extends Record<string, AnyDecisionSpec>>(
  scope: PatternScope<unknown>,
  call: DecideFieldsCall<F>,
  opts: DecideOptions = {},
): Promise<{ [K in keyof F]: DecisionFor<F[K]> }> {
  assertDecisionSetSpec(call.set)
  let results: Record<string, DecideResult<string>> = {}
  let failure: ReturnType<typeof errorFrom> | undefined
  if (call.decideAll) {
    try {
      results = (await call.decideAll({ spec: call.set, state: call.state })).fields
    } catch (e) {
      failure = errorFrom(e, call.state)
    }
  }
  const out: Record<string, AnyDecision> = {}
  const seenCalls = new Set<LLMCallRecord>()
  let recordedError = false
  for (const [key, spec] of Object.entries(call.set.fields)) {
    const evaluated = call.decideAll
      ? (() => {
          const scored = scoreDecision({
            spec,
            state: call.state,
            result: results[key],
            error: failure?.error,
          })
          return {
            ...scored,
            llmCall: failure?.llmCall ?? results[key]?.llmCall,
            ...(scored.decision.reason === 'error' && {
              error: failure?.error ?? {
                error: `Decision '${spec.key}' returned no usable distribution`,
              },
            }),
          }
        })()
      : await evaluateDecision({ decide: call.decide, spec, state: call.state })
    const duplicate = evaluated.llmCall && seenCalls.has(evaluated.llmCall)
    if (evaluated.llmCall) seenCalls.add(evaluated.llmCall)
    out[key] = record(
      scope,
      duplicate ? { ...evaluated, llmCall: undefined } : evaluated,
      opts,
      !recordedError,
    )
    if (evaluated.error) recordedError = true
  }
  return out as { [K in keyof F]: DecisionFor<F[K]> }
}

// ============================================================================
// The patterns — typedDecision and decisionRouter (T2)
// ============================================================================

/** What `typedDecision` writes: the verdict per spec key. Overwritten every
 *  turn, including failures — `scope.data` survives the turn boundary, so a
 *  decision left in place would be last turn's. */
export interface TypedDecisionData {
  decisions?: Record<string, AnyDecision>
}

/** The default decision state: the window's user messages plus FINAL
 *  assistant messages (the router's intermediate status lines are not part of
 *  the conversation), think-blocks stripped, oldest dropped to fit the
 *  transport's window. Tool results are opt-in — pass your own `state`: an
 *  assistant reply can echo untrusted tool content, and what a steered
 *  decision reads is the consumer's call, not a default's. */
function renderDefaultState(view: EventView, fn: DecideFn): string {
  return trimToFit(conversationTurns(view), (t) => t.join('\n\n'), 300, readContextWindow(fn)).join(
    '\n\n',
  )
}

/** The conversation lines of a decision state, oldest first, untrimmed: the
 *  window's user messages and FINAL assistant messages. Shared with
 *  `decisionLoop`, whose state starts with the same lines. */
export function conversationTurns(view: EventView): string[] {
  return view
    .get()
    .map((e): ContextEvent => stripThinkBlocks(e))
    .flatMap((e) => {
      if (e.type === 'user_message') {
        return [`User: ${(e.data as UserMessageEventData).content}`]
      }
      if (e.type === 'assistant_message' && (e.data as AssistantMessageEventData).final === true) {
        return [`Assistant: ${(e.data as AssistantMessageEventData).content}`]
      }
      return []
    })
}

/** The default decision window, shared with `decisionLoop`. */
export const decisionWindowView = defaultDecisionView

/** The default window: the router's — recent user/assistant messages across
 *  turns. Soft read of the run frame for the same reason `router()` reads it:
 *  this runs at CONSTRUCTION, which is not a run. */
function defaultDecisionView(customState: boolean): ViewConfig {
  return {
    fromLast: false,
    fromLastNTurns: (currentRunFrame()?.config ?? DEFAULT_RUNTIME_CONFIG).routerTurnWindow,
    // A caller-supplied `state` reads the view itself, so the window must not
    // pre-narrow it to messages — otherwise tool results (opt-in) are invisible
    // to the very builder that asked for them.
    ...(customState ? {} : { eventTypes: ['user_message', 'assistant_message'] as const }),
    contentTransforms: [stripThinkBlocks],
  }
}

/** Every spec is categorical at the raw seam, including a noul's two values. */
function categoricalOptions(spec: AnyDecisionSpec): readonly DecisionLabel[] {
  if (spec.type === 'score') return spec.levels
  if (spec.type === 'noul')
    return [
      { id: 'true', description: spec.criteria?.true ?? 'Yes — the statement holds' },
      { id: 'false', description: spec.criteria?.false ?? 'No — the statement does not hold' },
    ]
  return spec.labels
}

export function defineDecisionSet<const S extends Record<string, AnyDecisionSpec>>(
  set: MixedDecisionSet<S>,
): MixedDecisionSet<S> {
  assertDecisionSetSpec(set)
  return set
}

export interface TypedDecisionConfig<
  S extends AnyDecisionSpec | string = DecisionSpec,
> extends PatternConfig {
  /** REQUIRED: the raw decision seam (`bamlPatterns().decide`, or your own). */
  readonly decide: DecideFn
  readonly spec: SpecFor<S>
  /** Render the state the decision is asked over. Default: see
   *  {@link renderDefaultState} — messages only. */
  readonly state?: (view: EventView, data: Readonly<Record<string, unknown>>) => string
}

export function typedDecision<T extends TypedDecisionData, S extends AnyDecisionSpec | string>(
  config: TypedDecisionConfig<S> & { readonly spec: S },
): ConfiguredPattern<T>
export function typedDecision<T extends TypedDecisionData, L extends string>(
  config: Omit<TypedDecisionConfig<L>, 'spec'> & {
    readonly spec: DecisionSpec<L>
  },
): ConfiguredPattern<T>
export function typedDecision<T extends TypedDecisionData>(
  config: TypedDecisionConfig<AnyDecisionSpec>,
): ConfiguredPattern<T> {
  const { decide: decideFn, spec, state: stateFn, ...patternConfig } = config
  if (!(decideFn.supportedTypes ?? ['choice']).includes(spec.type ?? 'choice')) {
    throw new Error(
      `typedDecision: unsupported decision type '${spec.type ?? 'choice'}' for '${spec.key}'`,
    )
  }
  const resolved = resolveConfig('typedDecision', {
    viewConfig: defaultDecisionView(stateFn !== undefined),
    ...patternConfig,
  })

  const fn = async (scope: PatternScope<T>, view: EventView): Promise<PatternScope<T>> => {
    let state = ''
    let stateError: ErrorEventData | undefined
    try {
      state = stateFn
        ? stateFn(view, scope.data as unknown as Readonly<Record<string, unknown>>)
        : renderDefaultState(view, decideFn)
    } catch (e) {
      stateError = { error: `typedDecision state builder failed: ${errorFrom(e).error.error}` }
    }
    const opts = { trackHistory: resolved.trackHistory, errorSeverity: resolved.errorSeverity }
    const decision = stateError
      ? record(
          scope,
          { ...scoreDecision({ spec, state, error: stateError }), error: stateError },
          opts,
        )
      : await decide(scope, { decide: decideFn, spec, state }, opts)
    scope.data = { ...scope.data, decisions: { ...scope.data.decisions, [spec.key]: decision } }
    return scope
  }

  return {
    name: 'typedDecision',
    fn,
    config: resolved,
    estimateTurns: () => 1,
    capabilities: { decisionKeys: [spec.key] },
  }
}

export const DECISION_ROUTER_KEY = 'route'

export interface DecisionRouterConfig extends PatternConfig {
  /** REQUIRED: the raw decision seam. */
  readonly decide: DecideFn

  /** "No tool — just answer": an ORDINARY route key `routes()` dispatches to a
   *  pass-through. Never `DIRECT_RESPONSE_ROUTE`: a decision has no reply text
   *  to pass through, so that sentinel would end the turn empty. */
  readonly conversationalRoute?: { readonly name: string; readonly description: string }
  /** Leave `data.intent` alone (compose after `compactIntent`, which rewrites
   *  it every turn). Default false: clear it, so a conversation migrated from
   *  `router()` cannot carry the old router's intent into the next loop. */
  readonly preserveIntent?: boolean
  /** Record the decision and set NOTHING — run beside `router()` to measure
   *  agreement. A shadow failure is always recoverable. */
  readonly shadow?: boolean
}

export function decisionRouter<T extends RouterData & TypedDecisionData>(
  routeDescriptions: Routes,
  config: DecisionRouterConfig,
): ConfiguredPattern<T> {
  const { decide: decideFn, conversationalRoute, preserveIntent, shadow, ...rest } = config
  const labels: DecisionLabel[] = [
    ...Object.entries(routeDescriptions).map(([id, description]) => ({ id, description })),
    ...(conversationalRoute
      ? [{ id: conversationalRoute.name, description: conversationalRoute.description }]
      : []),
  ]
  const ids = labels.map((l) => l.id)
  if (new Set(ids).size !== ids.length) {
    throw new Error('decisionRouter: route names must be unique (check conversationalRoute)')
  }
  if (ids.includes(DIRECT_RESPONSE_ROUTE)) {
    throw new Error(
      `decisionRouter: a route may not be named '${DIRECT_RESPONSE_ROUTE}' — that is the direct-response sentinel, and a decision has no reply to pass through`,
    )
  }
  const spec: DecisionSpec = {
    key: DECISION_ROUTER_KEY,
    question: "Which route should handle the user's latest message?",
    labels,
  }
  const resolved = resolveConfig('decisionRouter', {
    viewConfig: defaultDecisionView(false),
    ...rest,
  })

  /** Drop the routing carried over from an earlier turn — same rule, same
   *  reason as `router`'s `clearRouting`. */
  const clearRouting = (scope: PatternScope<T>): void => {
    scope.data = { ...scope.data, route: undefined, intent: undefined }
  }

  const fn = async (scope: PatternScope<T>, view: EventView): Promise<PatternScope<T>> => {
    let state = ''
    let stateError: ErrorEventData | undefined
    try {
      state = renderDefaultState(view, decideFn)
    } catch (e) {
      stateError = { error: `decisionRouter state build failed: ${errorFrom(e).error.error}` }
    }
    const opts = {
      trackHistory: resolved.trackHistory,
      errorSeverity: shadow ? ('recoverable' as const) : resolved.errorSeverity,
    }
    const decision = stateError
      ? (record(
          scope,
          {
            ...scoreDecision({
              spec,
              state,
              error: stateError,
              ...(shadow && { shadow: true as const }),
            }),
            error: stateError,
          },
          opts,
        ) as Decision)
      : await decide(
          scope,
          { decide: decideFn, spec, state, ...(shadow && { shadow: true as const }) },
          opts,
        )
    if (shadow) return scope

    // A state that could not be built is a failure like any other: it must not
    // leave last turn's routing in `scope.data` (which survives the turn).
    const failedFatally =
      (decision.reason === 'error' || stateError !== undefined) &&
      resolved.errorSeverity === 'irrecoverable'
    if (failedFatally) {
      clearRouting(scope)
    } else {
      scope.data = {
        ...scope.data,
        route: decision.label ?? undefined,
        ...(preserveIntent ? {} : { intent: undefined }),
      }
    }
    scope.data = { ...scope.data, decisions: { ...scope.data.decisions, [spec.key]: decision } }
    return scope
  }

  return {
    name: 'decisionRouter',
    fn,
    config: resolved,
    estimateTurns: () => 1,
    capabilities: { decisionKeys: [spec.key] },
  }
}
