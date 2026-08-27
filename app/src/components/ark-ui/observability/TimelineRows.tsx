/**
 * Timeline rows — the two-lane grid: lane headers, the empty state, pattern
 * enter/exit dividers, a single-event row and a merged tool_call+tool_result
 * row. Split out of `ObservabilityPanel.tsx` (#226 B5).
 */

import { Show } from 'solid-js'
import type { ContextEvent, ToolCallEventData, ToolResultEventData } from '~/lib/harness-patterns'
import { eventColors, eventIconClasses, getPatternColor } from '~/lib/observability/event-styles'
import { getEventLane, getEventPreview } from '~/lib/observability/projection'
import { SanitizedChip } from '../SanitizedChip'

// ============================================================================
// Lane Headers Component
// ============================================================================

export const LaneHeaders = () => (
  <div
    flex="~"
    border="b ui-border-primary"
    bg="ui-bg-secondary"
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
      border="r ui-border-secondary"
    >
      <div w="2" h="2" rounded="full" bg="cyber-500" />
      <span text="xs ui-text-primary" font="medium">
        Interface
      </span>
    </div>

    {/* Tools Lane Header */}
    <div w="1/2" p="2" flex="~" items="center" justify="center" gap="2">
      <div w="2" h="2" rounded="full" bg="ui-accent" />
      <span text="xs ui-text-primary" font="medium">
        Tools
      </span>
    </div>
  </div>
)

// ============================================================================
// Empty State Component
// ============================================================================

export const EmptyState = () => (
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
    <div text="sm ui-text-secondary" m="t-3">
      No events yet
    </div>
    <div text="xs ui-text-tertiary" m="t-1">
      Send a message to see the timeline
    </div>
  </div>
)

// ============================================================================
// Pattern Enter/Exit Row (compact divider)
// ============================================================================

export const PatternBoundaryRow = (props: { event: ContextEvent }) => {
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
        class={isEnter ? 'i-material-symbols-play-arrow' : 'i-material-symbols-stop'}
        w="2.5"
        h="2.5"
        style={{ color: pc.color }}
        aria-hidden="true"
      />
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

export const EventRow = (props: {
  event: ContextEvent
  index: number
  expanded: boolean
  onExpand: () => void
  bgTint?: string
}) => {
  const { type, patternId, data } = props.event

  // Guard against malformed events (e.g. from SSE stream)
  if (!type) return null

  const iconClass = eventIconClasses[type]
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
      bg={props.expanded ? 'ui-bg-tertiary' : 'transparent hover:ui-bg-hover'}
      border={props.expanded ? '1 ui-accent/30' : 'none'}
      rounded="md"
      transition="all"
      onClick={props.onExpand}
      w="full"
    >
      {/* Icon */}
      <span class={iconClass} text="lg" style={{ color }} aria-hidden="true" />

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
        <div text="xs ui-text-tertiary" font="mono">
          {patternId}
        </div>
      </Show>

      {/* Preview */}
      <Show when={preview}>
        <div
          text="xs ui-text-secondary"
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
      border="b ui-border-secondary/30"
      style={{ 'background-color': props.bgTint ?? 'transparent' }}
    >
      {/* Interface Lane (left) */}
      <div w="1/2" flex="~" justify="center" items="center" border="r ui-border-secondary/30">
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
// Tool Pair Row Component (merged tool_call + tool_result)
// ============================================================================

export const ToolPairRow = (props: {
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
  // A guarded result is marked on the row itself, not only inside the detail
  // panel — otherwise the only way to learn a result was rewritten is to open
  // every one of them (SA-H10).
  const sanitized = () => resultData()?.sanitized

  return (
    <div
      flex="~"
      min-h="70px"
      border="b ui-border-secondary/30"
      style={{ 'background-color': props.bgTint ?? 'transparent' }}
    >
      {/* Interface Lane (left) - empty for tool pairs */}
      <div w="1/2" flex="~" justify="center" items="center" border="r ui-border-secondary/30" />

      {/* Tools Lane (right) */}
      <div w="1/2" flex="~" justify="center" items="center">
        <div
          flex="~ col"
          items="center"
          gap="1"
          p="2 3"
          cursor="pointer"
          bg={props.expanded ? 'ui-bg-tertiary' : 'transparent hover:ui-bg-hover'}
          border={props.expanded ? '1 ui-accent/30' : 'none'}
          rounded="md"
          transition="all"
          onClick={props.onExpand}
          w="full"
        >
          <span
            class="i-material-symbols-build-outline"
            text="lg"
            style={{ color: success() ? '#a78bfa' : '#ef4444' }}
            aria-hidden="true"
          />
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
            <div text="xs ui-text-tertiary" font="mono">
              {props.call.patternId}
            </div>
          </Show>
          <div
            text="xs ui-text-secondary"
            max-w="120px"
            overflow="hidden"
            style={{ 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}
          >
            {preview()}
          </div>
          <Show when={sanitized()}>
            {(summary) => <SanitizedChip summary={summary()} compact />}
          </Show>
        </div>
      </div>
    </div>
  )
}
