/**
 * The answer writer's evidence for one `decisionLoop` route call (#1032): the
 * route's complete internal trace, in place of its compact record.
 *
 * The decisions model keeps reading the compact records; only the writer
 * changes, and only on a loop configured `writerEvidence: 'trace'`. Two halves,
 * both here so one module owns what a trace is:
 *
 *   1. {@link routeTraceRef}, called by the loop when it writes a route record:
 *      the ids of the route's own committed events a trace is built from. The
 *      record's `tool_result` carries them (`routeRecord.trace`). Ids, never
 *      content, so the conversation blob holds each result once and the record
 *      event streamed to the browser stays small.
 *   2. {@link renderRouteTrace}, called by `compactExecution` for a record of
 *      THIS turn: resolves those ids against the turn's events and renders, in
 *      order, every controller action with its reasoning, every tool call
 *      (name and arguments) and every tool result, under the route call and its
 *      status line. An earlier turn's record is never expanded: the previous
 *      turn keeps its compact record.
 *
 * What the trace is, by route kind:
 *
 *   - every kind: errored steps are left out — a call whose result failed (with
 *     its action when all of the action's calls failed), and a round the loop
 *     recovered from (a refused tool, unusable arguments, an unparseable
 *     answer, a rejected `Return`) — and counted on the route call, whose
 *     status line keeps the route's failure, so a lookup that could not be done
 *     is still reported;
 *   - `simpleLoop`: its rounds and its terminal `Return` (the route's answer);
 *   - `actorCritic`: every attempt, numbered, with the critic's verdict on it —
 *     `accepted`, `rejected` (the writer's prompt says a rejected attempt's
 *     output is not the answer) or `not judged` (no critic ran after it) — and
 *     each verdict in order with the critic's explanation;
 *   - `planner`: the plan text with its reasoning;
 *   - `retriever`: its query, every passage in full with its source and
 *     locator, and the references citations are built from.
 *
 * Untrusted content reaches the writer exactly as the injection guard left it.
 * Every result is the committed event's own value: sanitised at `callTool`, or
 * in the retriever's assembly, with its provenance fence, its spotlighting and
 * its neutralised markers in place, plus the event's redacted `sanitized`
 * summary and `ingress` marks. Nothing here sanitises, screens, strips a fence
 * or re-reads a transport. Three projections only REMOVE what the route never
 * handed a model, and add nothing: the fields its controller did not see
 * (`simpleLoop`'s `resultOmit`, e.g. the graph tab's neighbourhood), a retrieved
 * hit's unscanned `metadata` and backend fields (the retriever's guard scans
 * `content` and `source` only, and its locators are code-written), and a result
 * the person hid or archived. `content_sanitized` — the one event holding the
 * matched injection span verbatim (SD-3) — is never read, and neither is
 * `error`.
 */

import { assertServerOnImport } from '../assert.server'
import { omitResultFields } from '../content-transforms'
import type { IngressMark, SanitizeSummary } from '../injection-guard'
import type {
  ContextEvent,
  ControllerActionEventData,
  CriticResultEventData,
  LoopRecoveryEventData,
  PlanCreatedEventData,
  RouteTraceRef,
  ToolCallEventData,
  ToolResultEventData,
} from '../types'
import type { RetrieverResult } from './retriever.server'

assertServerOnImport()

/** What the answer writer reads for each route call of this turn: today's
 *  capped `record`, or the route's complete `trace` (#1032). */
export type WriterEvidence = 'record' | 'trace'

/** The event types a trace is built from. Never `content_sanitized` (SD-3),
 *  never `error`. */
export const TRACE_EVENT_TYPES: ReadonlySet<string> = new Set([
  'controller_action',
  'tool_call',
  'tool_result',
  'critic_result',
  'plan_created',
  'loop_recovery',
])

/** The ids of a route call's own committed events of the trace's types, in
 *  order. `events` are the route's leaf events (its own patternId). */
export function routeTraceRef(
  kind: string,
  events: readonly ContextEvent[],
  omit: Record<string, readonly string[]> | undefined,
): RouteTraceRef {
  return {
    kind,
    events: events.flatMap((e) => (e.id && TRACE_EVENT_TYPES.has(e.type) ? [e.id] : [])),
    ...(omit && Object.keys(omit).length > 0 ? { omit } : {}),
  }
}

/** One tool call of a step, with its result when it came back successful. */
export interface TraceCall {
  readonly tool: string
  readonly args?: unknown
  readonly result?: unknown
  /** The guard's redacted summary: counts and rule ids, never the span. */
  readonly sanitized?: SanitizeSummary
  /** The ingress classification's marks: labels, never content. */
  readonly ingress?: readonly IngressMark[]
}

/** A verdict on an `actorCritic` attempt. */
export type AttemptVerdict = 'accepted' | 'rejected' | 'not judged'

export type TraceStep =
  | {
      readonly attempt?: number
      readonly verdict?: AttemptVerdict
      readonly reasoning?: string
      readonly calls: readonly TraceCall[]
    }
  | { readonly return: string; readonly reasoning?: string }
  | { readonly critic: 'accepted' | 'rejected'; readonly explanation: string }
  | { readonly plan: string; readonly reasoning?: string; readonly steps?: number }

/** One route call as the answer writer reads it. */
export interface RouteTrace {
  readonly route: string
  /** The record's step line: status and stats, counted by code. */
  readonly status: string
  /** A failed route call's failure text (the record's own, capped). */
  readonly error?: string
  /** Steps left out because they errored; absent when none did. */
  readonly erroredStepsLeftOut?: number
  readonly steps: readonly TraceStep[]
}

/** What the record knows that the events do not. */
export interface RouteTraceHead {
  readonly route: string
  readonly status: string
  readonly error?: string
}

type BuildingCall = {
  tool: string
  args?: unknown
  callId?: string
  result?: ToolResultEventData
}
type BuildingAction = {
  kind: 'action'
  turn?: number
  attempt?: number
  verdict?: AttemptVerdict
  reasoning?: string
  calls: BuildingCall[]
  errored?: boolean
}
type BuildingReturn = {
  kind: 'return'
  turn?: number
  text: string
  reasoning?: string
  errored?: boolean
}
type Building =
  | BuildingAction
  | BuildingReturn
  | { kind: 'critic'; verdict: 'accepted' | 'rejected'; explanation: string }
  | { kind: 'plan'; plan: string; reasoning?: string; steps?: number }
  | { kind: 'retrieval'; result: ToolResultEventData }

/** A recovery that is not about a tool's result: the round's action never ran
 *  as a call (refused, unusable, unparseable) or its `Return` was refused. A
 *  failed result is caught by its own `success: false`. */
const ROUND_FAILURES = new Set([
  'return_rejected',
  'tool_not_allowed',
  'invalid_tool_args',
  'unparseable_output',
])

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value : undefined

/** The retriever's result with each hit cut to the fields its guard scanned
 *  (`content`, `source`) and its code-written locators, and its references. */
function projectRetrieval(result: unknown): unknown {
  const r = result as RetrieverResult | undefined
  if (!r || typeof r !== 'object' || !Array.isArray(r.matches)) return result
  return {
    query: r.query,
    passages: r.matches.map((m) => ({
      ...(m.source !== undefined ? { source: m.source } : {}),
      ...(m.docId !== undefined ? { docId: m.docId } : {}),
      ...(m.chunkIndex !== undefined ? { chunkIndex: m.chunkIndex } : {}),
      ...(m.startOffset !== undefined ? { startOffset: m.startOffset } : {}),
      ...(m.endOffset !== undefined ? { endOffset: m.endOffset } : {}),
      content: m.content,
    })),
    references: Array.isArray(r.references) ? r.references : [],
  }
}

/** A successful result as the trace shows it: the event's own value, less the
 *  fields the route's controller never saw. */
function shownCall(call: BuildingCall, omit: RouteTraceRef['omit'], retrieval: boolean): TraceCall {
  const r = call.result!
  return {
    tool: call.tool,
    ...(call.args !== undefined ? { args: call.args } : {}),
    result: retrieval ? projectRetrieval(r.result) : omitResultFields(r.result, omit?.[call.tool]),
    ...(r.sanitized ? { sanitized: r.sanitized } : {}),
    ...(r.ingress?.length ? { ingress: r.ingress } : {}),
  }
}

/**
 * The route call's trace, from the committed events its record names. An id
 * the turn does not hold is skipped (a trace never invents a step), and an
 * event of any type outside {@link TRACE_EVENT_TYPES} renders nothing whatever
 * the record says: the switch below has a case for those types only, which is
 * the one place that decides what reaches the writer.
 */
export function renderRouteTrace(
  ref: RouteTraceRef,
  eventsById: ReadonlyMap<string, ContextEvent>,
  head: RouteTraceHead,
): RouteTrace {
  const events = ref.events
    .map((id) => eventsById.get(id))
    .filter((e): e is ContextEvent => e !== undefined)
  const actorCritic = ref.kind === 'actorCritic'
  const steps: Building[] = []
  // The step a recovery or a call belongs to: the latest action (or Return).
  let current: BuildingAction | BuildingReturn | undefined
  // actorCritic attempts no verdict has covered yet.
  let pending: BuildingAction[] = []
  let attempts = 0
  let leftOut = 0

  for (const e of events) {
    switch (e.type) {
      case 'controller_action': {
        const d = e.data as ControllerActionEventData
        const a = d.action
        if (!actorCritic && a.tool_name === 'Return') {
          current = {
            kind: 'return',
            turn: d.turn,
            text: a.tool_args ?? '',
            ...(text(a.reasoning) ? { reasoning: a.reasoning } : {}),
          }
        } else {
          current = {
            kind: 'action',
            turn: d.turn,
            ...(actorCritic ? { attempt: ++attempts } : {}),
            ...(text(a.reasoning) ? { reasoning: a.reasoning } : {}),
            calls: [],
          }
          if (actorCritic) pending.push(current)
        }
        steps.push(current)
        break
      }
      case 'tool_call': {
        if (current?.kind !== 'action') break
        const d = e.data as ToolCallEventData
        current.calls.push({ tool: d.tool, args: d.args, callId: d.callId })
        break
      }
      case 'tool_result': {
        const d = e.data as ToolResultEventData
        if (d.hidden || d.archived) {
          // The person took this result out of every model's context.
          if (current?.kind === 'action') {
            const at = current.calls.findIndex(
              (c) => c.callId !== undefined && c.callId === d.callId,
            )
            if (at >= 0) current.calls.splice(at, 1)
          }
          break
        }
        if (current?.kind === 'action') {
          // The latest result of a call wins: a held call released by a person
          // ran again under the same callId (slice 10).
          const call =
            current.calls.find((c) => c.callId !== undefined && c.callId === d.callId) ??
            current.calls.find((c) => c.result === undefined && c.tool === d.tool)
          if (call) call.result = d
          else current.calls.push({ tool: d.tool, result: d })
        } else if (d.success !== false) {
          // A result with no action: the retriever's one search.
          steps.push({ kind: 'retrieval', result: d })
        } else {
          leftOut++
        }
        break
      }
      case 'loop_recovery': {
        const d = e.data as LoopRecoveryEventData
        if (!ROUND_FAILURES.has(d.failure)) break
        if (current && current.turn === d.turn && !current.errored) current.errored = true
        else if (d.failure === 'unparseable_output') leftOut++ // a round with no action
        break
      }
      case 'critic_result': {
        const d = e.data as CriticResultEventData
        const verdict = d.result.is_sufficient ? 'accepted' : 'rejected'
        for (const attempt of pending) attempt.verdict = verdict
        pending = []
        steps.push({ kind: 'critic', verdict, explanation: d.result.explanation ?? '' })
        break
      }
      case 'plan_created': {
        const plan = (e.data as PlanCreatedEventData).plan
        if (plan?.plan?.trim()) {
          steps.push({
            kind: 'plan',
            plan: plan.plan,
            ...(text(plan.reasoning) ? { reasoning: plan.reasoning } : {}),
            ...(plan.n_steps !== undefined ? { steps: plan.n_steps } : {}),
          })
        }
        break
      }
    }
  }
  for (const attempt of pending) attempt.verdict = 'not judged'

  const rendered: TraceStep[] = []
  for (const s of steps) {
    if (s.kind === 'action') {
      if (s.errored) {
        leftOut++
        continue
      }
      const failed = s.calls.filter((c) => c.result?.success === false)
      leftOut += failed.length
      // A call with no result shows its arguments only (an actorCritic attempt
      // that repeated the call before it was not dispatched again).
      const kept = s.calls.filter((c) => c.result?.success !== false)
      if (s.calls.length > 0 && kept.length === 0) continue
      rendered.push({
        ...(s.attempt !== undefined ? { attempt: s.attempt, verdict: s.verdict } : {}),
        ...(s.reasoning ? { reasoning: s.reasoning } : {}),
        calls: kept.map((c) =>
          c.result
            ? shownCall(c, ref.omit, false)
            : { tool: c.tool, ...(c.args !== undefined ? { args: c.args } : {}) },
        ),
      })
    } else if (s.kind === 'return') {
      if (s.errored) leftOut++
      else rendered.push({ return: s.text, ...(s.reasoning ? { reasoning: s.reasoning } : {}) })
    } else if (s.kind === 'critic') {
      rendered.push({ critic: s.verdict, explanation: s.explanation })
    } else if (s.kind === 'plan') {
      rendered.push({
        plan: s.plan,
        ...(s.reasoning ? { reasoning: s.reasoning } : {}),
        ...(s.steps !== undefined ? { steps: s.steps } : {}),
      })
    } else {
      rendered.push({
        calls: [shownCall({ tool: s.result.tool, result: s.result }, ref.omit, true)],
      })
    }
  }

  return {
    route: head.route,
    status: head.status,
    ...(head.error ? { error: head.error } : {}),
    ...(leftOut > 0 ? { erroredStepsLeftOut: leftOut } : {}),
    steps: rendered,
  }
}

/** Whether a value is a {@link RouteTrace} this module rendered. Read on the
 *  synthesizer's own iteration flag, never on a tool result's shape. */
export function isRouteTrace(value: unknown): value is RouteTrace {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as RouteTrace).route === 'string' &&
    typeof (value as RouteTrace).status === 'string' &&
    Array.isArray((value as RouteTrace).steps)
  )
}
