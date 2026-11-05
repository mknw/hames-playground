/**
 * Per-turn guard counts for the general-next Eval report (boundary guards,
 * slice 7; revision 6, slice 17). The design's read of the general-next run:
 * every run reports CLASSIFICATION calls (the injection-ingress-guard, the
 * retired gate's replacement), screen calls, their latency, prompts raised and
 * defaulted, roster-matched calls allowed, and Decide timeouts and failures —
 * per turn, from the turn's own events.
 *
 * Everything is computed from the turn's own events — no field on the trace,
 * no plumbing through the driver — so a run's report and any later
 * re-derivation from a capture agree.
 *
 * Counts only; nothing here judges. The unit pin
 * (`guard-report.test.ts`) holds the exact numbers against a scripted trace
 * and the negative case the pin exists for: a route decision (`next_step`) is
 * not a classification call, whatever its shape.
 */
import type { ContextEvent } from '@hames-ai/harness-patterns'
import {
  GUARD_INGRESS,
  GUARD_INGRESS_SAFE_LINE,
} from '@hames-ai/harness-patterns/guard-gate.server'
import type { ConversationTrace } from './conversation'

export interface GuardTurnCounts {
  /** 1-based turn index, matching the report's turn numbering. */
  readonly turn: number
  /** Classification calls this turn: `decision_made` keyed `guard.ingress`. */
  readonly classificationCalls: number
  /** How many were `'shadow'` answers (recorded, changing no presentation). */
  readonly classificationShadow: number
  /** Unavailable answers (a timeout, a transport failure, a state that could
   *  not be rendered): the content flows unmarked, and these are the
   *  answers a calibration read must not silently absorb. */
  readonly classificationUnavailable: number
  /** How many answers present as `safe` (argmax `safe` at or above the safe
   *  line — the classification's own rule, re-derived here so the report and
   *  the mark can never disagree about which reads "safe"). */
  readonly classificationSafe: number
  /** Summed wall-clock of the classification's own calls (ms), `null` when
   *  none reported. */
  readonly classificationLatencyMs: number | null
  /** Screen calls this turn: `model_call` events with role `screen`. */
  readonly screenCalls: number
  /** Summed wall-clock of the screen's own calls (ms), `null` when none reported. */
  readonly screenLatencyMs: number | null
  /** `hitl_request` events this turn. */
  readonly promptsRaised: number
  /** `hitl_response` events answered by the unattended rule. */
  readonly promptsDefaulted: number
  /** `egress_audit` events: outgoing calls allowed although the roster matched. */
  readonly egressAudited: number
  /** `egress_refused` events: the tripwire's raw record. */
  readonly egressRefused: number
  /** Decide timeouts and failures on the guards' questions this turn:
   *  `decision_made` keyed `guard.*` with `abstained` true. A growing number
   *  here is an egress gate quietly degraded to the roster alone. */
  readonly decideDown: number
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {}

const latencyOf = (events: readonly ContextEvent[]): number | null => {
  let total = 0
  let seen = false
  for (const e of events) {
    const ms = e.llmCall?.durationMs
    if (typeof ms === 'number') {
      total += ms
      seen = true
    }
  }
  return seen ? total : null
}

export function guardTurnCounts(turns: ConversationTrace['turns']): GuardTurnCounts[] {
  return turns.map((turn, index) => {
    const events = turn.events
    const classification = events.filter(
      (e) => e.type === 'decision_made' && record(e.data).key === GUARD_INGRESS.key,
    ) as Array<ContextEvent & { data: Record<string, unknown> }>
    const guardsDown = events.filter(
      (e) =>
        e.type === 'decision_made' &&
        String(record(e.data).key ?? '').startsWith('guard.') &&
        record(e.data).abstained === true,
    )
    const screens = events.filter(
      (e) => e.type === 'model_call' && record(e.data).role === 'screen',
    )
    const responses = events.filter((e) => e.type === 'hitl_response')
    const presentsSafe = (e: ContextEvent & { data: Record<string, unknown> }): boolean =>
      e.data.label === 'safe' &&
      Number((e.data.probs as Record<string, number> | undefined)?.safe) >= GUARD_INGRESS_SAFE_LINE
    return {
      turn: index + 1,
      classificationCalls: classification.length,
      classificationShadow: classification.filter((e) => e.data.shadow === true).length,
      classificationUnavailable: classification.filter((e) => e.data.abstained === true).length,
      classificationSafe: classification.filter(presentsSafe).length,
      classificationLatencyMs: latencyOf(classification),
      screenCalls: screens.length,
      screenLatencyMs: latencyOf(screens),
      promptsRaised: events.filter((e) => e.type === 'hitl_request').length,
      promptsDefaulted: responses.filter((e) => record(e.data).by === 'unattended').length,
      egressAudited: events.filter((e) => e.type === 'egress_audit').length,
      egressRefused: events.filter((e) => e.type === 'egress_refused').length,
      decideDown: guardsDown.length,
    }
  })
}
