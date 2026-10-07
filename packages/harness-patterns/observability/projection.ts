/**
 * Event-stream projections for the observability timeline.
 *
 * Everything the panel renders is a projection of the event stream; these are
 * the pure ones — row preview text, the lane an event belongs in, and the
 * tool_call/tool_result merge. Split out of `ObservabilityPanel.tsx`
 * (#226 B5) with no behaviour change.
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
  WarningEventData,
  LoopRecoveryEventData,
  HitlRequestEventData,
  HitlResponseEventData,
} from '../types'

export function getEventPreview(type: EventType, data: unknown): string {
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
      return d.message.length > 50 ? d.message.slice(0, 50) + '...' : d.message
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
      // renders, and never the question or the state (#418).
      const d = data as DecisionMadeEventData
      const head = d.abstained
        ? `${d.key}: abstained${d.reason ? ` (${d.reason})` : ''} → ${d.label}`
        : `${d.key}: ${d.label}`
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
