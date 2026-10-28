/**
 * Per-turn guard counts for the general-next Eval report (boundary guards,
 * slice 7). The design's read of the general-next run: every run reports gate
 * calls, screen calls, the gate's skip rate, their latency, prompts raised and
 * defaulted, roster-matched calls allowed, and Decide timeouts and failures —
 * per turn, from the turn's own events. The
 * timeouts are the number the redesign exists to move: an egress gate quietly
 * degraded to the roster alone is visible here instead of invisible.
 *
 * Everything is computed from the turn's own events — no field on the trace,
 * no plumbing through the driver — so a run's report and any later re-derivation
 * from a capture agree. The gate's skip rate is `guardGateSkipRate` itself (the
 * slice-3 function, computed from `decision_made` events keyed `guard.screen`
 * alone), reused rather than re-derived: one reader, not two.
 *
 * Counts only; nothing here judges. The unit pin
 * (`guard-report.test.ts`) holds the exact numbers against a scripted trace
 * and the negative case the pin exists for: a route decision (`next_step`) is
 * not a gate call, whatever its shape.
 */
import type { ContextEvent } from '@hames-ai/harness-patterns'
import {
  guardGateSkipRate,
  GUARD_GATE_THRESHOLD,
  GUARD_SCREEN,
} from '@hames-ai/harness-patterns/guard-gate.server'
import type { ConversationTrace } from './conversation'

export interface GuardTurnCounts {
  /** 1-based turn index, matching the report's turn numbering. */
  readonly turn: number
  /** Gate calls this turn: `decision_made` keyed `guard.screen`. */
  readonly gateCalls: number
  /** How many would have skipped the screen (pTrue below τi, in `'shadow'`
   *  recorded and ignored). */
  readonly gateSkipped: number
  /** Unavailable answers (a timeout, a transport failure, a state that could
   *  not be rendered): the screen runs anyway, and these are the D5-adjacent
   *  answers the skip rate must not silently absorb. */
  readonly gateUnavailable: number
  /** Skipped / asked, over this turn's gate answers. */
  readonly gateSkipRate: number
  /** Summed wall-clock of the gate's own calls (ms), `null` when none reported. */
  readonly gateLatencyMs: number | null
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

/** `gateThreshold` is the τi the run's gate ran with (`GUARD_GATE_THRESHOLD`
 *  when the deployment sets it, #844): the skip count is read against it. */
export function guardTurnCounts(
  turns: ConversationTrace['turns'],
  gateThreshold: number = GUARD_GATE_THRESHOLD,
): GuardTurnCounts[] {
  return turns.map((turn, index) => {
    const events = turn.events
    const decision = (key: string) =>
      events.filter((e) => e.type === 'decision_made' && record(e.data).key === key) as Array<
        ContextEvent & { data: Record<string, unknown> }
      >
    const gate = decision(GUARD_SCREEN.key)
    const rate = guardGateSkipRate(events, gateThreshold)
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
    return {
      turn: index + 1,
      gateCalls: gate.length,
      gateSkipped: rate.skipped,
      gateUnavailable: rate.unavailable,
      gateSkipRate: rate.rate,
      gateLatencyMs: latencyOf(gate),
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
