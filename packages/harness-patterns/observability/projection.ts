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
  CriticResultEventData,
  ToolResultEventData,
  ControllerActionEventData,
  ErrorEventData,
  IntentCompactedEventData,
  PlanCreatedEventData,
  ContentSanitizedEventData,
  DecisionMadeEventData,
  EgressAuditEventData,
  EgressRefusedEventData,
  EgressBlockedEventData,
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
      // `guard.screen` is the retired gate's question: persisted conversations
      // still hold its events, so it keeps rendering. `guard.ingress` is the
      // classification's (revision 6).
      return key === 'guard.screen' || key === 'guard.ingress'
        ? 'injection'
        : key === 'guard.egress'
          ? 'egress'
          : undefined
    }
    case 'egress_audit':
    case 'egress_refused':
    case 'egress_blocked':
      return 'egress'
    case 'error':
      return (data as Partial<ErrorEventData> | undefined)?.kind === 'egress_decide_unavailable'
        ? 'egress'
        : undefined
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
    case 'egress_blocked': {
      const d = data as EgressBlockedEventData
      return `${d.tool}: blocked (${d.rule})`
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

// ============================================================================
// Pattern-run sections (#1007 controller runs, #1025 every pattern)
// ============================================================================

/** The event types a controller run records under its own pattern id — the
 *  same set simpleLoop's round reconstruction reads (`ROUND_EVENTS`). A run
 *  holding any of them is a loop's work, and only a `controller_action` makes
 *  it a controller run (#1007). */
const CONTROLLER_RUN_TYPES: ReadonlySet<EventType> = new Set([
  'controller_action',
  'tool_call',
  'tool_result',
  'loop_recovery',
])

/**
 * Which pattern family an event belongs to — the generic grouping key
 * (#1025), and the collapsed section header's summary line. The family is
 * read from the event ITSELF — its type, and for the types that carry a
 * marker, that marker (a `model_call`'s role, a `decision_made`'s guard key) —
 * never from wording, and never from the `patternId` alone: a guard's events
 * ride the WRAPPED pattern's id, so keying the group on the id would fold a
 * control's record into the run it interrupted. An event of no family — an
 * `error` or `warning` row, the interface events, the enter/exit dividers, a
 * `model_call` of an unknown role — stays visible in the timeline and splits
 * any run it sits in. (A guard's marked error is family `guard`, and its
 * section flags it.)
 */
export type PatternFamily =
  'controller' | 'critic' | 'summariser' | 'decision' | 'guard' | 'memory' | 'planner' | 'retrieval'

export function familyOf(type: EventType, data: unknown): PatternFamily | undefined {
  switch (type) {
    case 'pattern_enter':
    case 'pattern_exit':
      return undefined
    case 'controller_action':
    case 'tool_call':
    case 'loop_recovery':
      return 'controller'
    case 'tool_result':
      // The retriever's own result event: it runs no controller action, so
      // #1010's run qualifier would never fold it. Its consecutive results
      // form a run of their own family (#1025 retrieval).
      return (data as Partial<ToolResultEventData> | undefined)?.tool === 'retriever'
        ? 'retrieval'
        : 'controller'
    case 'critic_result':
      return 'critic'
    case 'decision_made':
      return guardOf(type, data) ? 'guard' : 'decision'
    case 'model_call':
      // `screen` is the guard's own role, and the guard's classifier names it;
      // a role of no family (unknown, future) stays visible and splits runs.
      return (data as Partial<ModelCallEventData> | undefined)?.role === 'describe'
        ? 'summariser'
        : guardOf(type, data)
          ? 'guard'
          : undefined
    case 'memory_recalled':
    case 'memory_written':
      return 'memory'
    case 'plan_created':
      return 'planner'
    default:
      // A guard's marked error (`egress_decide_unavailable`) is a guard
      // family record: it folds into the guard section with its refusal,
      // and the collapsed header flags it — the marked-error row folded into
      // an unflagged header is the failure the grouping must not produce.
      return guardOf(type, data) ? 'guard' : undefined
  }
}

export type TimelineSection =
  | { kind: 'controller'; patternId: string; items: TimelineItem[] }
  | {
      kind: 'pattern'
      family: Exclude<PatternFamily, 'controller'>
      patternId: string
      items: TimelineItem[]
    }
  | { kind: 'single'; item: TimelineItem }

export type PatternSection = Extract<TimelineSection, { kind: 'pattern' }>
export type GroupSection = Extract<TimelineSection, { kind: 'controller' }> | PatternSection

/**
 * Group the timeline into display sections: one collapsible section per
 * pattern run — a controller run (#1007), or any other family's consecutive
 * related events (#1025) — everything else a single item.
 */
export function buildTimelineSections(events: ContextEvent[]): TimelineSection[] {
  return groupPatternRuns(buildTimelineItems(events))
}

/**
 * Group already-merged timeline items into pattern-run sections.
 *
 * A pattern run is a MAXIMAL CONSECUTIVE run of events under the same
 * patternId AND the same family — consecutive and same-family, because
 * anything else in between (a guard's event inside a loop's round, an error
 * row, the pattern's own enter/exit dividers, an event of no family) stays
 * visible in the timeline and splits the run. A controller run qualifies when
 * it holds a `controller_action` (#1007); every other family qualifies only
 * when SEVERAL related events accumulated, so a lone evaluation or decision
 * stays a row rather than disappearing behind a click for nothing.
 * Display-only: exports read the raw events, never this.
 */
export function groupPatternRuns(items: TimelineItem[]): TimelineSection[] {
  const sections: TimelineSection[] = []
  let pending: { patternId: string; family: PatternFamily; items: TimelineItem[] } | undefined

  const flush = () => {
    if (!pending) return
    const run = pending
    pending = undefined
    const qualifies =
      run.family === 'controller'
        ? run.items.some((item) => item.kind === 'event' && item.event.type === 'controller_action')
        : run.items.length >= 2
    if (!qualifies) {
      for (const item of run.items) sections.push({ kind: 'single', item })
      return
    }
    sections.push(
      run.family === 'controller'
        ? { kind: 'controller', patternId: run.patternId, items: run.items }
        : { kind: 'pattern', family: run.family, patternId: run.patternId, items: run.items },
    )
  }

  for (const item of items) {
    const event = item.kind === 'event' ? item.event : item.call
    const family = familyOf(event.type, event.data)
    const groupable =
      event.patternId !== undefined && event.patternId !== 'harness' && family !== undefined
    if (groupable && pending?.patternId === event.patternId && pending.family === family) {
      pending.items.push(item)
      continue
    }
    flush()
    if (groupable && family !== undefined) {
      pending = { patternId: event.patternId, family, items: [item] }
    } else {
      sections.push({ kind: 'single', item })
    }
  }
  flush()
  return sections
}

// ============================================================================
// Collapsed-header summaries (#1025) — small formatters, not new components
// ============================================================================

const countEventType = (items: TimelineItem[], type: EventType): number =>
  items.filter((item) => item.kind === 'event' && item.event.type === type).length

/** The events of one type in a run — a tool_pair contributes its call. */
const eventsOfType = (items: TimelineItem[], type: EventType): ContextEvent[] =>
  items.flatMap((item) => (item.kind === 'event' && item.event.type === type ? [item.event] : []))

/**
 * The collapsed header's one-line summary, per family: the count the family's
 * operator wants before deciding to expand. The controller line is #1007's,
 * byte for byte; every other family states what it did and whether it worked.
 */
export function sectionSummary(section: GroupSection): string {
  if (section.kind === 'controller') {
    const actions = countEventType(section.items, 'controller_action')
    const toolCalls = section.items.filter(
      (item) =>
        item.kind === 'tool_pair' || (item.kind === 'event' && item.event.type === 'tool_call'),
    ).length
    return `${actions} action${actions === 1 ? '' : 's'} · ${toolCalls} tool call${toolCalls === 1 ? '' : 's'}`
  }
  const items = section.items
  switch (section.family) {
    case 'critic': {
      const results = eventsOfType(items, 'critic_result').map(
        (event) => (event.data as Partial<CriticResultEventData> | undefined)?.result,
      )
      const sufficient = results.filter((r) => r?.is_sufficient === true).length
      const needed = results.filter((r) => r?.is_sufficient === false).length
      const parts = [`${results.length} evaluation${results.length === 1 ? '' : 's'}`]
      if (sufficient) parts.push(`${sufficient} sufficient`)
      if (needed) parts.push(`${needed} need${needed === 1 ? 's' : ''} work`)
      return parts.join(' · ')
    }
    case 'summariser': {
      const calls = eventsOfType(items, 'model_call')
      const summarised = calls.reduce(
        (sum, event) => sum + ((event.data as Partial<ModelCallEventData>)?.items ?? 1),
        0,
      )
      const n = calls.length
      return `${n} summar${n === 1 ? 'y' : 'ies'} · ${summarised} item${summarised === 1 ? '' : 's'}`
    }
    case 'decision': {
      const decisions = eventsOfType(items, 'decision_made')
      const last = decisions[decisions.length - 1]?.data as
        Partial<DecisionMadeEventData> | undefined
      const verdict = last
        ? last.abstained
          ? `abstained${last.reason ? ` (${last.reason})` : ''}`
          : (last.label ?? 'no route')
        : undefined
      // The real choice producers record the chosen label's probability in
      // `probs` (typedDecision; an absent `type` is a legacy/default choice) —
      // the noul path keeps its own `pTrue`. An abstained event names no label,
      // so it keeps its abstain reason without odds.
      const chosen = typeof last?.label === 'string' ? last?.probs?.[last.label] : undefined
      const odds =
        last?.type === 'noul' && typeof last.pTrue === 'number'
          ? ` (p=${last.pTrue.toFixed(2)})`
          : typeof chosen === 'number'
            ? ` (p=${chosen.toFixed(2)})`
            : ''
      const n = decisions.length
      return `${n} decision${n === 1 ? '' : 's'}${verdict ? ` · ${verdict}${odds}` : ''}`
    }
    case 'guard': {
      const findings = eventsOfType(items, 'content_sanitized').reduce(
        (sum, event) => sum + ((event.data as ContentSanitizedEventData).findings?.length ?? 0),
        0,
      )
      const checks = items.length
      return `${checks} check${checks === 1 ? '' : 's'} · ${findings} finding${findings === 1 ? '' : 's'}`
    }
    case 'retrieval': {
      const results = eventsOfType(items, 'tool_result')
      const matches = results.reduce(
        (sum, event) =>
          sum +
          (((event.data as ToolResultEventData).result as { matches?: unknown[] } | undefined)
            ?.matches?.length ?? 0),
        0,
      )
      const n = results.length
      return `${n} retrieval${n === 1 ? '' : 's'} · ${matches} match${matches === 1 ? '' : 'es'}`
    }
    case 'memory': {
      const written = countEventType(items, 'memory_written')
      const recalled = countEventType(items, 'memory_recalled')
      return `${written} written · ${recalled} recalled`
    }
    case 'planner': {
      const plans = eventsOfType(items, 'plan_created')
      const skippedPlan = plans.find(
        (event) => (event.data as Partial<PlanCreatedEventData>)?.skipped !== undefined,
      )?.data as Partial<PlanCreatedEventData> | undefined
      if (skippedPlan) return `skipped (${skippedPlan.skipped})`
      const steps = plans.reduce(
        (sum, event) => sum + ((event.data as Partial<PlanCreatedEventData>)?.plan?.n_steps ?? 0),
        0,
      )
      const n = plans.length
      return `${n} plan${n === 1 ? '' : 's'} · ${steps} step${steps === 1 ? '' : 's'}`
    }
  }
}
