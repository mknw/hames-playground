/**
 * Event-stream projections for the observability timeline.
 *
 * Everything the panel renders is a projection of the event stream; these are
 * the pure ones — row preview text, the lane an event belongs in, whether it is
 * a guard's, and the tool_call/tool_result merge. Split out of
 * `ObservabilityPanel.tsx` (#226 B5) with no behaviour change.
 */

import type {
  ContextEvent,
  EventType,
  ToolCallEventData,
  ToolResultEventData,
  ControllerActionEventData,
  ErrorEventData,
  IntentCompactedEventData,
  PlanCreatedEventData,
  ContentSanitizedEventData,
  DecisionMadeEventData,
  EgressAuditEventData,
  EgressRefusedEventData,
  ModelCallEventData,
  WarningEventData,
  LoopRecoveryEventData,
  HitlRequestEventData,
  HitlResponseEventData,
} from '../types'

/** The guard an event records (boundary guards), named as the row says it. */
type Guard = 'injection' | 'egress' | 'privacy'

/**
 * Which guard an event belongs to, from the marker its type declares — the
 * decision key, the model-call role, the warning task — never from wording.
 * The key literals are the ones `GUARD_SCREEN` and `GUARD_EGRESS` declare:
 * this module is client-safe and cannot import those server modules.
 */
function guardOf(type: EventType, data: unknown): Guard | undefined {
  switch (type) {
    case 'content_sanitized':
      return 'injection'
    case 'model_call':
      return (data as Partial<ModelCallEventData> | undefined)?.role === 'screen'
        ? 'injection'
        : undefined
    case 'decision_made': {
      const key = (data as Partial<DecisionMadeEventData> | undefined)?.key
      return key === 'guard.screen' ? 'injection' : key === 'guard.egress' ? 'egress' : undefined
    }
    case 'egress_audit':
    case 'egress_refused':
      return 'egress'
    case 'warning': {
      const task = (data as Partial<WarningEventData> | undefined)?.task
      return task === 'egress_check' ? 'egress' : task === 'web_privacy' ? 'privacy' : undefined
    }
    default:
      return undefined
  }
}

/**
 * Whether an event is a guard's: the injection guard's sanitized content, its
 * screen call and the gate that decides whether the screen runs; the egress
 * gate's question, audit, refusal and warnings; the privacy filter's (K5)
 * warning. The panel gives these their own lane, so `getEventLane` keeps its
 * two-lane signature.
 */
export function isGuardEvent(type: EventType, data: unknown): boolean {
  return guardOf(type, data) !== undefined
}

/** A row's preview. A guard's event leads with the guard's name, so a row says
 *  which control acted before what it did. */
export function getEventPreview(type: EventType, data: unknown): string {
  const action = actionPreview(type, data)
  const guard = guardOf(type, data)
  if (!guard) return action
  const head = `${guard} · ${action}`
  return head.length > 50 ? head.slice(0, 50) + '...' : head
}

function actionPreview(type: EventType, data: unknown): string {
  switch (type) {
    case 'tool_call': {
      const d = data as ToolCallEventData
      return d.tool
    }
    case 'tool_result': {
      const d = data as ToolResultEventData
      return `${d.tool}: ${d.success ? 'ok' : 'error'}`
    }
    case 'controller_action': {
      const d = data as ControllerActionEventData
      const extra = d.action.additional_calls?.length
      // Plain text, no glyph: this preview is rendered as a string in a narrow
      // ellipsized cell, so it is the one chrome site an icon class cannot
      // reach. The `⚡` that used to lead it went out with the emoji sweep.
      return extra
        ? `×${extra + 1} ${d.action.tool_name}, ${d.action.additional_calls!.map((c) => c.tool_name).join(', ')}`
        : d.action.tool_name
    }
    case 'user_message':
    case 'assistant_message': {
      const d = data as { content: string }
      const content = d.content || ''
      return content.length > 50 ? content.slice(0, 50) + '...' : content
    }
    case 'hitl_request': {
      // The kind, never the question or the summary: those are the dialog's,
      // and a summary can hold a string an attacker chose (#433 P3, m7).
      const d = data as Partial<HitlRequestEventData>
      return `decision requested: ${d.kind}`
    }
    case 'hitl_response': {
      const d = data as Partial<HitlResponseEventData>
      return `decision: ${d.kind} → ${d.choice ?? 'none'} (${d.by})`
    }
    case 'approval_request':
    case 'approval_response':
      // Legacy (#433, F9): superseded by hitl_*. Whatever an older run stored
      // is not read, here as in every LLM-facing view.
      return 'legacy approval event'
    case 'error': {
      const d = data as ErrorEventData
      return d.error.slice(0, 50)
    }
    case 'intent_compacted': {
      const d = data as IntentCompactedEventData
      const brief = d.intent || ''
      return brief.length > 50 ? brief.slice(0, 50) + '...' : brief
    }
    case 'plan_created': {
      const d = data as PlanCreatedEventData
      if (d.skipped) return `skipped (${d.skipped})`
      const steps = d.plan?.n_steps ?? 0
      const first = (d.plan?.plan ?? '').split('\n')[0] ?? ''
      const head = `${steps} step${steps === 1 ? '' : 's'}: ${first}`
      return head.length > 50 ? head.slice(0, 50) + '...' : head
    }
    case 'content_sanitized': {
      const d = data as ContentSanitizedEventData
      // Keyed on FINDINGS, not on `neutralized`: with `spotlight: 'always'` the
      // content is "neutralized" (fenced) even when nothing was detected, so the
      // only reason this event exists with no findings is a screen outage.
      if (d.findings.length === 0) return `${d.tool}: screen unavailable`
      const rules = [...new Set(d.findings.map((f) => f.rule))]
      const head = `${d.tool}: ${d.findings.length} neutralized (${rules.join(', ')})`
      return head.length > 50 ? head.slice(0, 50) + '...' : head
    }
    case 'warning': {
      const d = data as WarningEventData
      // The privacy filter says why and how much it withheld, from its
      // code-built detail; a warning recorded before it did keeps its sentence.
      const reason = d.task === 'web_privacy' ? d.detail?.reason : undefined
      const head =
        reason === undefined ? d.message : `withheld ${d.detail?.events ?? '?'} events (${reason})`
      return head.length > 50 ? head.slice(0, 50) + '...' : head
    }
    case 'egress_audit': {
      // Counts the matched names, never quotes them: a span names a person (SD-3).
      const d = data as Partial<EgressAuditEventData>
      const names = d.spans?.length ?? 0
      return `${d.tool}: let out by ${d.allowedBy}, ${names} name${names === 1 ? '' : 's'}`
    }
    case 'egress_refused': {
      // A category is Decide's, so it stands for the cause; `unchecked` has none.
      const d = data as Partial<EgressRefusedEventData>
      const closes = d.closes === 'route' || d.closes === 'turn' ? `closes ${d.closes}` : undefined
      return `${d.tool}: refused (${[d.category ?? d.cause, closes].filter(Boolean).join(', ')})`
    }
    case 'loop_recovery': {
      // The class and the round, which is what tells a recovery from a
      // failure at a glance; the verbatim error is one click away in the
      // detail view.
      const d = data as LoopRecoveryEventData
      const head = `${d.failure}${d.tool ? ` ${d.tool}` : ''} · ${d.turn + 1}/${d.maxTurns}`
      return head.length > 50 ? head.slice(0, 50) + '...' : head
    }
    case 'decision_made': {
      // `key: label`, or the abstain reason — the same fields `formatEventData`
      // renders, and never the question or the state (#418). A shadow gate's
      // row says what the gate WOULD have done at its configured threshold
      // (`wouldRun`, #784 item 10): the argmax `label` can read 'false' while
      // the gate would have run the screen.
      const d = data as DecisionMadeEventData
      const verdict =
        d.shadow && typeof d.wouldRun === 'boolean'
          ? `would ${d.wouldRun ? 'screen' : 'skip'}`
          : d.label
      const head = d.abstained
        ? `${d.key}: abstained${d.reason ? ` (${d.reason})` : ''} → ${verdict}`
        : d.type === 'score'
          ? `${d.key}: ${verdict} (E=${d.expected?.toFixed(2) ?? 'unknown'})`
          : d.type === 'noul'
            ? `${d.key}: ${verdict} (p=${d.pTrue?.toFixed(2) ?? 'unknown'})`
            : `${d.key}: ${verdict}`
      return head.length > 50 ? head.slice(0, 50) + '...' : head
    }
    case 'model_call': {
      // The role and what it read; the client and cost are on the row's LLM
      // chip and in the detail, where every other model call shows them.
      const d = data as ModelCallEventData
      const head = `${d.role}${d.source ? ` ${d.source}` : d.items ? ` ×${d.items}` : ''}`
      return head.length > 50 ? head.slice(0, 50) + '...' : head
    }
    case 'pattern_enter':
    case 'pattern_exit':
      return ''
    default:
      return ''
  }
}

export function getEventLane(type: EventType): 'interface' | 'tools' {
  switch (type) {
    case 'user_message':
    case 'assistant_message':
    case 'pattern_enter':
    case 'pattern_exit':
    case 'hitl_request':
    case 'hitl_response':
    case 'approval_request':
    case 'approval_response':
      return 'interface'
    default:
      return 'tools'
  }
}

// ============================================================================
// Timeline Item Types (merged tool pairs)
// ============================================================================

export type TimelineItem =
  | { kind: 'event'; event: ContextEvent }
  | { kind: 'tool_pair'; call: ContextEvent; result: ContextEvent }

/** Merge consecutive tool_call + tool_result with matching callId into tool_pair items */
export function buildTimelineItems(events: ContextEvent[]): TimelineItem[] {
  const items: TimelineItem[] = []
  const consumed = new Set<number>()

  for (let i = 0; i < events.length; i++) {
    if (consumed.has(i)) continue

    const ev = events[i]
    if (ev.type === 'tool_call') {
      const callData = ev.data as ToolCallEventData
      if (callData.callId) {
        // Look ahead for matching tool_result
        for (let j = i + 1; j < events.length; j++) {
          if (consumed.has(j)) continue
          const candidate = events[j]
          if (candidate.type === 'tool_result') {
            const resultData = candidate.data as ToolResultEventData
            if (resultData.callId === callData.callId) {
              items.push({ kind: 'tool_pair', call: ev, result: candidate })
              consumed.add(i)
              consumed.add(j)
              break
            }
          }
        }
        if (!consumed.has(i)) {
          // No matching result found — render as standalone
          items.push({ kind: 'event', event: ev })
        }
      } else {
        items.push({ kind: 'event', event: ev })
      }
    } else {
      items.push({ kind: 'event', event: ev })
    }
  }

  return items
}
