/**
 * ObservabilityPanel Component
 *
 * Displays ContextEvents in a timeline format with expandable detail panels.
 * Events are displayed chronologically from top (oldest) to bottom (newest).
 * Pattern enter/exit rows are compact dividers; events within a pattern
 * are tinted with the pattern's colour from pattern-colors.json.
 */

import { For, Show, createSignal, createMemo, Switch, Match } from 'solid-js'
import { Tooltip } from '@ark-ui/solid/tooltip'
import { Accordion } from '@ark-ui/solid/accordion'
import type {
  ContextEvent,
  EventType,
  ToolCallEventData,
  ToolResultEventData,
  ControllerActionEventData,
  UserMessageEventData,
  AssistantMessageEventData,
  ApprovalRequestEventData,
  ErrorEventData,
  IntentCompactedEventData,
  PlanCreatedEventData,
  LLMCallData,
  UnifiedContext,
} from '~/lib/harness-patterns'
import patternColorsJson from '../../../pattern-colors.json'

interface ObservabilityPanelProps {
  events: ContextEvent[]
  context?: UnifiedContext
  onClear?: () => void
}

// ============================================================================
// Pattern Colors (loaded from pattern-colors.json)
// ============================================================================

interface PatternColorEntry {
  color: string
  tint: string
}

const patternColors = patternColorsJson as unknown as Record<string, PatternColorEntry>
const defaultPatternColor: PatternColorEntry = patternColors._default ?? {
  color: '#94a3b8',
  tint: 'rgba(148,163,184,0.06)',
}

function getPatternColor(patternId: string): PatternColorEntry {
  return patternColors[patternId] ?? defaultPatternColor
}

// ============================================================================
// Event Icons and Colors
// ============================================================================

const eventIcons: Record<EventType, string> = {
  user_message: '💬',
  assistant_message: '🤖',
  tool_call: '🔧',
  tool_result: '📥',
  controller_action: '🎯',
  critic_result: '📝',
  pattern_enter: '▶',
  pattern_exit: '■',
  approval_request: '⏸️',
  approval_response: '✅',
  error: '❌',
  reference_attached: '🔗',
  intent_compacted: '🎯',
  plan_created: '🗺️',
}

const eventColors: Record<EventType, string> = {
  user_message: '#60a5fa', // blue-400
  assistant_message: '#34d399', // green-400
  tool_call: '#a78bfa', // violet-400
  tool_result: '#22d3ee', // cyan-400
  controller_action: '#fbbf24', // amber-400
  critic_result: '#f472b6', // pink-400
  pattern_enter: '#94a3b8', // overridden per-pattern
  pattern_exit: '#94a3b8', // overridden per-pattern
  approval_request: '#f97316', // orange-500
  approval_response: '#10b981', // emerald-500
  error: '#ef4444', // red-500
  reference_attached: '#c084fc', // purple-400
  intent_compacted: '#fbbf24', // amber-400 (an LLM reasoning step, like controller_action)
  plan_created: '#fbbf24', // amber-400 (same family: an LLM reasoning step, no tool call)
}

// ============================================================================
// Helper Functions
// ============================================================================

function getEventPreview(type: EventType, data: unknown): string {
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
      return extra
        ? `⚡×${extra + 1} ${d.action.tool_name}, ${d.action.additional_calls!.map((c) => c.tool_name).join(', ')}`
        : d.action.tool_name
    }
    case 'user_message':
    case 'assistant_message': {
      const d = data as { content: string }
      const content = d.content || ''
      return content.length > 50 ? content.slice(0, 50) + '...' : content
    }
    case 'approval_request': {
      const d = data as ApprovalRequestEventData
      return d.request.action
    }
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
    case 'pattern_enter':
    case 'pattern_exit':
      return ''
    default:
      return ''
  }
}

function getEventLane(type: EventType): 'interface' | 'tools' {
  switch (type) {
    case 'user_message':
    case 'assistant_message':
    case 'pattern_enter':
    case 'pattern_exit':
    case 'approval_request':
    case 'approval_response':
      return 'interface'
    default:
      return 'tools'
  }
}

// ============================================================================
// Summary Bar Component
// ============================================================================

/** Compact token count: 1234 → "1.2k", 25_320 → "25.3k". */
const fmtTok = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

/** Cost with enough precision to be meaningful at per-call scale. */
const fmtUsd = (v: number): string => (v >= 0.1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`)

/** Fold `event.metrics` (first-class accounting, #122) into session totals.
 *  Events predating the metrics attribute fall back to `llmCall.usage` — no
 *  cache-write bucket there, and no cost (partial pricing would mislead). */
const foldTokenTotals = (events: ContextEvent[]) => {
  const t = {
    llmCalls: 0,
    attempts: 0,
    inputUncached: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    costUsd: 0,
    noCacheUsd: 0,
    costKnownCalls: 0,
  }
  for (const e of events) {
    const m = e.metrics
    if (m) {
      t.llmCalls++
      t.attempts += m.attempts
      t.inputUncached += m.inputUncachedTokens
      t.cacheRead += m.inputCacheReadTokens
      t.cacheWrite += m.inputCacheWriteTokens
      t.output += m.outputTokens
      if (m.costUsd !== undefined) {
        t.costUsd += m.costUsd
        t.noCacheUsd += m.noCacheUsd ?? m.costUsd
        t.costKnownCalls++
      }
    } else if (e.llmCall?.usage) {
      const u = e.llmCall.usage
      t.llmCalls++
      t.attempts++
      t.inputUncached += u.inputTokens
      t.cacheRead += u.cachedInputTokens
      t.cacheWrite += u.cacheCreationInputTokens ?? 0
      t.output += u.outputTokens
    }
  }
  const inputTotal = t.inputUncached + t.cacheRead + t.cacheWrite
  return {
    ...t,
    inputTotal,
    cachedPct: inputTotal > 0 ? t.cacheRead / inputTotal : 0,
    savedPct: t.noCacheUsd > 0 ? (t.noCacheUsd - t.costUsd) / t.noCacheUsd : 0,
  }
}

const SummaryBar = (props: { events: ContextEvent[]; onClear?: () => void }) => {
  const metrics = createMemo(() => {
    const events = props.events
    const toolResults = events.filter((e) => e.type === 'tool_result')
    const successCount = toolResults.filter((e) => (e.data as ToolResultEventData).success).length
    const errorCount = events.filter((e) => e.type === 'error').length

    return {
      totalEvents: events.length,
      successRate: toolResults.length > 0 ? successCount / toolResults.length : 1,
      errorCount,
    }
  })

  const tokenTotals = createMemo(() => foldTokenTotals(props.events))

  return (
    <div p="3" bg="dark-bg-tertiary" border="b dark-border-primary" flex="~ wrap" gap="4">
      <div flex="~" items="center" gap="2">
        <span text="xs dark-text-tertiary">Events:</span>
        <span text="sm dark-text-primary" font="mono">
          {metrics().totalEvents}
        </span>
      </div>

      <div flex="~" items="center" gap="2">
        <span text="xs dark-text-tertiary">Success:</span>
        <span
          text={`sm ${metrics().successRate >= 0.9 ? 'neon-green' : metrics().successRate >= 0.5 ? 'neon-yellow' : 'red-500'}`}
          font="mono"
        >
          {Math.round(metrics().successRate * 100)}%
        </span>
      </div>

      <Show when={metrics().errorCount > 0}>
        <div flex="~" items="center" gap="2">
          <span text="xs dark-text-tertiary">Errors:</span>
          <span text="sm red-400" font="mono">
            {metrics().errorCount}
          </span>
        </div>
      </Show>

      {/* Session-level token/cost accounting (#122) — fold over event.metrics */}
      <Show when={tokenTotals().llmCalls > 0}>
        <div flex="~" items="center" gap="2" title="Input tokens: fresh / cache-read / cache-write">
          <span text="xs dark-text-tertiary">In:</span>
          <span text="sm neon-green" font="mono">
            {fmtTok(tokenTotals().inputUncached)}
          </span>
          <Show when={tokenTotals().cacheRead > 0 || tokenTotals().cacheWrite > 0}>
            <span text="sm violet-400" font="mono">
              +{fmtTok(tokenTotals().cacheRead)}⚡
            </span>
            <span text="sm amber-400" font="mono">
              +{fmtTok(tokenTotals().cacheWrite)}✎
            </span>
          </Show>
        </div>
        <div flex="~" items="center" gap="2">
          <span text="xs dark-text-tertiary">Out:</span>
          <span text="sm neon-cyan" font="mono">
            {fmtTok(tokenTotals().output)}
          </span>
        </div>
        <Show when={tokenTotals().cachedPct > 0}>
          <div
            flex="~"
            items="center"
            gap="2"
            title="Share of input tokens served from cache (0.1× rate)"
          >
            <span text="xs dark-text-tertiary">Cached:</span>
            <span text="sm violet-400" font="mono">
              {Math.round(tokenTotals().cachedPct * 100)}%
            </span>
          </div>
        </Show>
        <Show when={tokenTotals().costKnownCalls > 0}>
          <div
            flex="~"
            items="center"
            gap="2"
            title={`Estimated from per-call rates at call time; ${tokenTotals().costKnownCalls}/${tokenTotals().llmCalls} calls priced. Without caching: ${fmtUsd(tokenTotals().noCacheUsd)}`}
          >
            <span text="xs dark-text-tertiary">Cost:</span>
            <span text="sm dark-text-primary" font="mono">
              {fmtUsd(tokenTotals().costUsd)}
            </span>
            <Show when={tokenTotals().savedPct > 0.005}>
              <span text="xs neon-green" font="mono">
                −{Math.round(tokenTotals().savedPct * 100)}%
              </span>
            </Show>
          </div>
        </Show>
        <Show when={tokenTotals().attempts > tokenTotals().llmCalls}>
          <div
            flex="~"
            items="center"
            gap="2"
            title="Physical API calls exceeded LLM steps — retries/fallbacks burned extra spend (already included in the totals)"
          >
            <span text="xs dark-text-tertiary">Retries:</span>
            <span text="sm amber-400" font="mono">
              +{tokenTotals().attempts - tokenTotals().llmCalls}
            </span>
          </div>
        </Show>
      </Show>

      <Show when={props.events.length > 0}>
        <button
          onClick={() => props.onClear?.()}
          m="l-auto"
          p="x-2 y-1"
          text="xs red-400"
          bg="red-600/10 hover:red-600/20"
          border="1 red-500/30"
          rounded="md"
          cursor="pointer"
          transition="all"
        >
          Clear
        </button>
      </Show>
    </div>
  )
}

// ============================================================================
// Pattern Enter/Exit Row (compact divider)
// ============================================================================

const PatternBoundaryRow = (props: { event: ContextEvent }) => {
  const { type, patternId } = props.event
  const isEnter = type === 'pattern_enter'
  const pc = getPatternColor(patternId)

  return (
    <div
      flex="~"
      items="center"
      gap="2"
      p="x-3 y-1"
      style={{
        'background-color': pc.tint,
        'border-top': isEnter ? `1px solid ${pc.color}40` : 'none',
        'border-bottom': !isEnter ? `1px solid ${pc.color}40` : 'none',
        'min-height': '24px',
      }}
    >
      <span
        style={{
          color: pc.color,
          'font-size': '9px',
          'line-height': '1',
        }}
      >
        {isEnter ? '▶' : '■'}
      </span>
      <span
        style={{
          color: pc.color,
          'font-size': '10px',
          'font-family': '"Fira Code", ui-monospace, monospace',
          'font-weight': '500',
        }}
      >
        {patternId}
      </span>
      <span
        style={{
          color: `${pc.color}99`,
          'font-size': '9px',
          'font-family': '"Fira Code", ui-monospace, monospace',
        }}
      >
        {isEnter ? 'enter' : 'exit'}
      </span>
    </div>
  )
}

// ============================================================================
// Event Row Component
// ============================================================================

const EventRow = (props: {
  event: ContextEvent
  index: number
  expanded: boolean
  onExpand: () => void
  bgTint?: string
}) => {
  const { type, patternId, data } = props.event

  // Guard against malformed events (e.g. from SSE stream)
  if (!type) return null

  const icon = eventIcons[type]
  const preview = getEventPreview(type, data)
  const lane = getEventLane(type)
  const color = eventColors[type]

  const NodeContent = () => (
    <div
      flex="~ col"
      items="center"
      gap="1"
      p="2 3"
      cursor="pointer"
      bg={props.expanded ? 'dark-bg-tertiary' : 'transparent hover:dark-bg-hover'}
      border={props.expanded ? '1 neon-cyan/30' : 'none'}
      rounded="md"
      transition="all"
      onClick={props.onExpand}
      w="full"
    >
      {/* Icon */}
      <span text="lg">{icon}</span>

      {/* Event type */}
      <div
        style={{
          color,
          'font-size': '11px',
          'font-family': '"Fira Code", ui-monospace, monospace',
          'font-weight': '500',
          'text-align': 'center',
        }}
      >
        {type.replace(/_/g, ' ')}
      </div>

      {/* Pattern ID */}
      <Show when={patternId && patternId !== 'harness'}>
        <div text="xs dark-text-tertiary" font="mono">
          {patternId}
        </div>
      </Show>

      {/* Preview */}
      <Show when={preview}>
        <div
          text="xs dark-text-secondary"
          max-w="120px"
          overflow="hidden"
          style={{ 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}
        >
          {preview}
        </div>
      </Show>
    </div>
  )

  return (
    <div
      flex="~"
      min-h="70px"
      border="b dark-border-secondary/30"
      style={{ 'background-color': props.bgTint ?? 'transparent' }}
    >
      {/* Interface Lane (left) */}
      <div w="1/2" flex="~" justify="center" items="center" border="r dark-border-secondary/30">
        <Show when={lane === 'interface'}>
          <NodeContent />
        </Show>
      </div>

      {/* Tools Lane (right) */}
      <div w="1/2" flex="~" justify="center" items="center">
        <Show when={lane === 'tools'}>
          <NodeContent />
        </Show>
      </div>
    </div>
  )
}

// ============================================================================
// Lane Headers Component
// ============================================================================

const LaneHeaders = () => (
  <div
    flex="~"
    border="b dark-border-primary"
    bg="dark-bg-secondary"
    style={{ position: 'sticky', top: '0', 'z-index': '10' }}
  >
    {/* Interface Lane Header */}
    <div
      w="1/2"
      p="2"
      flex="~"
      items="center"
      justify="center"
      gap="2"
      border="r dark-border-secondary"
    >
      <div w="2" h="2" rounded="full" bg="cyber-500" />
      <span text="xs dark-text-primary" font="medium">
        Interface
      </span>
    </div>

    {/* Tools Lane Header */}
    <div w="1/2" p="2" flex="~" items="center" justify="center" gap="2">
      <div w="2" h="2" rounded="full" bg="neon-cyan" />
      <span text="xs dark-text-primary" font="medium">
        Tools
      </span>
    </div>
  </div>
)

// ============================================================================
// Empty State Component
// ============================================================================

const EmptyState = () => (
  <div flex="~ col" items="center" justify="center" h="full" p="8" text="center">
    <svg
      width="48"
      height="48"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      style={{ color: '#4f46e5', opacity: 0.4 }}
    >
      <path d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
    <div text="sm dark-text-secondary" m="t-3">
      No events yet
    </div>
    <div text="xs dark-text-tertiary" m="t-1">
      Send a message to see the timeline
    </div>
  </div>
)

// ============================================================================
// Timeline Item Types (merged tool pairs)
// ============================================================================

type TimelineItem =
  | { kind: 'event'; event: ContextEvent }
  | { kind: 'tool_pair'; call: ContextEvent; result?: ContextEvent }

/** Merge consecutive tool_call + tool_result with matching callId into tool_pair items */
function buildTimelineItems(events: ContextEvent[]): TimelineItem[] {
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
// Tool Pair Row Component (merged tool_call + tool_result)
// ============================================================================

const ToolPairRow = (props: {
  call: ContextEvent
  result?: ContextEvent
  index: number
  expanded: boolean
  onExpand: () => void
  bgTint?: string
}) => {
  const callData = () => props.call.data as ToolCallEventData
  const resultData = () => props.result?.data as ToolResultEventData | undefined
  const success = () => resultData()?.success ?? true
  const preview = () =>
    `${callData().tool}: ${resultData() ? (success() ? 'ok' : 'error') : 'pending'}`

  return (
    <div
      flex="~"
      min-h="70px"
      border="b dark-border-secondary/30"
      style={{ 'background-color': props.bgTint ?? 'transparent' }}
    >
      {/* Interface Lane (left) - empty for tool pairs */}
      <div w="1/2" flex="~" justify="center" items="center" border="r dark-border-secondary/30" />

      {/* Tools Lane (right) */}
      <div w="1/2" flex="~" justify="center" items="center">
        <div
          flex="~ col"
          items="center"
          gap="1"
          p="2 3"
          cursor="pointer"
          bg={props.expanded ? 'dark-bg-tertiary' : 'transparent hover:dark-bg-hover'}
          border={props.expanded ? '1 neon-cyan/30' : 'none'}
          rounded="md"
          transition="all"
          onClick={props.onExpand}
          w="full"
        >
          <span text="lg">🔧</span>
          <div
            style={{
              color: success() ? '#a78bfa' : '#ef4444',
              'font-size': '11px',
              'font-family': '"Fira Code", ui-monospace, monospace',
              'font-weight': '500',
              'text-align': 'center',
            }}
          >
            tool call
          </div>
          <Show when={props.call.patternId && props.call.patternId !== 'harness'}>
            <div text="xs dark-text-tertiary" font="mono">
              {props.call.patternId}
            </div>
          </Show>
          <div
            text="xs dark-text-secondary"
            max-w="120px"
            overflow="hidden"
            style={{ 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}
          >
            {preview()}
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================================
// Tool Pair Detail Component
// ============================================================================

const ToolPairDetail = (props: {
  call: ContextEvent
  result?: ContextEvent
  onClose: () => void
}) => {
  const callData = () => props.call.data as ToolCallEventData
  const resultData = () => props.result?.data as ToolResultEventData | undefined

  return (
    <div
      style={{
        position: 'absolute',
        inset: '0',
        'background-color': 'rgba(13, 17, 23, 0.95)',
        'backdrop-filter': 'blur(4px)',
        'z-index': '50',
        display: 'flex',
        'flex-direction': 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div flex="~" items="center" justify="between" p="4" border="b dark-border-primary">
        <div flex="~ col" gap="1">
          <div flex="~" items="center" gap="2">
            <span text="lg">🔧</span>
            <span text="sm dark-text-primary" font="medium">
              tool call
            </span>
            <Show when={props.call.llmCall}>
              <span text="xs neon-cyan" bg="neon-cyan/10" p="x-1.5 y-0.5" rounded="sm" font="mono">
                LLM
              </span>
            </Show>
          </div>
          <div flex="~" gap="3" text="xs dark-text-tertiary">
            <span>{props.call.patternId}</span>
            <span>{new Date(props.call.ts).toLocaleTimeString()}</span>
          </div>
        </div>
        <button
          onClick={props.onClose}
          p="2"
          text="dark-text-secondary"
          bg="dark-bg-hover hover:dark-bg-tertiary"
          rounded="md"
          cursor="pointer"
        >
          Close
        </button>
      </div>

      {/* Content */}
      <div flex="1" overflow="auto" p="4">
        {/* LLM Call Tabs */}
        <Show when={props.call.llmCall}>
          <LLMCallTabs llmCall={props.call.llmCall!} />
        </Show>

        {/* Tool name */}
        <div m="b-3">
          <div text="xs dark-text-tertiary" m="b-1">
            Tool
          </div>
          <div text="sm neon-cyan" font="mono">
            {callData().tool}
          </div>
        </div>

        {/* Arguments */}
        <div m="b-3">
          <div text="xs dark-text-tertiary" m="b-1">
            Arguments
          </div>
          <pre
            text="xs dark-text-primary"
            bg="dark-bg-tertiary"
            p="3"
            rounded="md"
            overflow="auto"
            max-h="200px"
          >
            {JSON.stringify(callData().args, null, 2)}
          </pre>
        </div>

        {/* Result */}
        <Show when={resultData()}>
          <div m="b-3">
            <div text="xs dark-text-tertiary" m="b-1">
              Status
            </div>
            <div text={`sm ${resultData()!.success ? 'neon-green' : 'red-400'}`} font="medium">
              {resultData()!.success ? 'Success' : `Error: ${resultData()!.error}`}
            </div>
          </div>
          <div>
            <div text="xs dark-text-tertiary" m="b-1">
              Result
            </div>
            <pre
              text="xs dark-text-primary"
              bg="dark-bg-tertiary"
              p="3"
              rounded="md"
              overflow="auto"
              max-h="300px"
            >
              {JSON.stringify(resultData()!.result, null, 2)}
            </pre>
          </div>
        </Show>
      </div>
    </div>
  )
}

// ============================================================================
// Event Detail Components
// ============================================================================

const ToolCallDetail = (props: { data: ToolCallEventData }) => (
  <div flex="~ col" gap="3">
    <div>
      <div text="xs dark-text-tertiary" m="b-1">
        Tool
      </div>
      <div text="sm neon-cyan" font="mono">
        {props.data.tool}
      </div>
    </div>
    <div>
      <div text="xs dark-text-tertiary" m="b-1">
        Arguments
      </div>
      <pre
        text="xs dark-text-primary"
        bg="dark-bg-tertiary"
        p="3"
        rounded="md"
        overflow="auto"
        max-h="300px"
      >
        {JSON.stringify(props.data.args, null, 2)}
      </pre>
    </div>
  </div>
)

const ToolResultDetail = (props: { data: ToolResultEventData }) => (
  <div flex="~ col" gap="3">
    <div>
      <div text="xs dark-text-tertiary" m="b-1">
        Tool
      </div>
      <div text="sm neon-cyan" font="mono">
        {props.data.tool}
      </div>
    </div>
    <div>
      <div text="xs dark-text-tertiary" m="b-1">
        Status
      </div>
      <div text={`sm ${props.data.success ? 'neon-green' : 'red-400'}`} font="medium">
        {props.data.success ? 'Success' : `Error: ${props.data.error}`}
      </div>
    </div>
    <div>
      <div text="xs dark-text-tertiary" m="b-1">
        Result
      </div>
      <pre
        text="xs dark-text-primary"
        bg="dark-bg-tertiary"
        p="3"
        rounded="md"
        overflow="auto"
        max-h="300px"
      >
        {JSON.stringify(props.data.result, null, 2)}
      </pre>
    </div>
  </div>
)

const ActionDetail = (props: { data: ControllerActionEventData }) => (
  <div flex="~ col" gap="3">
    <div>
      <div text="xs dark-text-tertiary" m="b-1">
        Tool
      </div>
      <div text="sm neon-cyan" font="mono">
        {props.data.action.tool_name}
      </div>
    </div>
    <Show when={props.data.action.reasoning}>
      <div>
        <div text="xs dark-text-tertiary" m="b-1">
          Reasoning
        </div>
        <div text="sm dark-text-primary">{props.data.action.reasoning}</div>
      </div>
    </Show>
    <div>
      <div text="xs dark-text-tertiary" m="b-1">
        Arguments
      </div>
      <pre
        text="xs dark-text-primary"
        bg="dark-bg-tertiary"
        p="3"
        rounded="md"
        overflow="auto"
        max-h="200px"
      >
        {props.data.action.tool_args}
      </pre>
    </div>
    <Show when={props.data.action.additional_calls?.length}>
      <div>
        <div text="xs dark-text-tertiary" m="b-1">
          Additional calls (same turn)
        </div>
        <div flex="~ col" gap="2">
          <For each={props.data.action.additional_calls ?? []}>
            {(call) => (
              <div>
                <div text="sm neon-cyan" font="mono">
                  {call.tool_name}
                </div>
                <pre
                  text="xs dark-text-primary"
                  bg="dark-bg-tertiary"
                  p="2"
                  rounded="md"
                  overflow="auto"
                  max-h="120px"
                >
                  {call.tool_args}
                </pre>
              </div>
            )}
          </For>
        </div>
      </div>
    </Show>
    <div flex="~" gap="4">
      <div>
        <div text="xs dark-text-tertiary" m="b-1">
          Final
        </div>
        <div text="sm dark-text-primary">{props.data.action.is_final ? 'Yes' : 'No'}</div>
      </div>
      <Show when={props.data.action.status}>
        <div>
          <div text="xs dark-text-tertiary" m="b-1">
            Status
          </div>
          <div text="sm dark-text-primary">{props.data.action.status}</div>
        </div>
      </Show>
    </div>
  </div>
)

const ErrorDetail = (props: { data: ErrorEventData }) => (
  <div flex="~ col" gap="3">
    <div>
      <div text="xs dark-text-tertiary" m="b-1">
        Error
      </div>
      <div
        text="sm red-400"
        bg="red-500/5"
        border="1 red-500/20"
        p="3"
        rounded="md"
        font="mono"
        style={{ 'white-space': 'pre-wrap', 'word-break': 'break-word' }}
      >
        {props.data.error}
      </div>
    </div>
    <div flex="~ wrap" gap="4">
      <Show when={props.data.severity}>
        <div>
          <div text="xs dark-text-tertiary" m="b-1">
            Severity
          </div>
          <div
            text={`sm ${props.data.severity === 'irrecoverable' ? 'red-400' : 'amber-400'}`}
            font="mono"
          >
            {props.data.severity}
          </div>
        </div>
      </Show>
      <Show when={props.data.turn !== undefined}>
        <div>
          <div text="xs dark-text-tertiary" m="b-1">
            Turn
          </div>
          <div text="sm dark-text-primary" font="mono">
            {props.data.turn}
          </div>
        </div>
      </Show>
      <Show when={props.data.iteration !== undefined}>
        <div>
          <div text="xs dark-text-tertiary" m="b-1">
            Iteration
          </div>
          <div text="sm dark-text-primary" font="mono">
            {props.data.iteration}
          </div>
        </div>
      </Show>
    </div>
    <Show when={props.data.hint}>
      <div>
        <div text="xs dark-text-tertiary" m="b-1">
          Hint
        </div>
        <div text="sm dark-text-secondary" style={{ 'white-space': 'pre-wrap' }}>
          {props.data.hint}
        </div>
      </div>
    </Show>
  </div>
)

const MessageDetail = (props: { data: { content: string }; role: 'user' | 'assistant' }) => (
  <div flex="~ col" gap="3">
    <div>
      <div text="xs dark-text-tertiary" m="b-1">
        Role
      </div>
      <div text="sm dark-text-primary" font="medium">
        {props.role}
      </div>
    </div>
    <div>
      <div text="xs dark-text-tertiary" m="b-1">
        Content
      </div>
      <div
        text="sm dark-text-primary"
        bg="dark-bg-tertiary"
        p="3"
        rounded="md"
        style={{ 'white-space': 'pre-wrap' }}
      >
        {props.data.content}
      </div>
    </div>
  </div>
)

const GenericDetail = (props: { data: unknown }) => (
  <div>
    <div text="xs dark-text-tertiary" m="b-2">
      Data
    </div>
    <pre
      text="xs dark-text-primary"
      bg="dark-bg-tertiary"
      p="3"
      rounded="md"
      overflow="auto"
      max-h="400px"
    >
      {JSON.stringify(props.data, null, 2)}
    </pre>
  </div>
)

// ============================================================================
// Shared Components
// ============================================================================

const CodeBlock = (props: { content: string | undefined; placeholder?: string }) => (
  <pre
    text="xs dark-text-primary"
    bg="dark-bg-tertiary"
    p="3"
    rounded="md"
    overflow="auto"
    max-h="300px"
    style={{ 'white-space': 'pre-wrap', 'word-break': 'break-word' }}
  >
    {props.content ?? props.placeholder ?? 'Not captured'}
  </pre>
)

// ============================================================================
// Parsed Prompt View Component
// ============================================================================

interface ParsedMessage {
  role: string
  content: string
}

const roleColors: Record<string, string> = {
  system: '#a78bfa', // violet-400
  user: '#60a5fa', // blue-400
  assistant: '#34d399', // green-400
  tool: '#22d3ee', // cyan-400
}

/** Parse OpenAI-compatible HTTP body into structured messages + metadata */
function parsePromptBody(
  rawInput: string,
): { messages: ParsedMessage[]; model?: string; params: Record<string, unknown> } | null {
  try {
    const body = JSON.parse(rawInput)
    if (!body || typeof body !== 'object' || !Array.isArray(body.messages)) return null

    const messages: ParsedMessage[] = body.messages.map(
      (m: { role?: string; content?: unknown }) => ({
        role: String(m.role ?? 'unknown'),
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2),
      }),
    )

    // Extract non-message params
    const { messages: _, model, ...rest } = body
    return { messages, model, params: rest }
  } catch {
    return null
  }
}

const PromptMessage = (props: { msg: ParsedMessage }) => {
  const color = () => roleColors[props.msg.role] ?? '#94a3b8'

  return (
    <div border="1 dark-border-secondary/40" rounded="md" overflow="hidden">
      {/* Role badge */}
      <div
        p="x-3 y-1.5"
        flex="~"
        items="center"
        gap="2"
        style={{ 'border-bottom': '1px solid rgba(148,163,184,0.15)' }}
        bg="dark-bg-tertiary"
      >
        <div w="2" h="2" rounded="full" style={{ 'background-color': color() }} />
        <span text="xs" font="mono medium" style={{ color: color() }}>
          {props.msg.role}
        </span>
      </div>
      {/* Content */}
      <pre
        text="xs dark-text-primary"
        p="3"
        m="0"
        overflow="auto"
        max-h="250px"
        style={{ 'white-space': 'pre-wrap', 'word-break': 'break-word' }}
      >
        {props.msg.content}
      </pre>
    </div>
  )
}

const ParsedPromptView = (props: { rawInput: string }) => {
  const parsed = () => parsePromptBody(props.rawInput)

  return (
    <Show
      when={parsed()}
      fallback={<CodeBlock content={props.rawInput} placeholder="Parsed prompt not captured" />}
    >
      {(p) => (
        <div flex="~ col" gap="3">
          {/* Model & params bar */}
          <Show when={p().model || Object.keys(p().params).length > 0}>
            <div
              flex="~ wrap"
              gap="4"
              items="center"
              bg="dark-bg-tertiary"
              p="2 3"
              rounded="md"
              text="xs"
            >
              <Show when={p().model}>
                <div flex="~ col" gap="0.5">
                  <span text="dark-text-tertiary">Model</span>
                  <span text="dark-text-primary" font="mono">
                    {p().model}
                  </span>
                </div>
              </Show>
              <For
                each={Object.entries(p().params).filter(
                  ([k]) => !['stream', 'stream_options'].includes(k),
                )}
              >
                {([key, val]) => (
                  <div flex="~ col" gap="0.5">
                    <span text="dark-text-tertiary">{key}</span>
                    <span text="dark-text-primary" font="mono">
                      {typeof val === 'object' ? JSON.stringify(val) : String(val)}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>

          {/* Messages */}
          <div flex="~ col" gap="2">
            <div text="xs dark-text-tertiary">
              {p().messages.length} message{p().messages.length !== 1 ? 's' : ''}
            </div>
            <For each={p().messages}>{(msg) => <PromptMessage msg={msg} />}</For>
          </div>
        </div>
      )}
    </Show>
  )
}

// ============================================================================
// LLM Call Tabs Component
// ============================================================================

type LLMTab = 'prompt' | 'output'

const TabButton = (props: { active: boolean; label: string; onClick: () => void }) => (
  <button
    onClick={props.onClick}
    p="x-3 y-1.5"
    text={`xs ${props.active ? 'neon-cyan' : 'dark-text-secondary hover:dark-text-primary'}`}
    bg={props.active ? 'neon-cyan/10' : 'transparent hover:dark-bg-hover'}
    border={props.active ? '1 neon-cyan/30' : '1 transparent'}
    rounded="md"
    cursor="pointer"
    transition="all"
    font="medium"
  >
    {props.label}
  </button>
)

const UsageStats = (props: { llmCall: LLMCallData }) => (
  <div bg="dark-bg-tertiary" p="3" rounded="md" m="b-3">
    <div flex="~ wrap" gap="4" items="center">
      {/* Function & Provider */}
      <div flex="~ col" gap="0.5">
        <span text="xs dark-text-tertiary">Function</span>
        <span text="sm neon-cyan" font="mono">
          {props.llmCall.functionName}
        </span>
      </div>
      <Show when={props.llmCall.provider}>
        <div flex="~ col" gap="0.5">
          <span text="xs dark-text-tertiary">Provider</span>
          <span text="sm dark-text-primary" font="mono">
            {props.llmCall.provider}
          </span>
        </div>
      </Show>
      <Show when={props.llmCall.clientName}>
        <div flex="~ col" gap="0.5">
          <span text="xs dark-text-tertiary">Client</span>
          <span text="sm dark-text-primary" font="mono">
            {props.llmCall.clientName}
          </span>
        </div>
      </Show>

      {/* Separator */}
      <div w="px" h="8" bg="dark-border-secondary" />

      {/* Token stats — selected exchange (full breakdown, #122) */}
      <Show when={props.llmCall.usage}>
        <div flex="~ col" gap="0.5" title="Input tokens billed at the full base rate">
          <span text="xs dark-text-tertiary">Input (fresh)</span>
          <span text="sm neon-green" font="mono">
            {props.llmCall.usage!.inputTokens.toLocaleString()}
          </span>
        </div>
        <Show when={props.llmCall.usage!.cachedInputTokens > 0}>
          <div
            flex="~ col"
            gap="0.5"
            title="Input tokens read from cache — billed at 0.1× the base rate"
          >
            <span text="xs dark-text-tertiary">Cache read</span>
            <span text="sm violet-400" font="mono">
              {props.llmCall.usage!.cachedInputTokens.toLocaleString()}
            </span>
          </div>
        </Show>
        <Show when={(props.llmCall.usage!.cacheCreationInputTokens ?? 0) > 0}>
          <div
            flex="~ col"
            gap="0.5"
            title="Input tokens written to cache — billed at 1.25× the base rate"
          >
            <span text="xs dark-text-tertiary">Cache write</span>
            <span text="sm amber-400" font="mono">
              {props.llmCall.usage!.cacheCreationInputTokens!.toLocaleString()}
            </span>
          </div>
        </Show>
        <div flex="~ col" gap="0.5">
          <span text="xs dark-text-tertiary">Output</span>
          <span text="sm neon-cyan" font="mono">
            {props.llmCall.usage!.outputTokens.toLocaleString()}
          </span>
        </div>
        <div
          flex="~ col"
          gap="0.5"
          title="All tokens processed: fresh + cache read + cache write + output"
        >
          <span text="xs dark-text-tertiary">Total</span>
          <span text="sm amber-400" font="mono">
            {props.llmCall.usage!.totalTokens.toLocaleString()}
          </span>
        </div>
      </Show>

      {/* Step accounting — summed across ALL attempts (retries/fallbacks) */}
      <Show when={props.llmCall.metrics}>
        <Show when={props.llmCall.metrics!.attempts > 1}>
          <div
            flex="~ col"
            gap="0.5"
            title="This step needed multiple API calls (truncation retry / fallback chain); tokens and cost below include all of them"
          >
            <span text="xs dark-text-tertiary">Attempts</span>
            <span text="sm red-400" font="mono">
              {props.llmCall.metrics!.attempts}
            </span>
          </div>
        </Show>
        <Show when={props.llmCall.metrics!.costUsd !== undefined}>
          <div
            flex="~ col"
            gap="0.5"
            title={`At $${props.llmCall.metrics!.rates?.inPerMTok}/$${props.llmCall.metrics!.rates?.outPerMTok} per MTok; uncached this call would be ${fmtUsd(props.llmCall.metrics!.noCacheUsd ?? props.llmCall.metrics!.costUsd!)}`}
          >
            <span text="xs dark-text-tertiary">Cost (step)</span>
            <span text="sm dark-text-primary" font="mono">
              {fmtUsd(props.llmCall.metrics!.costUsd!)}
            </span>
          </div>
        </Show>
      </Show>

      {/* Duration */}
      <Show when={props.llmCall.durationMs}>
        <div flex="~ col" gap="0.5">
          <span text="xs dark-text-tertiary">Duration</span>
          <span text="sm dark-text-primary" font="mono">
            {props.llmCall.durationMs}ms
          </span>
        </div>
      </Show>
    </div>
  </div>
)

/** One section inside the Prompt accordion. */
const PromptAccordionItem = (props: {
  value: string
  label: string
  hint?: string
  children: import('solid-js').JSX.Element
}) => (
  <Accordion.Item
    value={props.value}
    border="1 dark-border-secondary/40"
    rounded="md"
    overflow="hidden"
  >
    <Accordion.ItemTrigger
      w="full"
      p="x-3 y-2"
      flex="~"
      items="center"
      justify="between"
      gap="3"
      bg="dark-bg-tertiary hover:dark-bg-hover"
      cursor="pointer"
      text="left"
      style={{ border: 'none' }}
    >
      <div flex="~" items="center" gap="2">
        <span text="xs neon-cyan" font="mono medium">
          {props.label}
        </span>
        <Show when={props.hint}>
          <span text="xs dark-text-tertiary">{props.hint}</span>
        </Show>
      </div>
      <Accordion.ItemIndicator
        text="xs dark-text-secondary"
        style={{ transition: 'transform 150ms', 'transform-origin': 'center' }}
      >
        ▼
      </Accordion.ItemIndicator>
    </Accordion.ItemTrigger>
    <Accordion.ItemContent p="3" bg="dark-bg-secondary">
      {props.children}
    </Accordion.ItemContent>
  </Accordion.Item>
)

const PromptAccordion = (props: { llmCall: LLMCallData }) => {
  const hasTemplate = () => Boolean(props.llmCall.promptTemplate)
  const hasMessages = () => Boolean(props.llmCall.rawInput)
  const variableKeys = () => Object.keys(props.llmCall.variables ?? {})

  // Default-open the most informative section that has data
  const defaultValue = () => {
    if (hasTemplate()) return ['template']
    if (hasMessages()) return ['messages']
    return ['variables']
  }

  return (
    <Accordion.Root multiple defaultValue={defaultValue()} flex="~ col" gap="2">
      <PromptAccordionItem
        value="template"
        label="Template"
        hint={hasTemplate() ? 'Jinja source with {{ vars }} and conditionals' : 'not captured'}
      >
        <Show
          when={hasTemplate()}
          fallback={
            <div text="xs dark-text-tertiary">
              BAML prompt template not captured. Run <code>pnpm baml-generate</code> or verify the
              function name <code>{props.llmCall.functionName}</code> exists in{' '}
              <code>baml_src/</code>.
            </div>
          }
        >
          <CodeBlock content={props.llmCall.promptTemplate} />
        </Show>
      </PromptAccordionItem>

      <PromptAccordionItem
        value="variables"
        label="Variables"
        hint={`${variableKeys().length} input${variableKeys().length === 1 ? '' : 's'}`}
      >
        <Show
          when={variableKeys().length > 0}
          fallback={<div text="xs dark-text-tertiary">No variables passed to this function.</div>}
        >
          <CodeBlock content={JSON.stringify(props.llmCall.variables, null, 2)} />
        </Show>
      </PromptAccordionItem>

      <PromptAccordionItem
        value="messages"
        label="Rendered messages"
        hint={hasMessages() ? 'what actually went to the LLM' : 'not captured'}
      >
        <Show
          when={hasMessages()}
          fallback={
            <div text="xs dark-text-tertiary">
              HTTP request body not captured by the BAML collector.
            </div>
          }
        >
          <ParsedPromptView rawInput={props.llmCall.rawInput!} />
        </Show>
      </PromptAccordionItem>
    </Accordion.Root>
  )
}

const LLMCallTabs = (props: { llmCall: LLMCallData }) => {
  const [activeTab, setActiveTab] = createSignal<LLMTab>('prompt')

  return (
    <div border="b dark-border-primary" m="b-4" p="b-4">
      {/* Usage stats bar */}
      <UsageStats llmCall={props.llmCall} />

      {/* Tab buttons */}
      <div flex="~ wrap" gap="2" m="b-3">
        <TabButton
          active={activeTab() === 'prompt'}
          label="Prompt"
          onClick={() => setActiveTab('prompt')}
        />
        <TabButton
          active={activeTab() === 'output'}
          label="Output"
          onClick={() => setActiveTab('output')}
        />
      </div>

      {/* Tab content */}
      <Switch>
        <Match when={activeTab() === 'prompt'}>
          <PromptAccordion llmCall={props.llmCall} />
        </Match>
        <Match when={activeTab() === 'output'}>
          <CodeBlock
            content={
              props.llmCall.parsedOutput != null
                ? typeof props.llmCall.parsedOutput === 'string'
                  ? props.llmCall.parsedOutput
                  : JSON.stringify(props.llmCall.parsedOutput, null, 2)
                : undefined
            }
            placeholder="Output not captured"
          />
        </Match>
      </Switch>
    </div>
  )
}

// ============================================================================
// Event Detail Panel Component
// ============================================================================

const EventDetailPanel = (props: { event: ContextEvent; onClose: () => void }) => {
  const { type, ts, patternId, data, llmCall } = props.event

  return (
    <div
      style={{
        position: 'absolute',
        inset: '0',
        'background-color': 'rgba(13, 17, 23, 0.95)',
        'backdrop-filter': 'blur(4px)',
        'z-index': '50',
        display: 'flex',
        'flex-direction': 'column',
        overflow: 'hidden',
      }}
    >
      {/* Header */}
      <div flex="~" items="center" justify="between" p="4" border="b dark-border-primary">
        <div flex="~ col" gap="1">
          <div flex="~" items="center" gap="2">
            <span text="lg">{eventIcons[type]}</span>
            <span text="sm dark-text-primary" font="medium">
              {type.replace(/_/g, ' ')}
            </span>
            <Show when={llmCall}>
              <span text="xs neon-cyan" bg="neon-cyan/10" p="x-1.5 y-0.5" rounded="sm" font="mono">
                LLM
              </span>
            </Show>
          </div>
          <div flex="~" gap="3" text="xs dark-text-tertiary">
            <span>{patternId}</span>
            <span>{new Date(ts).toLocaleTimeString()}</span>
          </div>
        </div>
        <button
          onClick={props.onClose}
          p="2"
          text="dark-text-secondary"
          bg="dark-bg-hover hover:dark-bg-tertiary"
          rounded="md"
          cursor="pointer"
        >
          Close
        </button>
      </div>

      {/* Content */}
      <div flex="1" overflow="auto" p="4">
        {/* LLM Call Tabs - shown when event has llmCall data */}
        <Show when={llmCall}>
          <LLMCallTabs llmCall={llmCall!} />
        </Show>

        {/* Event-specific content — skip for messages with LLM tabs (avoids duplication) */}
        <Show when={!(llmCall && (type === 'assistant_message' || type === 'user_message'))}>
          <Switch fallback={<GenericDetail data={data} />}>
            <Match when={type === 'tool_call'}>
              <ToolCallDetail data={data as ToolCallEventData} />
            </Match>
            <Match when={type === 'tool_result'}>
              <ToolResultDetail data={data as ToolResultEventData} />
            </Match>
            <Match when={type === 'controller_action'}>
              <ActionDetail data={data as ControllerActionEventData} />
            </Match>
            <Match when={type === 'user_message'}>
              <MessageDetail data={data as UserMessageEventData} role="user" />
            </Match>
            <Match when={type === 'assistant_message'}>
              <MessageDetail data={data as AssistantMessageEventData} role="assistant" />
            </Match>
            <Match when={type === 'error'}>
              <ErrorDetail data={data as ErrorEventData} />
            </Match>
          </Switch>
        </Show>
      </div>
    </div>
  )
}

// ============================================================================
// Main Panel Component
// ============================================================================

export const ObservabilityPanel = (props: ObservabilityPanelProps) => {
  const [expandedIndex, setExpandedIndex] = createSignal<number | null>(null)

  const handleSave = async () => {
    const payload = props.context ?? { events: props.events, exportedAt: Date.now() }
    const json = JSON.stringify(payload, null, 2)
    const sessionId = props.context?.sessionId ?? 'session'
    const date = new Date().toISOString().slice(0, 10)
    const filename = `context-${sessionId}-${date}.json`

    if (typeof window !== 'undefined' && 'showSaveFilePicker' in window) {
      try {
        const handle = await (
          window as typeof window & {
            showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle>
          }
        ).showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
        })
        const writable = await handle.createWritable()
        await writable.write(json)
        await writable.close()
      } catch (e) {
        if ((e as Error).name !== 'AbortError') console.error('Save failed', e)
      }
    } else {
      const blob = new Blob([json], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    }
  }

  // Sort events chronologically (oldest first)
  const timelineEvents = createMemo(() => {
    return [...props.events].sort((a, b) => a.ts - b.ts)
  })

  // Build merged timeline items (tool_call + tool_result → tool_pair)
  const timelineItems = createMemo(() => buildTimelineItems(timelineEvents()))

  // Compute per-item background tint based on active pattern stack
  const itemTints = createMemo(() => {
    const items = timelineItems()
    const tints: (string | undefined)[] = []
    const patternStack: string[] = []

    for (const item of items) {
      if (item.kind === 'tool_pair') {
        const activePattern =
          patternStack.length > 0 ? patternStack[patternStack.length - 1] : undefined
        tints.push(activePattern ? getPatternColor(activePattern).tint : undefined)
      } else {
        const event = item.event
        if (event.type === 'pattern_enter') {
          patternStack.push(event.patternId)
          tints.push(undefined)
        } else if (event.type === 'pattern_exit') {
          tints.push(undefined)
          const idx = patternStack.lastIndexOf(event.patternId)
          if (idx >= 0) patternStack.splice(idx, 1)
          else patternStack.pop()
        } else {
          const activePattern =
            patternStack.length > 0 ? patternStack[patternStack.length - 1] : undefined
          tints.push(activePattern ? getPatternColor(activePattern).tint : undefined)
        }
      }
    }
    return tints
  })

  // Get expanded item
  const expandedItem = createMemo(() => {
    const idx = expandedIndex()
    if (idx === null) return null
    return timelineItems()[idx] ?? null
  })

  const handleExpand = (index: number) => setExpandedIndex(index)
  const handleClose = () => setExpandedIndex(null)

  const hasEvents = () => timelineItems().length > 0

  return (
    <div flex="~ col" h="full" bg="dark-bg-primary" overflow="hidden" position="relative">
      {/* Summary Bar */}
      <SummaryBar events={props.events} onClear={props.onClear} />

      {/* Lane Headers */}
      <LaneHeaders />

      {/* Timeline Container */}
      <div flex="1" overflow="auto">
        <Show when={hasEvents()} fallback={<EmptyState />}>
          <For each={timelineItems()}>
            {(item, index) => {
              if (item.kind === 'tool_pair') {
                return (
                  <ToolPairRow
                    call={item.call}
                    result={item.result}
                    index={index()}
                    expanded={expandedIndex() === index()}
                    onExpand={() => handleExpand(index())}
                    bgTint={itemTints()[index()]}
                  />
                )
              }
              const event = item.event
              const isBoundary = () =>
                event.type === 'pattern_enter' || event.type === 'pattern_exit'
              return (
                <Show when={!isBoundary()} fallback={<PatternBoundaryRow event={event} />}>
                  <EventRow
                    event={event}
                    index={index()}
                    expanded={expandedIndex() === index()}
                    onExpand={() => handleExpand(index())}
                    bgTint={itemTints()[index()]}
                  />
                </Show>
              )
            }}
          </For>
        </Show>
      </div>

      {/* Save Button */}
      <Show when={props.events.length > 0}>
        <Tooltip.Root openDelay={300} closeDelay={100}>
          <Tooltip.Trigger
            onClick={handleSave}
            style={{ position: 'absolute', bottom: '1rem', right: '1rem', 'z-index': '20' }}
            p="2.5"
            bg="dark-bg-tertiary hover:dark-bg-hover"
            border="1 dark-border-primary hover:neon-cyan/40"
            rounded="lg"
            cursor="pointer"
            transition="all"
            shadow="lg"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              style={{ color: '#22d3ee' }}
            >
              <path
                d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </Tooltip.Trigger>
          <Tooltip.Positioner>
            <Tooltip.Content
              bg="dark-bg-tertiary"
              border="1 dark-border-primary"
              rounded="md"
              p="x-2 y-1"
              text="xs dark-text-primary"
              shadow="md"
            >
              Save session
            </Tooltip.Content>
          </Tooltip.Positioner>
        </Tooltip.Root>
      </Show>

      {/* Detail Panel */}
      <Show when={expandedItem()}>
        {(item) => (
          <Show
            when={item().kind === 'tool_pair'}
            fallback={
              <EventDetailPanel
                event={(item() as { kind: 'event'; event: ContextEvent }).event}
                onClose={handleClose}
              />
            }
          >
            <ToolPairDetail
              call={
                (item() as { kind: 'tool_pair'; call: ContextEvent; result?: ContextEvent }).call
              }
              result={
                (item() as { kind: 'tool_pair'; call: ContextEvent; result?: ContextEvent }).result
              }
              onClose={handleClose}
            />
          </Show>
        )}
      </Show>
    </div>
  )
}
