/**
 * Simple Loop Pattern
 *
 * ReAct-style decide-execute loop.
 * Calls BAML controller function directly, extracting params from context.
 */

import { assertServerOnImport } from '../assert.server'
import { callTool, preflightTool } from '../mcp-client.server'
import { isAgentWithheldTool } from '../agent-withheld-tools'
import {
  repairJson,
  repairJsonTracked,
  TooLongToRepairError,
  type JsonRepairNote,
} from '../json-repair'
import { normalizeControllerAction } from '../controller-action'
import type { LoopTurn, PriorResult, ExpandedRef } from '../types'
import type {
  ContextEvent,
  ControllerAction,
  LoopRecoveryEventData,
  SimpleLoopConfig,
  PatternScope,
  EventView,
  ConfiguredPattern,
  ToolCallEventData,
  ToolCallResult,
  ToolResultEventData,
  ControllerActionEventData,
  HitlOption,
  HitlRequestEventData,
} from '../types'
import { EXPAND_TOOL_NAME } from '../types'

import type { ErrorEventData, MultiCallMode, ReturnStyle } from '../types'
import { runBatch, combineOutcomes } from '../parallel-tools.server'
import type { SubCall, SubCallOutcome } from '../parallel-tools.server'
import { getErrorHint, budgetHint } from '../error-hints'
import { trackEvent, resolveConfig, generateId, shouldTrack } from '../context.server'
import { createHash } from 'node:crypto'
import {
  askHumanHolding,
  canPauseHere,
  canonicalJson,
  currentRunId,
  hitlPending,
  holdingAnswerInRun,
  holdingRequestInRun,
  isHeldResult,
  recordedHolding,
} from '../hitl.server'
import { omitResultFields } from '../content-transforms'
import { resolveTurnBudget, runtimeConfig } from '../runtime-config.server'
import { activeTransports } from '../tool-transport.server'
import { amendRunFrame, currentRunFrame } from '../run-frame.server'
import { onPath, resumableFingerprint, takeResume } from '../resume.server'
import { toolSurfaceOutage } from '../gateway-health.server'
import {
  isRecoverableLLMFailure,
  unparseableOutputFeedback,
  invalidToolArgsFeedback,
  trackLoopRecovery,
  resolveMaxConsecutiveRecoveries,
  recoveryStreak,
  recoveryExhaustedMarker,
} from '../loop-recovery.server'
import { trimToFit } from '../token-budget.server'
import type { ControllerFn } from '../types'
import type { LLMCallRecord } from '../types'
import { LLMCallError } from '../types'
import { formatPlanContext, type PlannerData } from './planner.server'
import {
  EGRESS_BATCH_RELEASE_KIND,
  EGRESS_BATCH_MISMATCH,
  EGRESS_RELEASE_KIND,
  EGRESS_OWNER_REFUSED,
  EGRESS_OWNER_REFUSED_ALL,
} from './withEgressGate.server'
import { EGRESS_TEXTS } from '../egress-gate.server'

assertServerOnImport()

// ============================================================================
// Reference Resolution
// ============================================================================

/**
 * Resolve `ref:<eventId>` values in tool args by expanding them to the full
 * tool result data from the UnifiedContext, **and** capture each successful
 * substitution so the controller can see (in the next turn's prompt) what
 * was inlined this turn.
 */
/**
 * Parse the `tool_args` of an `expandPreviousResult` call into a list of
 * ref_ids. Accepts the canonical compact form and a JSON-object form
 * for resilience against LLMs that ignore the prompt's args contract.
 *
 *   "ref:abc"                    → ["abc"]
 *   "ref:abc,def,ghi"            → ["abc", "def", "ghi"]
 *   '{"ref_id": "abc"}'          → ["abc"]
 *   '{"ref_ids": ["abc","def"]}' → ["abc", "def"]
 *
 * Whitespace around individual ids is trimmed; empty entries are dropped.
 * Returns [] when no parseable id is present (caller treats as failure).
 */
function parseExpandRefs(argsStr: string): string[] {
  const trimmed = argsStr.trim()
  if (trimmed.startsWith('ref:')) {
    return trimmed
      .slice(4)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  try {
    const parsed = repairJson(trimmed)
    if (Array.isArray(parsed.ref_ids)) {
      return parsed.ref_ids
        .filter((x: unknown): x is string => typeof x === 'string')
        .map((s: string) => (s.startsWith('ref:') ? s.slice(4) : s).trim())
        .filter(Boolean)
    }
    const single = parsed.ref_id ?? parsed.ref ?? parsed.id
    if (typeof single === 'string') {
      const s = single.trim()
      const id = s.startsWith('ref:') ? s.slice(4) : s
      return id ? [id] : []
    }
  } catch {
    /* fall through to [] */
  }
  return []
}

// Deliberately NOT subject to `resultOmit`: `resolved[key]` is the actual input
// handed to a real tool (projecting it would corrupt tool inputs), and the
// expansions echo is the record of what was really inlined into the call.
function resolveRefsAndCapture(
  args: Record<string, unknown>,
  view: EventView,
  maxResultChars: number,
  excluded: ReadonlySet<string> = NONE,
): { resolved: Record<string, unknown>; expansions: ExpandedRef[] } {
  const resolved = { ...args }
  const expansions: ExpandedRef[] = []
  const allEvents = visible(view.fromAll().get(), excluded)
  for (const [key, value] of Object.entries(resolved)) {
    if (typeof value === 'string' && value.startsWith('ref:')) {
      const eventId = value.slice(4)
      const event = allEvents.find((e) => e.id === eventId)
      if (event && event.type === 'tool_result') {
        const d = event.data as ToolResultEventData
        // Skip hidden/archived results — refs to excluded data stay unresolved
        if (!d.hidden && !d.archived) {
          resolved[key] = d.result
          const raw = typeof d.result === 'string' ? d.result : JSON.stringify(d.result)
          expansions.push({
            ref_id: eventId,
            content:
              raw.length > maxResultChars ? raw.slice(0, maxResultChars) + '…[truncated]' : raw,
          })
        }
      }
    }
  }
  return { resolved, expansions }
}

// ============================================================================
// The turn log: one projection of a round's events (resume inside a route)
// ============================================================================

const NONE: ReadonlySet<string> = new Set()

/** The events a view offers, without the ones a resumed invocation recorded
 *  itself: live, a loop never saw its own events through its view. */
function visible(events: ContextEvent[], excluded: ReadonlySet<string>): ContextEvent[] {
  return excluded.size === 0 ? events : events.filter((e) => !e.id || !excluded.has(e.id))
}

/**
 * One consumed round, as its events record it (slice 6). The live path builds
 * one from the event data it has just tracked, and a resume rebuilds every
 * round from the events the paused invocation recorded; both hand it to
 * {@link projectRound}, so the turn log a controller reads cannot differ
 * between an uninterrupted run and a resumed one.
 */
interface LoopRound {
  readonly n: number
  readonly action?: ControllerAction
  readonly recovery?: LoopRecoveryEventData
  readonly calls: readonly {
    readonly call: ToolCallEventData
    readonly result?: ToolResultEventData
  }[]
}

/** What a projection reads besides the round. */
interface Projection {
  readonly view: EventView
  readonly excluded: ReadonlySet<string>
  readonly maxResultChars: number
  readonly resultOmit: SimpleLoopConfig['resultOmit']
}

type BatchMember = {
  readonly index: number
  readonly callKey: string
  readonly digest: string
  readonly tool: string
  readonly args: Record<string, unknown>
  readonly verdict: 'pass' | 'held' | 'veto' | 'skipped'
  readonly auditByDecide?: boolean
  readonly route: string | null
  readonly cause?: 'decide' | 'unchecked'
  readonly category?: 'personal' | 'company'
  readonly denial?: string
}

type BatchRow = BatchMember & {
  readonly lines: readonly string[]
  readonly hosts: readonly string[]
  readonly spans: readonly string[]
}

interface EgressBatchPlan {
  readonly v: 1
  readonly mode: MultiCallMode
  readonly batchKey: string
  readonly action: ControllerAction
  readonly callIds: readonly string[]
  readonly errors: readonly (string | null)[]
  readonly members: readonly BatchMember[]
  readonly rows: readonly BatchRow[]
}

const batchDigest = (tool: string, args: Record<string, unknown>): string =>
  createHash('sha256').update(canonicalJson({ tool, args })).digest('hex')

const batchAuthorization = (plan: EgressBatchPlan) => ({
  batchKey: plan.batchKey,
  mode: plan.mode,
  members: plan.members.map(({ index, callKey, digest }) => [index, callKey, digest]),
  payloadDigest: createHash('sha256').update(canonicalJson(plan)).digest('hex'),
})

const batchOptions = (rows: readonly BatchRow[]): readonly HitlOption[] => [
  {
    id: 'continue',
    label: 'Continue with selected requests',
    unattended: true,
    flags: rows.map((r) => ({
      id: `accept:${r.callKey}`,
      label: `Request ${r.index + 1}`,
      default: false,
    })),
  },
  { id: 'refuse-all', label: 'Refuse all similar actions' },
  { id: 'interrupt', label: 'Interrupt', stopsRun: true },
]

/** N8 events carry only call shape; the exact action stays in the encrypted plan. */
function batchEventAction(action: ControllerAction): ControllerAction {
  return {
    reasoning: '',
    tool_name: action.tool_name,
    tool_args: '[batch arguments withheld]',
    status: 'Reviewing outgoing batch',
    is_final: false,
    additional_calls: action.additional_calls?.map((call) => ({
      tool_name: call.tool_name,
      tool_args: '[batch arguments withheld]',
    })),
  }
}

/** N8 errors may contain outgoing args (including repair and transport errors).
 * Only known fixed messages may enter an event or turn log. */
const SAFE_BATCH_ERRORS = new Set([
  ...Object.values(EGRESS_TEXTS),
  ...Object.values(EGRESS_TEXTS).map((error) => EGRESS_OWNER_REFUSED + error),
  EGRESS_OWNER_REFUSED_ALL + EGRESS_TEXTS.turnClosed,
  EGRESS_BATCH_MISMATCH,
  // The mcp-client constant is mirrored here so host tests that mock the
  // transport module do not need to supply an unrelated export at import time.
  'This request may have been sent, but its outcome was not recorded. It was not retried.',
  'skipped: an earlier call in this batch did not run',
])

function batchEventOutcome(
  outcome: SubCallOutcome,
  refusal: (tool: string) => string,
): SubCallOutcome {
  return outcome.error &&
    !SAFE_BATCH_ERRORS.has(outcome.error) &&
    outcome.error !== refusal(outcome.tool)
    ? { ...outcome, error: `Batch call ${outcome.index} failed; see encrypted plan.` }
    : outcome
}

const truncateTo = (s: string, max: number): string =>
  s.length > max ? s.slice(0, max) + '…[truncated]' : s

/** The `expandPreviousResult` round: its resolutions against the view, the
 *  events it records and its turn-log entry. Pure, so the live path and a
 *  resume compute the same thing. */
function expandRound(action: ControllerAction, p: Projection) {
  const refIds = parseExpandRefs(action.tool_args)
  const allEvents = visible(p.view.fromAll().get(), p.excluded)
  // `tool` is the ORIGIN tool of the referenced result — carried so the
  // per-tool `resultOmit` projection can key off it below.
  type Resolution = {
    ref_id: string
    success: boolean
    result: unknown
    error?: string
    tool: string | null
  }
  const resolutions: Resolution[] = refIds.map((refId) => {
    const refEvent = allEvents.find((e) => e.id === refId)
    const refData = refEvent?.type === 'tool_result' ? (refEvent.data as ToolResultEventData) : null
    const usable = refData && !refData.hidden && !refData.archived
    return usable
      ? { ref_id: refId, success: true, result: refData.result, tool: refData.tool ?? null }
      : {
          ref_id: refId,
          success: false,
          result: null,
          tool: null,
          error: `ref_id "${refId}" not found in tool_result events (or excluded as hidden/archived)`,
        }
  })

  const noRefs = refIds.length === 0
  const success = !noRefs && resolutions.some((r) => r.success)
  const failureErrors = resolutions.filter((r) => !r.success).map((r) => r.error)
  const error = noRefs
    ? `expandPreviousResult: no ref_id parsed from tool_args (${action.tool_args})`
    : failureErrors.length > 0
      ? failureErrors.join('; ')
      : undefined

  // For backward compatibility, a single-ref call returns the bare result;
  // multi-ref calls return a map keyed by ref_id (failures surface as
  // { __error: "..." }).
  const result: unknown =
    refIds.length === 1
      ? resolutions[0].result
      : resolutions.reduce<Record<string, unknown>>((acc, r) => {
          acc[r.ref_id] = r.success ? r.result : { __error: r.error }
          return acc
        }, {})

  // tool_call args mirror the input shape: scalar for one ref, list for many.
  const trackedArgs = refIds.length === 1 ? { ref_id: refIds[0] } : { ref_ids: refIds }

  // `resultOmit` applies PER RESOLUTION, keyed by each ref's ORIGIN tool
  // (projecting the ref-id-keyed combined map wholesale would use the wrong key
  // space). The tracked event stays raw.
  const project = (r: Resolution): unknown =>
    omitResultFields(r.result, r.tool ? p.resultOmit?.[r.tool] : undefined)
  const turnResult: unknown =
    refIds.length === 1
      ? resolutions[0].success
        ? project(resolutions[0])
        : resolutions[0].result
      : resolutions.reduce<Record<string, unknown>>((acc, r) => {
          acc[r.ref_id] = r.success ? project(r) : { __error: r.error }
          return acc
        }, {})
  const expansions = resolutions
    .filter((r) => r.success)
    .map((r) => {
      const projected = project(r)
      return {
        ref_id: r.ref_id,
        content: truncateTo(
          typeof projected === 'string' ? projected : JSON.stringify(projected),
          p.maxResultChars,
        ),
      }
    })
  const entry: LoopTurn = {
    n: 0,
    reasoning: action.reasoning,
    status: action.status,
    tool_call: { tool: EXPAND_TOOL_NAME, args: action.tool_args },
    tool_result: {
      tool: EXPAND_TOOL_NAME,
      result: truncateTo(JSON.stringify(turnResult), p.maxResultChars),
      success,
      error: error ?? null,
    },
    ...(expansions.length > 0 ? { expansions } : {}),
  }
  return { trackedArgs, result, success, error, entry }
}

/** A call's expansions, recomputed from the arguments it was dispatched with.
 *  A call refused at the precheck kept its raw `tool_args` string and expanded
 *  nothing. */
function expansionsOf(call: ToolCallEventData, p: Projection): ExpandedRef[] {
  const args = call.args
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return []
  return resolveRefsAndCapture(
    args as Record<string, unknown>,
    p.view,
    p.maxResultChars,
    p.excluded,
  ).expansions
}

/** A multi-call turn's outcomes, from its recorded results, in call order. */
function batchOutcomes(round: LoopRound): SubCallOutcome[] {
  return round.calls.map(({ call, result }, i) => ({
    index: i + 1,
    tool: result?.tool ?? call.tool,
    success: result?.success ?? false,
    result: result?.result ?? undefined,
    error: result?.error,
    ...(result?.skipped ? { skipped: true } : {}),
  }))
}

/** Did the round dispatch a tool (it breaks a run of unusable answers), count
 *  as an unusable answer, or neither? */
function roundEffect(round: LoopRound): 'dispatched' | 'unusable' | 'none' {
  const a = round.action
  if (!a) return 'unusable' // an unparseable answer
  if (a.additional_calls && a.additional_calls.length > 0) {
    const dispatched = round.calls.some(
      ({ call, result }) => typeof call.args === 'object' && call.args !== null && !result?.skipped,
    )
    if (dispatched) return 'dispatched'
    return batchOutcomes(round).some((o) => o.success) ? 'none' : 'unusable'
  }
  if (a.tool_name === EXPAND_TOOL_NAME) return 'none'
  return round.calls.length > 0 ? 'dispatched' : 'unusable'
}

/**
 * The turn-log entry of one consumed round, or undefined for a round that ends
 * the loop. THE one builder: every branch of the loop and the resume both call
 * it, so the next controller input of a resumed run equals that of a run that
 * never paused, given the same outcome.
 */
function projectRound(round: LoopRound, p: Projection): LoopTurn | undefined {
  const { n, action, recovery } = round
  // The model answered and its answer would not parse: the round's result is
  // the feedback, after an empty action.
  if (!action) {
    return {
      n,
      tool_result: {
        tool: '',
        result: '',
        success: false,
        error: recovery?.feedback ?? recovery?.error ?? '',
      },
    }
  }
  if (action.is_final || action.tool_name === 'Return') return undefined
  const head = {
    n,
    reasoning: action.reasoning,
    status: action.status,
    tool_call: { tool: action.tool_name, args: action.tool_args },
  }
  // Nothing ran: the refusal or the argument feedback is the round's result.
  if (round.calls.length === 0) {
    return {
      ...head,
      tool_result: {
        tool: action.tool_name,
        result: '',
        success: false,
        error: recovery?.error ?? '',
      },
    }
  }
  if (action.additional_calls && action.additional_calls.length > 0) {
    // Controller-facing combined map: per-tool resultOmit projection and
    // per-call truncation (a batch shares ONE turn's context budget — each call
    // gets an equal slice, floor 500 chars), then a whole-map truncate.
    const outcomes = batchOutcomes(round)
    const perCallCap = Math.max(500, Math.floor(p.maxResultChars / outcomes.length))
    const { combined, anySucceeded, errors } = combineOutcomes(outcomes, (o) => {
      const projected = omitResultFields(o.result, p.resultOmit?.[o.tool])
      const s = typeof projected === 'string' ? projected : JSON.stringify(projected)
      return s.length > perCallCap ? s.slice(0, perCallCap) + '…[truncated]' : s
    })
    const expansions = round.calls.flatMap(({ call }) => expansionsOf(call, p))
    return {
      ...head,
      additional_calls: action.additional_calls,
      tool_result: {
        tool: action.tool_name,
        result: truncateTo(JSON.stringify(combined), p.maxResultChars),
        success: anySucceeded,
        error: anySucceeded ? null : errors.join('; '),
      },
      ...(expansions.length > 0 ? { expansions } : {}),
    }
  }
  if (action.tool_name === EXPAND_TOOL_NAME) return { ...expandRound(action, p).entry, n }
  // `resultOmit` projects the CONTROLLER's view only: the event keeps the
  // complete result for compactExecution and the citation extractors.
  const { call, result } = round.calls[0]
  const resultStr = JSON.stringify(
    omitResultFields(result?.result, p.resultOmit?.[action.tool_name]),
  )
  const expansions = expansionsOf(call, p)
  return {
    ...head,
    tool_result: {
      tool: action.tool_name,
      result: truncateTo(resultStr, p.maxResultChars),
      success: result?.success ?? false,
      error: result?.error ?? null,
    },
    ...(expansions.length > 0 ? { expansions } : {}),
  }
}

/** The kinds of event a round records, under the loop's own id. */
const ROUND_EVENTS = new Set(['controller_action', 'tool_call', 'tool_result', 'loop_recovery'])

/** Every round the paused invocation consumed, in order, from its own events. */
function roundsOf(events: readonly ContextEvent[], patternId: string): LoopRound[] {
  type Building = {
    n: number
    action?: ControllerAction
    recovery?: LoopRecoveryEventData
    calls: { call: ToolCallEventData; result?: ToolResultEventData }[]
  }
  const rounds: Building[] = []
  for (const e of events) {
    if (e.patternId !== patternId || !ROUND_EVENTS.has(e.type)) continue
    const current = rounds[rounds.length - 1]
    if (e.type === 'controller_action') {
      const d = e.data as ControllerActionEventData
      rounds.push({ n: d.turn ?? rounds.length, action: d.action, calls: [] })
    } else if (e.type === 'loop_recovery') {
      const d = e.data as LoopRecoveryEventData
      // An unparseable answer is a round of its own: it records no action.
      if (d.failure === 'unparseable_output' || !current || current.n !== d.turn) {
        rounds.push({ n: d.turn, recovery: d, calls: [] })
      } else current.recovery = d
    } else if (e.type === 'tool_call' && current) {
      current.calls.push({ call: e.data as ToolCallEventData })
    } else if (e.type === 'tool_result' && current) {
      // The latest result of a call wins: a call a person released ran again
      // on re-entry (slice 10), under the same callId.
      const d = e.data as ToolResultEventData
      const pair = current.calls.find((c) => c.call.callId === d.callId)
      if (pair) pair.result = d
    }
  }
  return rounds
}

export interface SimpleLoopData {
  turn?: number
  intent?: string
  /** The last action the controller emitted — the terminal `Return` when the
   *  loop exited normally. Nothing in the repo READS it (the Observability
   *  drill-down reads the `controller_action` EVENT instead), and #149 weighed
   *  retiring it: kept because `actorCritic` writes the identically-shaped
   *  field and `docs/harness-patterns/frontend.md` documents both, so dropping
   *  only this one would leave the pair half-implemented for no gain. Under
   *  `returnStyle: 'summary'` what lands here is a short summary, not a full
   *  answer — do not treat it as user-facing text — except on a turn in which no
   *  tool call returned a result, where the prompt asks for the complete answer
   *  (#615; see `data.returnText`). */
  lastAction?: ControllerAction
  response?: string
  /** The terminal `Return`'s text, for `compactExecution`'s Return-only case
   *  (#610) and its every-call-failed case (#614). Written ONLY by this loop's own `Return` exit — an actorCritic
   *  `Return` is refused and never reaches it. */
  returnText?: string
}

/**
 * Create a simple loop pattern.
 *
 * Calls the BAML controller function directly, extracting params from context.
 *
 * @param controller - Controller function from an adapter factory
 *   (`createLoopControllerAdapter()`, no tool-list argument — the list rides
 *   the seam as `ControllerInput.tools`, L14). A raw bound BAML function does
 *   NOT satisfy this contract — its positional signature differs and it
 *   returns a bare ControllerAction instead of `{ action, llmCall }` (see
 *   `ControllerFn`).
 * @param tools - Allowed tool names
 * @param config - Optional configuration (schema, maxTurns, patternId, etc.)
 * @returns ConfiguredPattern ready for chain
 *
 * @example
 * const loop = simpleLoop(createLoopControllerAdapter(), tools.neo4j, {
 *   patternId: 'neo4j-query',
 *   schema,
 *   trackHistory: 'tool_result',
 *   commitStrategy: 'on-success'
 * })
 */
// ============================================================================
// PriorResult Merging — used by simpleLoop to combine `withReferences`
// attachments with the existing `priorTurnCount` mechanism, and to annotate
// each ref with the turn it was first inlined via ref:<id>.
// ============================================================================

/** Drop duplicate `ref_id` entries; first occurrence wins. */
export function dedupByRefId(refs: PriorResult[]): PriorResult[] {
  const seen = new Set<string>()
  const out: PriorResult[] = []
  for (const r of refs) {
    if (seen.has(r.ref_id)) continue
    seen.add(r.ref_id)
    out.push(r)
  }
  return out
}

/** Annotate each ref with the **first** `turn.n` whose `expansions[]` contains
 *  its `ref_id`. Refs never expanded get `expanded_in_turn: null` (explicitly,
 *  not absent) — MiniJinja distinguishes None from undefined, and `is none`
 *  in the prompt template only matches None. If we left the field absent the
 *  template's `is not none` test would incorrectly fire for unannotated refs. */
export function annotateExpansions(refs: PriorResult[], turns: LoopTurn[]): PriorResult[] {
  const firstTurn = new Map<string, number>()
  for (const t of turns) {
    for (const e of t.expansions ?? []) {
      if (!firstTurn.has(e.ref_id)) firstTurn.set(e.ref_id, t.n)
    }
  }
  return refs.map((r) => ({
    ...r,
    expanded_in_turn: firstTurn.get(r.ref_id) ?? null,
  }))
}

export function simpleLoop<T extends SimpleLoopData>(
  controller: ControllerFn,
  tools: string[],
  config?: SimpleLoopConfig,
): ConfiguredPattern<T> {
  const resolved = resolveConfig('simpleLoop', config)

  // Resumable (slice 6) only when a resume can rebuild this loop: its rounds
  // are recorded and committed under an id that is the same in the next turn's
  // composition. A loop that does not record them declares nothing, so
  // construction refuses a gated tool in it (`refuseUnresumableGates`).
  const recordsRounds =
    config?.patternId !== undefined &&
    (['controller_action', 'tool_call', 'tool_result'] as const).every((type) =>
      shouldTrack(type, resolved.trackHistory),
    ) &&
    (resolved.commitStrategy === 'always' || resolved.commitStrategy === 'on-success')
  const fingerprint = resumableFingerprint('simpleLoop', resolved.patternId, {
    tools: tools.filter((name) => !isAgentWithheldTool(name)).sort(),
  })

  const fn = (scope: PatternScope<T>, view: EventView): Promise<PatternScope<T>> => {
    if (!recordsRounds) return body(scope, view, undefined)
    // Taken BEFORE `onPath`, which clears the slot for the code below.
    const replay = takeResume(fingerprint)?.events
    return onPath({ pattern: 'simpleLoop', fingerprint }, undefined, () =>
      body(scope, view, replay),
    )
  }

  const body = async (
    scope: PatternScope<T>,
    view: EventView,
    replay: readonly ContextEvent[] | undefined,
  ): Promise<PatternScope<T>> => {
    // Nothing to decide with (#276). A loop whose tool list is empty BECAUSE
    // the gateway is unreachable used to run its full turn budget, call
    // nothing, and hand an empty execution to the synthesizer, which answered
    // as though the tools had been consulted. Say so instead, and say it before
    // spending a controller call on a question this pattern cannot act on.
    //
    // Stamped `irrecoverable` on the EVENT rather than left to the pattern
    // default (`simpleLoop: 'recoverable'`, which is right for every other
    // failure this loop has): no further iteration can put the tools back, so
    // `runChain` stops the chain here and this error is what reaches the user.
    // A run-scoped transport is the exception — its tools never came from the
    // gateway (today: a sandbox's, over `docker exec`), so a loop inside one is
    // not tool-less and the allowlist check further down already knows it.
    const outage = activeTransports().length > 0 ? null : toolSurfaceOutage(tools)
    if (outage) {
      trackEvent(
        scope,
        'error',
        { ...outage, severity: 'irrecoverable', kind: 'gateway_unavailable' } as ErrorEventData,
        true,
      )
      return scope
    }

    const settings = runtimeConfig()
    // One resolution rule for the body, `estimateTurns` below and the
    // exhaustion event: the pattern's declaration wins over the request's
    // setting, clamped to the bound the host's stuck-run reaper derives its
    // threshold from (`runtime-config.ts`, `resolveTurnBudget`).
    const maxTurns = resolveTurnBudget('maxToolTurns', config?.maxTurns, settings.maxToolTurns)
    // The consecutive-recovery cap (#450 review §3): a run of answers this loop
    // cannot use is fed back at most `maxConsecutiveRecoveries` times in a row; the next one takes the
    // pre-#437 fatal path below with `recoveryCapHit` set. See `recoveryStreak`.
    const maxConsecutiveRecoveries = resolveMaxConsecutiveRecoveries(
      config?.maxConsecutiveRecoveries,
    )
    const streak = recoveryStreak(maxConsecutiveRecoveries)
    // A resumed invocation's own events reach it as the replay, never through
    // its view: live, a loop never saw its own events there (slice 6).
    const excluded: ReadonlySet<string> = new Set(
      (replay ?? []).flatMap((e) => (e.id ? [e.id] : [])),
    )
    const projection: Projection = {
      view,
      excluded,
      maxResultChars: settings.maxResultChars,
      resultOmit: config?.resultOmit,
    }
    // Each call's LOGICAL identity (slice 8): the run, the resumable path to
    // this loop, the turn and the call's position in its action. Every input
    // is durable state of the run, so a retry of the call recomputes it in any
    // process, and a deliberate repeat is at another turn or position. Not
    // `currentToolCallId()`: a process-local counter a restart reissues.
    const runId = currentRunId()
    const callKeyOf = (turn: number, position: number): string | undefined =>
      runId === undefined
        ? undefined
        : createHash('sha256')
            .update(JSON.stringify([runId, currentRunFrame()?.continuation ?? [], turn, position]))
            .digest('hex')
    const batchKeyOf = (turn: number): string | undefined =>
      runId === undefined
        ? undefined
        : createHash('sha256')
            .update(
              JSON.stringify([runId, currentRunFrame()?.continuation ?? [], turn, 'egress-batch']),
            )
            .digest('hex')
    /** Dispatch under the call's key so a single held request binds to that
     * call. Batch calls use preflight and one batch key for their checklist. */
    const dispatch = (
      name: string,
      args: Record<string, unknown>,
      callKey: string | undefined,
      batch = false,
    ) =>
      callKey !== undefined
        ? amendRunFrame({ callKey, batch }, () => callTool(name, args))
        : callTool(name, args)
    /**
     * The `onToolResult` hook, on a result before its event is committed.
     * Failures are non-fatal: an error event, and the original result kept. A
     * held placeholder is never handed to it: a hook that rewrote one would
     * hide it from the resume, and the call a person releases gets the hook
     * when it runs on re-entry (#804 review N1).
     */
    const hookResult = async (
      tool: string,
      result: ToolCallResult,
      callId: string | undefined,
      args: Record<string, unknown>,
      turn: number,
      batchEventSafe = false,
    ): Promise<void> => {
      if (!config?.onToolResult || isHeldResult(result.data)) return
      try {
        const hooked = await config.onToolResult(tool, result, { callId, args })
        if (hooked && 'data' in hooked && hooked.data !== undefined) result.data = hooked.data
      } catch (hookErr) {
        const message = hookErr instanceof Error ? hookErr.message : String(hookErr)
        trackEvent(
          scope,
          'error',
          {
            error: batchEventSafe
              ? `onToolResult hook failed for batch call; see encrypted plan.`
              : `onToolResult hook failed for ${tool}: ${message}`,
            severity: 'recoverable',
            turn,
          } as ErrorEventData,
          true,
        )
      }
    }
    // Multi-call turns (ControllerAction.additional_calls). 'off' still
    // EXECUTES an un-advertised batch (serially) — it only stops the prompt
    // from inviting one, because the shared output schema means any agent's
    // model can emit the field.
    const multiMode: MultiCallMode = config?.multiToolCalls ?? 'parallel'
    // What the terminal `Return` action should carry (#149). 'summary' by
    // default: the loop's prose reaches no user — `Synthesize` renders
    // `tool_result.tool` / `.result` only, never the `tool_call.args` the prose
    // lands in — so a downstream `compactExecution` composes the answer from
    // the FULL results (see LoopReturnStyle in simpleLoop.baml). Passed on
    // every controller call because it renders in the STATIC prompt head
    // (system block + tier 1), which must be byte-identical turn over turn.
    const returnStyle: ReturnStyle = config?.returnStyle ?? 'summary'
    const data = scope.data
    const turns: LoopTurn[] = []
    let hasError = false
    let errorMessage: string | undefined
    let errorTurn: number | undefined
    let errorLlmCall: LLMCallRecord | undefined
    let recoveryCapHit = false
    let exitedViaReturn = false
    // This loop owns the key for its own run: an earlier loop's text (same
    // turn) must not answer for one that ended without a `Return` (#610).
    if (scope.data.returnText !== undefined) scope.data = { ...scope.data, returnText: undefined }

    // Build structured references to tool results from previous tasks.
    // These are passed as turns_previous_runs (separate from the current task's turns)
    // so the LLM can clearly distinguish prior context from current work.
    // Summaries (populated async after prior responses) are used when available.
    let turnWindowRefs: PriorResult[] = []
    if (config?.rememberPriorTurns !== false) {
      const turnCount = config?.priorTurnCount ?? settings.priorTurnCount
      const priorEvents = visible(
        view.fromLastNTurns(turnCount).ofType('tool_result').get(),
        excluded,
      ).filter((e) => {
        const d = e.data as ToolResultEventData
        return !!e.id && !d.hidden && !d.archived && (d.success || config?.includeFailedResults)
      })
      turnWindowRefs = priorEvents.map((e) => {
        const d = e.data as ToolResultEventData
        const rawResult = typeof d.result === 'string' ? d.result : JSON.stringify(d.result)
        const preview = d.summary ?? rawResult.slice(0, 200).replace(/\n/g, ' ')
        return {
          ref_id: e.id!,
          tool: d.tool,
          summary: preview + (!d.summary && rawResult.length > 200 ? '...' : ''),
        }
      })
    }

    // Merge `withReferences` attachments (LLM-selected, scope-filtered) with the
    // turn-window refs. Attached takes precedence on dedup so the selector's
    // explicit choice wins over the implicit window.
    const attachedRefs = (scope.data as { attachedRefs?: PriorResult[] }).attachedRefs ?? []
    const mergedRefs = dedupByRefId([...attachedRefs, ...turnWindowRefs])
    const basePriorResults: PriorResult[] | undefined =
      mergedRefs.length > 0 ? mergedRefs : undefined

    // Plan from an upstream `planner` pattern (#27), forwarded by the chain as
    // this pattern's `currentData`. Formatted ONCE per run (it cannot change
    // mid-loop) and passed to the controller as its trailing `planContext`
    // argument; the adapter forwards it as `LoopController`'s own
    // `plan_context` parameter, NOT merged into `context` — `context` is the
    // agent-static tier-1 prefix, and a per-question plan there would turn
    // every tool-catalog cache read into a write (#122). Absent when no
    // planner ran — the loop then behaves exactly as it did before.
    // #507: an orchestrating pattern's earlier-step results ride the SAME string,
    // under a separate data heading — never inside the PLAN section; so does the
    // conversation before the latest message, under a third.
    const planContext = formatPlanContext(
      (scope.data as PlannerData).plan,
      (scope.data as PlannerData).handoff,
      (scope.data as PlannerData).conversation,
    )

    // THE ALLOWLIST, as one predicate. A tool withheld from agents
    // (`isAgentWithheldTool`, #403) is refused even when `tools` names it — the
    // catalog never lists one, but a hand-written allowlist can — and so is
    // never advertised on the seam either. The rest of the static list is
    // augmented by the tool surface of every transport scoped to this run —
    // `sandbox_*` names pass without being listed in `tools` (see
    // docs/plan/sandbox.md → "How tools reach the controller"); outside any
    // scope `activeTransports()` is empty and this is the list alone. The
    // singular check, the batch precheck and the few-shot filter below all ask
    // THIS, so what the loop demonstrates cannot drift from what it accepts.
    // (`tools` itself stays the outage guard's input above: that check keys on
    // the array's identity.)
    const allowlist = tools.filter((name) => !isAgentWithheldTool(name))
    const isAllowedTool = (name: string): boolean =>
      !isAgentWithheldTool(name) &&
      (allowlist.includes(name) || activeTransports().some((t) => t.ownsTool(name)))
    const refusal = (name: string): string =>
      `Tool not allowed: ${name}` +
      (isAgentWithheldTool(name) ? ' (withheld from every agent)' : '') +
      `. Allowed: ${allowlist.join(', ')}`

    // Few-shots are filtered by that same allowlist, once per run (#401). An
    // example of a tool the loop will refuse is worse than no example: a model
    // that copies it names a tool outside the allowlist, and the singular
    // branch below spends a round on "Tool not allowed" (it ended the loop
    // there before #437) instead of answering.
    // The case that made this concrete is a read-only Neo4j (#403): the shipped
    // Neo4j few-shots include a `write_neo4j_cypher` example, and with the
    // write tool off the allowlist, copying it turned a write-shaped question
    // into an error turn. `Return` and `expandPreviousResult` are loop-control
    // actions this pattern always handles, so examples of them always stay.
    // Same contract as `tools` on the seam (L14): the controller is shown only
    // what this loop will run.
    const fewShots = config?.fewShots?.filter(
      (shot) =>
        shot.tool === 'Return' || shot.tool === EXPAND_TOOL_NAME || isAllowedTool(shot.tool),
    )

    // Slice 6: re-entering a pause, the rounds this invocation already consumed
    // are rebuilt from its own events through the ONE projection the live
    // rounds use, with the held call's outcome in place. No model is called for
    // them, no tool is dispatched again, and the turn count and the recovery
    // streak continue across the pause against `maxTurns`.
    let firstTurn = 0
    const rounds = roundsOf(replay ?? [], resolved.patternId)
    // Slice 10: a held call whose request asked for it (an outgoing request a
    // person decided) runs AGAIN on re-entry, under its own callId and callKey,
    // and its result is the round's. A held batch is handled by againBatch
    // below; non-pausable and unattended batches still follow O16.
    const last = rounds[rounds.length - 1]
    const again =
      last?.action && !last.action.additional_calls?.length && last.calls.length === 1
        ? last.calls[0].result?.redispatch === true
          ? last
          : undefined
        : undefined
    const againBatch =
      last?.action?.additional_calls?.length && last.calls.some((c) => c.result?.redispatch)
        ? last
        : undefined
    for (const round of rounds) {
      const entry = projectRound(round, projection)
      if (entry && round !== again && round !== againBatch) turns.push(entry)
      const effect = roundEffect(round)
      if (effect === 'dispatched') streak.dispatched()
      else if (effect === 'unusable') streak.unusableAnswer()
      if (
        round !== again &&
        round !== againBatch &&
        round.action &&
        entry &&
        (round.action.tool_name === EXPAND_TOOL_NAME || entry.tool_result?.success)
      ) {
        scope.data = { ...scope.data, turn: round.n, lastAction: round.action }
      }
      firstTurn = round.n + 1
    }

    try {
      if (again?.action) {
        const { call } = again.calls[0]
        const args = (call.args ?? {}) as Record<string, unknown>
        const { resolved: resolvedArgs } = resolveRefsAndCapture(
          args,
          view,
          settings.maxResultChars,
          excluded,
        )
        // The gate that held it answers from the recorded decision on the way.
        const heldBy = again.calls[0].result?.heldBy
        const request = heldBy ? holdingRequestInRun(heldBy) : undefined
        const answer = heldBy ? holdingAnswerInRun(heldBy) : undefined
        const approvedByOwner =
          request?.kind === EGRESS_RELEASE_KIND &&
          answer?.requestId === heldBy &&
          answer?.by === 'person' &&
          answer.choice === 'accept'
        const result = approvedByOwner
          ? await amendRunFrame({ callKey: call.callKey, batch: false, approvedByOwner }, () =>
              callTool(call.tool, resolvedArgs),
            )
          : await dispatch(call.tool, resolvedArgs, call.callKey)
        await hookResult(call.tool, result, call.callId, resolvedArgs, again.n)
        const resultData: ToolResultEventData = {
          callId: call.callId,
          tool: call.tool,
          result: result.data,
          success: result.success,
          error: result.error,
          ...(result.sanitized ? { sanitized: result.sanitized } : {}),
        }
        trackEvent(scope, 'tool_result', resultData, resolved.trackHistory)
        if (hitlPending()) return scope
        turns.push(
          projectRound(
            { n: again.n, action: again.action, calls: [{ call, result: resultData }] },
            projection,
          )!,
        )
        if (!result.success) {
          trackLoopRecovery(scope, {
            failure: 'tool_error',
            error: result.error ?? 'Tool call failed',
            tool: call.tool,
            turn: again.n,
            maxTurns,
          })
        } else {
          scope.data = { ...scope.data, turn: again.n, lastAction: again.action }
        }
      }

      if (againBatch?.action) {
        const heldBy = againBatch.calls.find((c) => c.result?.redispatch)?.result?.heldBy
        const request = heldBy ? holdingRequestInRun(heldBy) : undefined
        const payload =
          request?.payloadRef && currentRunFrame()?.hitlPayloads?.load
            ? await currentRunFrame()!.hitlPayloads!.load!(request.payloadRef)
            : null
        const plan =
          payload?.kind === EGRESS_BATCH_RELEASE_KIND
            ? (payload.payload as EgressBatchPlan)
            : undefined
        let valid = !!(
          request &&
          plan &&
          plan.v === 1 &&
          (plan.mode === 'parallel' || plan.mode === 'sequential' || plan.mode === 'off') &&
          plan.mode === multiMode &&
          plan.batchKey === batchKeyOf(againBatch.n) &&
          Array.isArray(plan.members) &&
          Array.isArray(plan.rows) &&
          Array.isArray(plan.callIds) &&
          Array.isArray(plan.errors) &&
          plan.callIds.length === againBatch.calls.length &&
          plan.errors.length === againBatch.calls.length &&
          plan.callIds.every((id, i) => id === againBatch.calls[i].call.callId) &&
          request.defaultOption === 'continue' &&
          canonicalJson(request.options) === canonicalJson(batchOptions(plan.rows)) &&
          plan.action?.additional_calls?.length === againBatch.calls.length - 1
        )
        if (valid && plan) {
          const names = [
            plan.action.tool_name,
            ...(plan.action.additional_calls ?? []).map((c) => c.tool_name),
          ]
          valid = names.every((name, i) => name === againBatch.calls[i].call.tool)
          const seen = new Set<number>()
          for (const member of plan.members) {
            if (
              !Number.isInteger(member.index) ||
              member.index < 0 ||
              member.index >= names.length ||
              seen.has(member.index) ||
              member.tool !== names[member.index] ||
              member.callKey !== callKeyOf(againBatch.n, member.index) ||
              !member.args ||
              typeof member.args !== 'object' ||
              Array.isArray(member.args) ||
              member.digest !== batchDigest(member.tool, member.args)
            )
              valid = false
            seen.add(member.index)
          }
          const held = plan.members.filter((m) => m.verdict === 'held')
          if (
            held.length !== plan.rows.length ||
            plan.rows.some((row) => {
              const member = held.find((m) => m.index === row.index)
              return (
                !member ||
                row.callKey !== member.callKey ||
                row.digest !== member.digest ||
                row.tool !== member.tool ||
                canonicalJson(row.args) !== canonicalJson(member.args)
              )
            })
          )
            valid = false
        }
        const answer =
          valid && plan
            ? await amendRunFrame({ callKey: plan.batchKey, batch: true }, async () =>
                recordedHolding(
                  EGRESS_BATCH_RELEASE_KIND,
                  batchOptions(plan.rows),
                  batchAuthorization(plan),
                ),
              )
            : undefined
        if (!answer || answer.requestId !== request?.requestId || !plan) {
          trackEvent(
            scope,
            'error',
            {
              error: EGRESS_BATCH_MISMATCH,
              severity: 'recoverable',
              turn: againBatch.n,
            } satisfies ErrorEventData,
            true,
          )
          return scope
        }
        if (answer.choice === 'interrupt') return scope
        const members = new Map(plan.members.map((m) => [m.index, m]))
        const allCalls: SubCall[] = againBatch.calls.map(({ call }, index) => {
          const member = members.get(index)
          if (answer.choice === 'refuse-all')
            return { tool: call.tool, precheckError: EGRESS_BATCH_MISMATCH }
          if (!member || member.verdict === 'skipped')
            return {
              tool: call.tool,
              precheckError:
                plan.errors[index] ?? 'skipped: an earlier call in this batch did not run',
            }
          if (member.verdict === 'veto')
            return { tool: call.tool, precheckError: member.denial ?? EGRESS_BATCH_MISMATCH }
          const accepted =
            member.verdict === 'held' && answer.flags[`accept:${member.callKey}`] === true
          const prepared = {
            callKey: member.callKey,
            digest: member.digest,
            route: member.route,
            batchPlanKey: plan.batchKey,
            ...(member.verdict === 'held' ? { requestId: answer.requestId } : {}),
            decision:
              member.verdict === 'pass'
                ? ('pass' as const)
                : accepted
                  ? ('accept' as const)
                  : ('refuse' as const),
            ...(member.cause && { cause: member.cause }),
            ...(member.category && { category: member.category }),
            ...(member.auditByDecide && { auditByDecide: true }),
            ...(answer.by === 'person' && member.verdict === 'held' && !accepted
              ? { byOwner: true }
              : {}),
          }
          return {
            tool: member.tool,
            run: async () => {
              const result = await amendRunFrame(
                {
                  callKey: member.callKey,
                  batch: true,
                  batchPhase: 'execute',
                  batchPlanKey: plan.batchKey,
                  batchPrepared: prepared,
                },
                () => callTool(member.tool, member.args),
              )
              await hookResult(member.tool, result, call.callId, member.args, againBatch.n, true)
              return {
                success: result.success,
                result: result.data,
                error: result.error,
                ...(result.sanitized ? { sanitized: result.sanitized } : {}),
              }
            },
          }
        })
        if (answer.choice === 'refuse-all') currentRunFrame()?.batchRefuseAll?.()
        const outcomes =
          answer.choice === 'refuse-all'
            ? allCalls.map((c, i): SubCallOutcome => ({
                index: i + 1,
                tool: c.tool,
                success: false,
                error:
                  (answer.by === 'person' ? EGRESS_OWNER_REFUSED_ALL : '') +
                  EGRESS_TEXTS.turnClosed,
              }))
            : await runBatch(allCalls, plan.mode)
        const resultData = outcomes.map((raw, i): ToolResultEventData => {
          const o = batchEventOutcome(raw, refusal)
          return {
            callId: plan.callIds[i],
            batchId: againBatch.calls[i].call.batchId,
            tool: o.tool,
            result: o.result ?? null,
            success: o.success,
            error: o.error,
            ...(o.sanitized ? { sanitized: o.sanitized } : {}),
            ...(o.skipped ? { skipped: true } : {}),
          }
        })
        for (const data of resultData) trackEvent(scope, 'tool_result', data, resolved.trackHistory)
        turns.push(
          projectRound(
            {
              n: againBatch.n,
              action: plan.action,
              calls: againBatch.calls.map(({ call }, i) => ({ call, result: resultData[i] })),
            },
            projection,
          )!,
        )
        if (outcomes.some((o) => o.success))
          scope.data = {
            ...scope.data,
            turn: againBatch.n,
            lastAction: batchEventAction(plan.action),
          }
      }

      for (let turn = firstTurn; turn < maxTurns; turn++) {
        // Trim oldest turns if they would overflow the controller's context window
        // (the client this call will actually use, not a hardcoded chain name).
        // Per-call limits (Lane A5): the seam answers for the model THIS call
        // takes — a tier decision is an ALS scope, not a construction-time fact.
        // A seam without limits (custom fn, test mock) falls back to the same
        // conservative 16K default getContextWindow carried.
        const contextWindow = controller.limits?.().contextWindow ?? 16_384
        // ~500 chars base prompt overhead (template, schema, intent, etc.)
        // trimToFit keeps the string serializer for SIZE accounting only — the
        // turns themselves are handed to the controller TYPED (Lane A4); no
        // JSON.stringify round-trip, and nothing re-parses them.
        const trimmedTurns = trimToFit(turns, (t) => JSON.stringify(t), 500, contextWindow)

        // Extract intent from data or use input from view
        // Use ofType('user_message') to get the actual user query, not the router's assistant_message
        const userMessage = view.ofType('user_message').last(1).get()[0]
        const userContent = userMessage ? (userMessage.data as { content: string }).content : ''
        const intent = data.intent ?? userContent

        // Annotate refs with `expanded_in_turn` from accumulated turns so the
        // controller can see which prior data has already been inlined.
        const priorResults = basePriorResults
          ? annotateExpansions(basePriorResults, turns)
          : undefined

        // Call BAML controller — catch validation errors gracefully
        // so partial results from earlier turns are preserved
        let action: ControllerAction
        // Hoisted so the tool_args-parse branch below can check for output-cap
        // truncation on the call that produced this turn's action. The record
        // comes back on the result (Lane A3) — the implementation owns the
        // collector, core no longer creates or hands one down.
        let controllerLlmCall: LLMCallRecord | undefined
        try {
          const controllerResult = await controller({
            userMessage: userContent,
            intent,
            // L14 (#225 Lane B3): the loop's allowlist IS the controller's
            // advertised list — one declaration, on the seam.
            tools: allowlist,
            turns: trimmedTurns,
            turn,
            context: config?.schema,
            priorResults,
            fewShots,
            multiCallMode: multiMode === 'off' ? undefined : multiMode,
            planContext,
            returnStyle,
          })
          // Apply the contract's documented defaults ONCE, here, before the
          // action is recorded or read: `is_final` is optional (#159) and
          // absent means false. Every controller funnels through this point —
          // adapter factories and custom ones; a raw BAML function does not
          // satisfy the contract — so nothing downstream has to re-handle an
          // absent value.
          action = normalizeControllerAction(controllerResult.action)
          controllerLlmCall = controllerResult.llmCall

          // Track controller action event with LLM call data.
          // `turn` and `maxTurns` are surfaced so live consumers can size
          // their progress indicators without reading the pattern config
          // (which doesn't capture settings.maxToolTurns).
          // A held N8 batch is recorded only after its encrypted plan exists:
          // the action and LLM output can contain the exact outgoing arguments.
        } catch (controllerError) {
          // The model answered and its answer would not parse (#437 slice 1):
          // tell it so as this round's result and spend the next round on a
          // fresh answer. The round is consumed — the adapter has already
          // made its one corrective retry inside it. The turn has no tool
          // call, so the log replays an empty action followed by the ERROR,
          // the shape `controller-history-format.test.ts` pins as parseable.
          if (isRecoverableLLMFailure(controllerError)) {
            if (!streak.unusableAnswer()) {
              const recovery: LoopRecoveryEventData = {
                failure: 'unparseable_output',
                error: controllerError.message,
                turn,
                maxTurns,
                feedback: unparseableOutputFeedback(controllerError),
              }
              trackLoopRecovery(scope, recovery, controllerError.llmCall)
              turns.push(projectRound({ n: turn, recovery, calls: [] }, projection)!)
              continue
            }
            // One unusable answer past the cap: fatal, by the path below.
            recoveryCapHit = true
          }
          const msg =
            controllerError instanceof Error ? controllerError.message : String(controllerError)
          // Anything else is fatal, as it always was: the model never answered
          // (transport, timeout, abort) or the failure is unclassified — and so
          // is an unparseable answer that reached the consecutive-recovery cap.
          // Exit gracefully with partial results instead of losing everything.
          hasError = true
          errorMessage = msg
          errorTurn = turn
          // Carry LLM call data from the failed BAML call through to the
          // error event so the panel can render the same Prompt/Output
          // drill-down as a successful call. Adapters wrap final propagating
          // failures in LLMCallError specifically for this purpose.
          if (controllerError instanceof LLMCallError) {
            errorLlmCall = controllerError.llmCall
          }
          break
        }

        const trackAction = (stored: ControllerAction = action, includeCall = true) =>
          trackEvent(
            scope,
            'controller_action',
            { action: stored, turn, maxTurns } as ControllerActionEventData,
            resolved.trackHistory,
            includeCall ? controllerLlmCall : undefined,
          )

        // Check if done (is_final flag OR tool_name === 'Return')
        if (action.is_final || action.tool_name === 'Return') {
          trackAction()
          scope.data = {
            ...scope.data,
            lastAction: action,
            turn,
            ...(action.tool_name === 'Return' && typeof action.tool_args === 'string'
              ? { returnText: action.tool_args }
              : {}),
          }
          exitedViaReturn = true
          break
        }

        // Synthetic tool: `expandPreviousResult` — resolves one or more
        // ref_ids to their prior tool_results and records them as a single
        // turn. Intercepted here (before tools.includes guard) so the LLM
        // has an explicit affordance for "I want to reuse this prior data"
        // without needing a real tool. Supports four arg shapes:
        //   "ref:<id>"                   — single (canonical)
        //   "ref:<id_1>,<id_2>,..."      — comma-separated batch
        //   {"ref_id": "<id>"}           — JSON, single (resilience)
        //   {"ref_ids": ["<id>", ...]}   — JSON, batch
        // Only fires SINGULAR: an expand bundled into a multi-call turn falls
        // through to the batch path below, where it gets a per-call error
        // (control-flow tools cannot be batched).
        if (action.tool_name === EXPAND_TOOL_NAME && !action.additional_calls?.length) {
          trackAction()
          const callId = generateId('tc')
          const expanded = expandRound(action, projection)
          const call: ToolCallEventData = {
            callId,
            tool: EXPAND_TOOL_NAME,
            args: expanded.trackedArgs,
          }
          const result: ToolResultEventData = {
            callId,
            tool: EXPAND_TOOL_NAME,
            result: expanded.result,
            success: expanded.success,
            error: expanded.error,
          }
          trackEvent(scope, 'tool_call', call, resolved.trackHistory)
          trackEvent(scope, 'tool_result', result, resolved.trackHistory)

          // Record as a turn — same shape as a real tool, plus expansions[]
          // (one entry per *successfully* resolved ref) so the per-turn
          // rendering and `expanded_in_turn` annotation work.
          turns.push(projectRound({ n: turn, action, calls: [{ call, result }] }, projection)!)

          scope.data = { ...scope.data, turn, lastAction: action }
          // Continue to next turn — let the controller use the resolved data.
          continue
        }

        // Multi-call turn: tool_name/tool_args is call 1, additional_calls are
        // calls 2..N. Validation happens here per sub-call; HOW they run
        // (concurrent / in-order / stop-on-failure) is the shared executor's
        // job (parallel-tools.server.ts). One LoopTurn records the whole batch
        // with an index-keyed combined result (expandPreviousResult's
        // multi-ref precedent); per-sub-call tool_call/tool_result events keep
        // observability and the compactExecution at full fidelity.
        if (action.additional_calls && action.additional_calls.length > 0) {
          const batchId = generateId('batch')
          const allCalls = [
            { tool_name: action.tool_name, tool_args: action.tool_args },
            ...action.additional_calls,
          ]
          const MAX_RESULT_CHARS = settings.maxResultChars
          const callIds: string[] = []
          const trackedArgs: unknown[] = []
          // The repair note for the sub-call at the same index, so a
          // reconstructed batch member is as visible as a reconstructed
          // singular one (#217b).
          const trackedRepairs: (JsonRepairNote | undefined)[] = []
          const resolvedArgsByPosition: (Record<string, unknown> | undefined)[] = []
          // Two arrays read POSITIONALLY at the tool_call emit below, so they
          // must grow together. Review F1: three of the five branches that
          // recorded args forgot the note, and a precheck-declined sub-call
          // ahead of a repaired one shifted every later index by one — the
          // marker landed on a call that never ran and the reconstructed call
          // was recorded as clean, which is worse than no marker at all. One
          // writer instead of five, so a new branch cannot reintroduce it.
          const track = (args: unknown, repair?: JsonRepairNote) => {
            trackedArgs.push(args)
            trackedRepairs.push(repair)
          }
          const subCalls: SubCall[] = []
          // A separately gated write name cannot share a batch with another
          // call. Refuse it before any dispatch in every mode; N8 does not
          // change the write-name precheck.
          const gated = new Set(currentRunFrame()?.gatedTools ?? [])
          const gatedCall = allCalls.find((c) => gated.has(c.tool_name))?.tool_name

          const callKeys = allCalls.map((_, position) => callKeyOf(turn, position))
          for (const [position, c] of allCalls.entries()) {
            resolvedArgsByPosition.push(undefined)
            const callId = generateId('tc')
            callIds.push(callId)
            if (gatedCall !== undefined) {
              track(c.tool_args)
              subCalls.push({
                tool: c.tool_name,
                precheckError:
                  c.tool_name === gatedCall
                    ? `${gatedCall} waits for the person's decision, so it must be the only call of its turn — issue it alone`
                    : `not run: this turn also called ${gatedCall}, which must be the only call of its turn`,
              })
              continue
            }
            // Control-flow tools are singular-only by design: Return ends the
            // loop before any tool runs, expand resolves synchronously against
            // the event store — neither composes with a batch.
            if (c.tool_name === 'Return' || c.tool_name === EXPAND_TOOL_NAME) {
              track(c.tool_args)
              subCalls.push({
                tool: c.tool_name,
                precheckError: `${c.tool_name} cannot be part of a multi-call turn — issue it as the only call of its own turn`,
              })
              continue
            }
            if (!isAllowedTool(c.tool_name)) {
              track(c.tool_args)
              subCalls.push({
                tool: c.tool_name,
                precheckError: refusal(c.tool_name),
              })
              continue
            }
            let callArgs: Record<string, unknown>
            let callRepair: JsonRepairNote | undefined
            try {
              const parsed = repairJsonTracked(c.tool_args)
              callArgs = parsed.args
              callRepair = parsed.repair
            } catch (err) {
              track(c.tool_args)
              subCalls.push({
                tool: c.tool_name,
                precheckError: controllerLlmCall?.hitOutputCap
                  ? `tool_args for ${c.tool_name} were CUT OFF at the output-token limit — the batch was too large; use fewer calls per turn`
                  : err instanceof TooLongToRepairError
                    ? `Invalid tool_args JSON for ${c.tool_name}: ${err.message}`
                    : `Invalid tool_args JSON: ${c.tool_args}`,
              })
              continue
            }
            const { resolved: resolvedArgs } = resolveRefsAndCapture(
              callArgs,
              view,
              MAX_RESULT_CHARS,
              excluded,
            )
            resolvedArgsByPosition[position] = resolvedArgs
            track(callArgs, callRepair)
            subCalls.push({
              tool: c.tool_name,
              run: async () => {
                const result = await dispatch(c.tool_name, resolvedArgs, callKeys[position], true)
                // onToolResult hook per sub-call — same contract as the singular path.
                await hookResult(c.tool_name, result, callId, resolvedArgs, turn, !!plan)
                return {
                  success: result.success,
                  result: result.data,
                  error: result.error,
                  ...(result.sanitized ? { sanitized: result.sanitized } : {}),
                }
              },
            })
          }

          const batchKey = batchKeyOf(turn)
          const useChecklist =
            currentRunFrame()?.egressBatchEnabled === true &&
            batchKey !== undefined &&
            callKeys.every((key) => key !== undefined) &&
            (await amendRunFrame({ callKey: batchKey, batch: true }, async () => canPauseHere()))
          let plan: EgressBatchPlan | undefined
          if (useChecklist && batchKey) {
            const members: BatchMember[] = []
            const rows: BatchRow[] = []
            const errors = subCalls.map((sc) => sc.precheckError ?? null)
            let stopped = false
            for (const [index, sc] of subCalls.entries()) {
              const args = resolvedArgsByPosition[index]
              if (multiMode !== 'parallel' && (stopped || errors[index])) {
                stopped = true
                continue
              }
              if (!args || !sc.run) continue
              const callKey = callKeys[index]!
              const digest = batchDigest(sc.tool, args)
              const checked = await amendRunFrame(
                { callKey, batch: true, batchPhase: 'preflight' },
                () => preflightTool(sc.tool, args),
              )
              const base = {
                index,
                callKey,
                digest,
                tool: sc.tool,
                args,
                route: checked.held?.route ?? currentRunFrame()?.route ?? null,
              }
              if (checked.denial) {
                members.push({ ...base, verdict: 'veto', denial: checked.denial })
                if (multiMode !== 'parallel') stopped = true
              } else if (checked.held) {
                const member: BatchMember = {
                  ...base,
                  verdict: 'held',
                  cause: checked.held.cause,
                  ...(checked.held.category && { category: checked.held.category }),
                }
                members.push(member)
                rows.push({ ...member, ...checked.held.payload })
              } else {
                members.push({
                  ...base,
                  verdict: 'pass',
                  ...(checked.auditByDecide && { auditByDecide: true }),
                })
              }
            }
            const preparedPlan: EgressBatchPlan = {
              v: 1,
              mode: multiMode,
              batchKey,
              action,
              callIds,
              errors,
              members,
              rows,
            }
            plan = preparedPlan
            if (rows.length > 0) {
              const request = await amendRunFrame({ callKey: batchKey, batch: true }, () =>
                askHumanHolding(
                  {
                    kind: EGRESS_BATCH_RELEASE_KIND,
                    question: 'Review requests to outside services',
                    options: batchOptions(rows),
                    defaultOption: 'continue',
                    summary: { count: rows.length },
                  },
                  preparedPlan,
                  batchAuthorization(preparedPlan),
                ),
              )
              trackAction(batchEventAction(action), false)
              const safeCalls = subCalls.map((sc, i): ToolCallEventData => ({
                callId: callIds[i],
                batchId,
                tool: sc.tool,
                args: null,
                ...(callKeys[i] ? { callKey: callKeys[i] } : {}),
              }))
              for (const data of safeCalls)
                trackEvent(scope, 'tool_call', data, resolved.trackHistory)
              const pending = request.status === 'pending'
              for (const [i, sc] of subCalls.entries()) {
                const data: ToolResultEventData = {
                  callId: callIds[i],
                  batchId,
                  tool: sc.tool,
                  result: pending
                    ? {
                        held: true,
                        requestId: request.requestId,
                        note: 'Batch review is pending.',
                        redispatch: true,
                      }
                    : null,
                  success: pending,
                  ...(!pending ? { error: EGRESS_BATCH_MISMATCH } : {}),
                }
                trackEvent(scope, 'tool_result', data, resolved.trackHistory)
              }
              return scope
            }
          }

          trackAction(plan ? batchEventAction(action) : action, !plan)

          if (plan) {
            for (const member of plan.members) {
              const sc = subCalls[member.index]
              if (member.verdict === 'veto') {
                sc.precheckError = member.denial ?? EGRESS_BATCH_MISMATCH
                sc.run = undefined
              } else if (sc.run) {
                const run = sc.run
                sc.run = () =>
                  amendRunFrame(
                    {
                      batchPhase: 'execute',
                      batchPlanKey: plan.batchKey,
                      batchPrepared: {
                        callKey: member.callKey,
                        digest: member.digest,
                        route: member.route,
                        batchPlanKey: plan.batchKey,
                        decision: 'pass',
                        ...(member.auditByDecide && { auditByDecide: true }),
                      },
                    },
                    run,
                  )
              }
            }
          }

          // All tool_call events land before dispatch — the panel pairs
          // call/result by callId, so completion order doesn't matter.
          const callData = subCalls.map((sc, i): ToolCallEventData => ({
            callId: callIds[i],
            batchId,
            tool: sc.tool,
            args: plan ? null : trackedArgs[i],
            ...(!plan && trackedRepairs[i] ? { repaired: trackedRepairs[i] } : {}),
            ...(sc.run && callKeys[i] !== undefined ? { callKey: callKeys[i] } : {}),
          }))
          for (const data of callData) trackEvent(scope, 'tool_call', data, resolved.trackHistory)

          const outcomes = await runBatch(subCalls, multiMode)
          // A batch breaks a run of unusable answers only if something in it was
          // DISPATCHED — not one refused or unparseable at the precheck, and not
          // one a serial batch skipped after an earlier failure. A batch of which
          // nothing was dispatched holds only unusable answers, so it COUNTS
          // (below) rather than slipping past the cap as a `batch_failed`.
          const dispatched = subCalls.some((sc, i) => sc.run && !outcomes[i].skipped)
          if (dispatched) streak.dispatched()

          const eventOutcomes = plan ? outcomes.map((o) => batchEventOutcome(o, refusal)) : outcomes
          const resultData = eventOutcomes.map((o, i): ToolResultEventData => ({
            callId: callIds[i],
            batchId,
            tool: o.tool,
            result: o.result ?? null,
            success: o.success,
            error: o.error,
            ...(o.sanitized ? { sanitized: o.sanitized } : {}),
            ...(o.skipped ? { skipped: true } : {}),
          }))
          for (const data of resultData)
            trackEvent(scope, 'tool_result', data, resolved.trackHistory)

          // The stop check after a batch (#433): a call in it is waiting for a
          // person. The held placeholders are tracked above, so a resume can
          // substitute them; no error is recorded, because nothing failed.
          if (hitlPending()) return scope

          // The turn's entry, by the one projection a resume uses as well.
          const entry = projectRound(
            {
              n: turn,
              action,
              calls: callData.map((call, i) => ({ call, result: resultData[i] })),
            },
            projection,
          )!
          turns.push(entry)
          const anySucceeded = outcomes.some((o) => o.success)
          const errors = combineOutcomes(eventOutcomes).errors

          // Partial failure → continue (the controller sees per-call __error
          // entries and can retry just those). ALL failed → the same, since
          // #437 slice 1: the turn log above already carries every per-call
          // error, so the next round is the controller's chance to react.
          //
          // EXCEPT when a call THREW (`callTool` raised rather than returning
          // a failure — the deterministic sanitizer's throw is the case that
          // matters). A singular throw is fatal (the outer catch below), and
          // the sanitizer's throw policy is #206 D1, an owner decision this
          // loop does not take. So an all-failed batch holding a throw keeps
          // the pre-#437 fatal break, exactly as before. (A batch in which
          // another call SUCCEEDED continued past a throw before #437 too.)
          if (!anySucceeded && outcomes.some((o) => o.threw)) {
            hasError = true
            errorMessage = `All ${allCalls.length} calls of the multi-call turn failed: ${errors.join('; ')}`
            errorTurn = turn
            if (!plan && controllerLlmCall?.hitOutputCap) errorLlmCall = controllerLlmCall
            break
          }
          if (!anySucceeded) {
            if (!dispatched && streak.unusableAnswer()) {
              // The consecutive-recovery cap: a turn that dispatched nothing
              // ends the loop as an all-failed batch did before #437.
              hasError = true
              errorMessage = `All ${allCalls.length} calls of the multi-call turn failed: ${errors.join('; ')}`
              errorTurn = turn
              errorLlmCall = plan ? undefined : controllerLlmCall
              recoveryCapHit = true
              break
            }
            trackLoopRecovery(
              scope,
              {
                failure: 'batch_failed',
                error: `All ${allCalls.length} calls of the multi-call turn failed: ${errors.join('; ')}`,
                turn,
                maxTurns,
              },
              // A batch that failed wholesale because the response was CUT OFF
              // is an LLM-output failure, not a tool failure: carry the
              // response so the panel can show what was actually generated.
              // Tool-level failures keep no llmCall — the model's output was fine.
              !plan && controllerLlmCall?.hitOutputCap ? controllerLlmCall : undefined,
            )
            continue
          }

          scope.data = { ...scope.data, turn, lastAction: plan ? batchEventAction(action) : action }
          continue
        }

        // Validate tool against the allowlist (`isAllowedTool`, above), which
        trackAction()
        // refuses a tool withheld from every agent (#403) whatever `tools` says.
        if (!isAllowedTool(action.tool_name)) {
          // Nothing ran: record the refusal as the round's result so the next
          // round can pick a tool that exists (#437 slice 1 — this used to end
          // the loop, with rounds left, on one invented name). `refusal()`
          // names a withheld tool as such, so the model reads "withheld", not
          // "misspelled", and a write-shaped request gets an answer.
          const refused = refusal(action.tool_name)
          if (streak.unusableAnswer()) {
            // The consecutive-recovery cap: this refusal ends the loop exactly
            // as every refusal did before #437.
            hasError = true
            errorMessage = refused
            errorTurn = turn
            errorLlmCall = controllerLlmCall
            recoveryCapHit = true
            break
          }
          const recovery: LoopRecoveryEventData = {
            failure: 'tool_not_allowed',
            error: refused,
            tool: action.tool_name,
            turn,
            maxTurns,
          }
          // The BAML call SUCCEEDED: the tool name the model chose is the
          // defect, so the response that named it is the evidence.
          trackLoopRecovery(scope, recovery, controllerLlmCall)
          turns.push(projectRound({ n: turn, action, recovery, calls: [] }, projection)!)
          continue
        }

        // Parse tool args (lenient — LLMs may output unquoted keys/values)
        let args: Record<string, unknown>
        let argsRepair: JsonRepairNote | undefined
        try {
          const parsed = repairJsonTracked(action.tool_args)
          args = parsed.args
          argsRepair = parsed.repair
        } catch (err) {
          // Truncation-aware: a response cut off at the client's max_tokens
          // cap is not malformed JSON, and generic "fix your JSON" feedback
          // makes the model regenerate the same oversized payload — so the
          // feedback names the real cause and how to split the work.
          const feedback = invalidToolArgsFeedback(
            action.tool_name,
            action.tool_args,
            controllerLlmCall?.hitOutputCap ?? false,
            err,
          )
          if (streak.unusableAnswer()) {
            // The consecutive-recovery cap: these args end the loop as they
            // did before #437, with the same message the recovery would carry.
            hasError = true
            errorMessage = feedback
            errorTurn = turn
            errorLlmCall = controllerLlmCall
            recoveryCapHit = true
            break
          }
          const recovery: LoopRecoveryEventData = {
            failure: 'invalid_tool_args',
            error: feedback,
            tool: action.tool_name,
            turn,
            maxTurns,
          }
          // Unparseable or truncated `tool_args` is a failure OF the response,
          // and the reason is only ever visible in the raw text — a cut-off
          // heredoc, a bare string where JSON was required.
          trackLoopRecovery(scope, recovery, controllerLlmCall)
          turns.push(projectRound({ n: turn, action, recovery, calls: [] }, projection)!)
          continue
        }

        // Generate correlation ID for this tool call/result pair
        const callId = generateId('tc')

        // Resolve ref: pointers in args (expands to full tool result data from prior events)
        // and capture the substitutions so they render in the next prompt iteration.
        const { resolved: resolvedArgs } = resolveRefsAndCapture(
          args,
          view,
          settings.maxResultChars,
          excluded,
        )

        // Track tool call event (with original args for readability)
        const callKey = callKeyOf(turn, 0)
        const call: ToolCallEventData = {
          callId,
          tool: action.tool_name,
          args,
          ...(argsRepair ? { repaired: argsRepair } : {}),
          ...(callKey !== undefined ? { callKey } : {}),
        }
        trackEvent(scope, 'tool_call', call, resolved.trackHistory)

        // Execute tool with resolved args. A dispatch ends any run of unusable
        // answers, whatever the tool then returns.
        streak.dispatched()
        const result = await dispatch(action.tool_name, resolvedArgs, callKey)

        // onToolResult hook: enrich/transform result before the event is committed.
        await hookResult(action.tool_name, result, callId, resolvedArgs, turn)

        // Track tool result event. `result.data` is already the sanitized
        // content when a `withInjectionGuard` wrapper neutralized it in
        // callTool; `sanitized` carries the audit trail alongside it.
        const resultData: ToolResultEventData = {
          callId,
          tool: action.tool_name,
          result: result.data,
          success: result.success,
          error: result.error,
          ...(result.sanitized ? { sanitized: result.sanitized } : {}),
        }
        trackEvent(scope, 'tool_result', resultData, resolved.trackHistory)

        // The stop check after a single call (#433): the call is waiting for a
        // person, and its held placeholder is tracked above. Stop with NO error
        // event — unlike the failure paths below, nothing failed, and the
        // budget was not exhausted either.
        if (hitlPending()) return scope

        // Record completed turn for LoopController history, by the one
        // projection a resume uses as well. `resultOmit` projects the
        // CONTROLLER's view only — the event above keeps the complete result
        // for compactExecution and the citation extractors.
        turns.push(
          projectRound({ n: turn, action, calls: [{ call, result: resultData }] }, projection)!,
        )

        // A failed tool call is the round's observation, not the end of the
        // loop (#437 slice 1, #425 C1): the turn above already carries the
        // error, and the next round is the controller's chance to retry with
        // corrected arguments, try another tool, or Return and say what went
        // wrong. A partly failed batch always worked this way; a single failed
        // call used to end the loop with rounds left.
        if (!result.success) {
          trackLoopRecovery(scope, {
            failure: 'tool_error',
            error: result.error ?? 'Tool call failed',
            tool: action.tool_name,
            turn,
            maxTurns,
          })
          continue
        }

        // Update scope data
        scope.data = {
          ...scope.data,
          turn,
          lastAction: action,
        }
      }

      if (hasError) {
        // Track error event — downstream patterns read errors via view.errors().
        // When the error originated from a failed BAML call, attach the captured
        // LLM call data so the Observability panel can render the same
        // Prompt/Output drill-down as a successful call.
        trackEvent(
          scope,
          'error',
          {
            error: errorMessage,
            severity: resolved.errorSeverity,
            hint: getErrorHint(errorMessage ?? ''),
            turn: errorTurn,
            ...(errorLlmCall ? { kind: 'llm_call' as const } : {}),
            // Stopped by the consecutive-recovery cap: the marker, the cap and
            // a hint naming the lever replace `kind` and the message-keyed hint
            // above; the failure, severity and llmCall are the pre-#437 ones.
            ...(recoveryCapHit
              ? recoveryExhaustedMarker(maxConsecutiveRecoveries, resolved.patternId)
              : {}),
          } as ErrorEventData,
          true,
          errorLlmCall,
        )
      } else if (!exitedViaReturn && turns.length > 0) {
        // Loop exhausted maxTurns without controller signaling completion.
        // Surface as a recoverable error so the compactExecution can warn the user;
        // partial results from completed turns are still preserved on scope.
        //
        // `kind: 'budget_exhausted'` + `maxTurns` are what make this identifiable
        // as a TRUNCATION rather than a failure (#269): nothing here errored, the
        // loop was cut off mid-work, and a reader — the panel, a test, a future
        // eval — should not have to match the sentence below to know that. The
        // run this came from spent 8 non-repeating rounds and lost its
        // deliverable to the cap.
        trackEvent(
          scope,
          'error',
          {
            error: `Loop exhausted: reached maxTurns (${maxTurns}) without 'Return' or is_final from the controller. Partial results from ${turns.length} completed turn(s) are preserved.`,
            severity: 'recoverable',
            // Name the lever that ACTUALLY bound. A pattern's own `maxTurns`
            // wins over `settings.maxToolTurns`, so telling a developer to raise
            // the setting is advice that does nothing for a pinned loop — which
            // is exactly the case that hit this in #269 (`general`, pinned at
            // 8, with the setting reading 5).
            hint: budgetHint('maxToolTurns', config?.maxTurns, maxTurns, resolved.patternId),
            turn: turns.length - 1,
            maxTurns,
            kind: 'budget_exhausted' as const,
          } as ErrorEventData,
          true,
        )
      }

      return scope
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      trackEvent(
        scope,
        'error',
        {
          error: msg,
          severity: resolved.errorSeverity,
          hint: getErrorHint(msg),
        } as ErrorEventData,
        true,
      )
      return scope
    }
  }

  return {
    name: 'simpleLoop',
    fn,
    config: resolved,
    estimateTurns: (s) => resolveTurnBudget('maxToolTurns', config?.maxTurns, s.maxToolTurns),
    // The allowlist this loop will accept (minus what no agent may call), for
    // static introspection — the planner's agent map reads it (#507).
    capabilities: {
      tools: tools.filter((name) => !isAgentWithheldTool(name)),
      // It dispatches the gate itself, so it ends a continuation: no `next`.
      ...(recordsRounds ? { resumable: { fingerprint } } : {}),
    },
  }
}
