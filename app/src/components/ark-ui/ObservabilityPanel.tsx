/**
 * ObservabilityPanel Component
 *
 * Displays ContextEvents in a timeline format with expandable detail panels.
 * Events are displayed chronologically from top (oldest) to bottom (newest).
 * Pattern enter/exit rows are compact dividers; events within a pattern
 * are tinted with the pattern's colour from pattern-colors.json.
 *
 * This file is the composition root only. The pure projections live in
 * `~/lib/observability/` and the rows, overlays and summary bar in
 * `./observability/` (#226 B5).
 */

import { For, Show, createSignal, createMemo } from 'solid-js'
import { Tooltip } from '@ark-ui/solid/tooltip'
import type { ContextEvent, UnifiedContext } from '~/lib/harness-patterns'
import { getPatternColor } from '~/lib/observability/event-styles'
import { buildTimelineItems } from '~/lib/observability/projection'
import { SummaryBar } from './observability/SummaryBar'
import {
  EmptyState,
  EventRow,
  LaneHeaders,
  PatternBoundaryRow,
  ToolPairRow,
} from './observability/TimelineRows'
import { EventDetailPanel, ToolPairDetail } from './observability/EventDetail'

interface ObservabilityPanelProps {
  events: ContextEvent[]
  context?: UnifiedContext
  onClear?: () => void
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

  /**
   * Open the detail panel for an event by id — the shield chip's click-through
   * from a neutralized `tool_result` to the `content_sanitized` event holding
   * the verbatim spans (SA-H10).
   *
   * The two are never merged into one timeline item (`content_sanitized` is
   * emitted before the `tool_result` it annotates, so `buildTimelineItems`
   * pairs it with nothing), which is exactly why the link has to be explicit.
   * A missing id leaves the current panel open rather than closing it — the
   * audit event can be outside the window the panel was handed.
   */
  const handleJumpToEvent = (eventId: string) => {
    const idx = timelineItems().findIndex(
      (item) => item.kind === 'event' && item.event.id === eventId,
    )
    if (idx >= 0) setExpandedIndex(idx)
  }

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
                onJumpToEvent={handleJumpToEvent}
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
              onJumpToEvent={handleJumpToEvent}
            />
          </Show>
        )}
      </Show>
    </div>
  )
}
