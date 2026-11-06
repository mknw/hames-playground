/**
 * Timeline rows — the three-lane grid: lane headers, the empty state, pattern
 * enter/exit dividers, a single-event row and a merged tool_call+tool_result
 * row. Split out of `ObservabilityPanel.tsx` (#226 B5). The third lane,
 * Guardrails, holds every event `isGuardEvent` claims and a guarded result's
 * chip, so a guard that acted is seen as a guard (#795).
 */

import { For, Show, createSignal } from 'solid-js'
import type { JSX } from 'solid-js'
import type {
  ContextEvent,
  DecisionMadeEventData,
  ToolCallEventData,
  ToolResultEventData,
} from '@hames-ai/harness-patterns'
import { Collapsible } from '@ark-ui/solid/collapsible'
import { eventColors, eventIconClasses, getPatternColor } from '~/lib/observability/event-styles'
import {
  getEventLane,
  getEventPreview,
  isGuardEvent,
  type TimelineItem,
  type TimelineSection,
} from '@hames-ai/harness-patterns/observability/projection'
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
      w="1/3"
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
    <div
      w="1/3"
      p="2"
      flex="~"
      items="center"
      justify="center"
      gap="2"
      border="r ui-border-secondary"
    >
      <div w="2" h="2" rounded="full" bg="ui-accent" />
      <span text="xs ui-text-primary" font="medium">
        Tools
      </span>
    </div>

    {/* Guardrails Lane Header — the orange the timeline spends on a guard firing */}
    <div w="1/3" p="2" flex="~" items="center" justify="center" gap="2">
      <div w="2" h="2" rounded="full" bg="[var(--ui-evt-content-sanitized)]" />
      <span text="xs ui-text-primary" font="medium">
        Guardrails
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
      // #1008 round 2: pc.color is now a var(), so the old hex-suffix alpha
      // (`${pc.color}40`) cannot be used — color-mix resolves the var and
      // fades it the same way.
      style={{
        'background-color': pc.tint,
        'border-top': isEnter
          ? `1px solid color-mix(in srgb, ${pc.color} 25%, transparent)`
          : 'none',
        'border-bottom': !isEnter
          ? `1px solid color-mix(in srgb, ${pc.color} 25%, transparent)`
          : 'none',
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
      {/* Not in the pattern colour: a 60%-alpha tint of it was the one
          timeline label that could not clear 4.5:1 on a light ground, and
          the word is decorative direction, not identity (#1008 round 2). */}
      <span
        style={{
          color: 'var(--ui-text-tertiary)',
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
  const lane = isGuardEvent(type, data) ? 'guards' : getEventLane(type)
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

      <Show when={type === 'decision_made'}>
        <span
          text="xs ui-accent"
          bg="ui-accent/10"
          p="x-1.5 y-0.5"
          rounded="sm"
          font="mono"
          data-role="decision-type"
        >
          {(data as DecisionMadeEventData).type ?? 'choice'}
        </span>
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
      <div w="1/3" flex="~" justify="center" items="center" border="r ui-border-secondary/30">
        <Show when={lane === 'interface'}>
          <NodeContent />
        </Show>
      </div>

      {/* Tools Lane (middle) */}
      <div w="1/3" flex="~" justify="center" items="center" border="r ui-border-secondary/30">
        <Show when={lane === 'tools'}>
          <NodeContent />
        </Show>
      </div>

      {/* Guardrails Lane (right) */}
      <div w="1/3" flex="~" justify="center" items="center">
        <Show when={lane === 'guards'}>
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
  result: ContextEvent
  index: number
  expanded: boolean
  onExpand: () => void
  bgTint?: string
}) => {
  const callData = () => props.call.data as ToolCallEventData
  const resultData = () => props.result.data as ToolResultEventData
  const success = () => resultData().success
  const preview = () => `${callData().tool}: ${success() ? 'ok' : 'error'}`
  // A guarded result is marked on the row itself, not only inside the detail
  // panel — otherwise the only way to learn a result was rewritten is to open
  // every one of them (SA-H10).
  const sanitized = () => resultData().sanitized
  // The same theme-aware pair an unmerged tool_call / error row uses, so this
  // label clears AA in both themes too (#1008 round 2).
  const color = () => (success() ? eventColors.tool_call : eventColors.error)

  return (
    <div
      flex="~"
      min-h="70px"
      border="b ui-border-secondary/30"
      style={{ 'background-color': props.bgTint ?? 'transparent' }}
    >
      {/* Interface Lane (left) - empty for tool pairs */}
      <div w="1/3" flex="~" justify="center" items="center" border="r ui-border-secondary/30" />

      {/* Tools Lane (middle) */}
      <div w="1/3" flex="~" justify="center" items="center" border="r ui-border-secondary/30">
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
            style={{ color: color() }}
            aria-hidden="true"
          />
          <div
            style={{
              color: color(),
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
        </div>
      </div>

      {/* Guardrails Lane (right) - the guard's mark on this result (SA-H10) */}
      <div w="1/3" flex="~" justify="center" items="center">
        <Show when={sanitized()}>{(summary) => <SanitizedChip summary={summary()} compact />}</Show>
      </div>
    </div>
  )
}

// ============================================================================
// Controller Section (#1007) — one collapsible per controller run
// ============================================================================

/**
 * One controller run, collapsed by default: the loop's actions, tool calls and
 * results fold behind a single header that names the run, counts what it did
 * and flags a failure. Display-only grouping — the rows inside are the same
 * EventRow/ToolPairRow the flat timeline renders, at their own timeline index,
 * so opening one still drives the shared detail panel.
 */
export const ControllerSection = (props: {
  section: Extract<TimelineSection, { kind: 'controller' }>
  /** The item's index in the flat timeline — the detail panel's address. */
  indexOf: (item: TimelineItem) => number
  /** The panel's own row factory, so grouped rows stay identical rows. */
  renderItem: (item: TimelineItem, index: number) => JSX.Element
}) => {
  const [open, setOpen] = createSignal(false)

  // The collapsed header's one line: what the run did and whether anything
  // failed — a failed tool result, or a recovery (the loop's own error round).
  const actions = () =>
    props.section.items.filter(
      (item) => item.kind === 'event' && item.event.type === 'controller_action',
    ).length
  const toolCalls = () =>
    props.section.items.filter(
      (item) =>
        item.kind === 'tool_pair' || (item.kind === 'event' && item.event.type === 'tool_call'),
    ).length
  const failed = () =>
    props.section.items.some((item) => {
      if (item.kind === 'tool_pair') {
        return (item.result.data as ToolResultEventData).success === false
      }
      if (item.kind !== 'event') return false
      return (
        item.event.type === 'loop_recovery' ||
        (item.event.type === 'tool_result' &&
          (item.event.data as ToolResultEventData).success === false)
      )
    })

  return (
    <Collapsible.Root open={open()} onOpenChange={(details) => setOpen(details.open)}>
      <Collapsible.Trigger
        w="full"
        flex="~ items-center"
        gap="2"
        p="x-3 y-1.5"
        bg="ui-bg-secondary hover:ui-bg-tertiary"
        border="b ui-border-secondary/30"
        cursor="pointer"
        text="left"
        transition="colors"
        ring="2 transparent focus:ui-accent/40"
      >
        <Collapsible.Indicator>
          <span
            class={open() ? 'i-material-symbols-expand-more' : 'i-material-symbols-chevron-right'}
            w="4"
            h="4"
            text="ui-text-tertiary"
            aria-hidden="true"
          />
        </Collapsible.Indicator>
        <span
          class="i-material-symbols-adjust"
          w="4"
          h="4"
          style={{ color: eventColors.controller_action }}
          aria-hidden="true"
        />
        <span text="xs ui-text-primary" font="medium">
          controller
        </span>
        <Show when={props.section.patternId !== 'harness'}>
          <span text="xs ui-text-tertiary" font="mono">
            {props.section.patternId}
          </span>
        </Show>
        <span text="xs ui-text-secondary" font="mono" flex="1">
          {actions()} action{actions() === 1 ? '' : 's'} · {toolCalls()} tool call
          {toolCalls() === 1 ? '' : 's'}
        </span>
        <Show when={failed()}>
          <span text="xs ui-danger" font="mono">
            error
          </span>
        </Show>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <For each={props.section.items}>
          {(item) => props.renderItem(item, props.indexOf(item))}
        </For>
      </Collapsible.Content>
    </Collapsible.Root>
  )
}
