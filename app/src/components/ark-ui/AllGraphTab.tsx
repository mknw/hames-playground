/**
 * All Graph Tab — Turn-Based Graph Explorer
 *
 * Derives graph elements from contextEvents based on user-selected turns.
 * Features:
 * - FloatingPanel with per-turn columns (horizontal layout, vertical expansion)
 * - Multi-select turns via checkboxes
 * - Color-coded Cytoscape visualization per turn
 * - Turn color legend overlay
 */

import { createSignal, createMemo, For, Show } from 'solid-js'
import { FloatingPanel } from '@ark-ui/solid/floating-panel'
import { Tooltip } from '@ark-ui/solid/tooltip'
import type { StylesheetJsonBlock } from 'cytoscape'
import { GraphVisualization } from './GraphVisualization'
import type { ContextEvent } from '~/lib/harness-patterns'
import { splitIntoTurns, extractMultiTurnGraphElements, type TurnData } from '~/lib/turn-utils'
import { getTurnColor } from '~/lib/turn-colors'
import { SanitizedChip } from './SanitizedChip'
import type { GraphElement } from '~/lib/harness-client/types'
import { isEdgeElement, isNodeElement } from '~/lib/harness-client/graph-extractor'

// ============================================================================
// Types
// ============================================================================

/** FloatingPanel stage, mirrored from zag (no readable stage on the api). */
type PanelStage = 'default' | 'minimized' | 'maximized'

interface AllGraphTabProps {
  contextEvents: ContextEvent[]
  highlightedIds?: string[]
  onNodeClick?: (nodeId: string, nodeData: Record<string, unknown>) => void
  onEdgeClick?: (edgeId: string, edgeData: Record<string, unknown>) => void
  /** Injected by AllGraphTabWrapper (which owns FloatingPanel.Root) — drives
   *  which window controls the Turn Explorer header shows. */
  panelStage?: PanelStage
}

// ============================================================================
// Helpers
// ============================================================================

/** Short display name for a tool */
function toolDisplayName(tool: string): string {
  return tool.replace(/^(read_|write_|get_|create_|delete_|list_)/, '').replace(/_/g, ' ')
}

/** Truncate text with ellipsis */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + '...'
}

/** Extract user message preview from a turn */
function getUserMessagePreview(turn: TurnData): string {
  if (!turn.userMessage) return 'No message'
  const data = turn.userMessage.data as { content?: string }
  return truncate(data?.content ?? '', 40)
}

// ============================================================================
// Component
// ============================================================================

export const AllGraphTab = (props: AllGraphTabProps) => {
  const [selectedTurns, setSelectedTurns] = createSignal<Set<number>>(new Set())

  // Derive turns from context events
  const turns = createMemo(() => splitIntoTurns(props.contextEvents))

  // Only turns that have graph-producing tool results
  const turnsWithGraphData = createMemo(() => turns().filter((t) => t.graphToolResults.length > 0))

  // Derive graph elements from selected turns
  const graphElements = createMemo(() => {
    const selected = selectedTurns()
    if (selected.size === 0) return [] as GraphElement[]
    const selectedTurnData = turns().filter((t) => selected.has(t.turnNumber))
    return extractMultiTurnGraphElements(selectedTurnData)
  })

  // Generate per-turn Cytoscape styles
  const turnStyles = createMemo((): StylesheetJsonBlock[] => {
    const selected = selectedTurns()
    const styles: StylesheetJsonBlock[] = []
    for (const turnNum of selected) {
      const color = getTurnColor(turnNum)
      styles.push(
        {
          selector: `node[turn = ${turnNum}]`,
          style: {
            'background-color': color,
            'border-color': color,
          },
        } as StylesheetJsonBlock,
        {
          selector: `edge[turn = ${turnNum}]`,
          style: {
            'line-color': color,
            'target-arrow-color': color,
          },
        } as StylesheetJsonBlock,
      )
    }
    return styles
  })

  // Counts
  // Node/edge split comes from the extractor's explicit `data.kind` stamp, not
  // from guessing at a `source` key — a node property called `source` used to
  // be enough to have it counted as an edge (SA-M12).
  const nodeCount = createMemo(() => graphElements().filter(isNodeElement).length)
  const edgeCount = createMemo(() => graphElements().filter(isEdgeElement).length)

  // Turn selection handlers
  const toggleTurn = (turnNumber: number) => {
    setSelectedTurns((prev) => {
      const next = new Set(prev)
      if (next.has(turnNumber)) {
        next.delete(turnNumber)
      } else {
        next.add(turnNumber)
      }
      return next
    })
  }

  const selectAllTurns = () => {
    setSelectedTurns(new Set(turnsWithGraphData().map((t) => t.turnNumber)))
  }

  const clearSelection = () => {
    setSelectedTurns(new Set<number>())
  }

  // Sorted selected turn numbers for legend
  const selectedTurnNumbers = createMemo(() => [...selectedTurns()].sort((a, b) => a - b))

  return (
    <div flex="~ col" h="full" style={{ position: 'relative' }}>
      {/* Controls Bar */}
      <div
        flex="~"
        items="center"
        justify="between"
        p="2 3"
        bg="dark-bg-tertiary"
        border="b dark-border-primary"
      >
        <div text="xs dark-text-secondary">
          <Show when={graphElements().length > 0} fallback="No turns selected">
            {nodeCount()} nodes, {edgeCount()} edges{' '}
            <span text="dark-text-tertiary">
              ({selectedTurnNumbers().length} turn{selectedTurnNumbers().length !== 1 ? 's' : ''})
            </span>
          </Show>
        </div>
        <div flex="~" items="center" gap="2">
          {/* Turn Explorer trigger */}
          <FloatingPanel.Trigger
            p="x-2 y-1"
            text="xs green-400"
            bg="green-600/10 hover:green-600/20"
            border="1 green-500/30"
            rounded="md"
            cursor="pointer"
            transition="all"
            title="Open Turn Explorer"
            flex="~"
            items="center"
            gap="1"
          >
            <span
              class="i-material-symbols-layers-outline"
              style={{ width: '14px', height: '14px' }}
            />
            <span>Turns</span>
          </FloatingPanel.Trigger>

          <Show when={selectedTurns().size > 0}>
            <button
              onClick={clearSelection}
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
      </div>

      {/* Graph Area (position: relative for FloatingPanel + Legend) */}
      <div flex="1" overflow="hidden" style={{ position: 'relative' }}>
        <Show
          when={graphElements().length > 0}
          fallback={
            <div flex="~ col" items="center" justify="center" h="full" text="center">
              <span text="4xl mb-4">🕸️</span>
              <span text="sm dark-text-secondary" max-w="xs">
                <Show
                  when={turnsWithGraphData().length > 0}
                  fallback="No graph data yet. Interact with the agent to see results."
                >
                  Select turns from the Turn Explorer to visualize graph data.
                </Show>
              </span>
              <Show when={turnsWithGraphData().length > 0}>
                <span text="xs dark-text-tertiary" m="t-2">
                  Click <strong text="green-400">Turns</strong> above to open the Turn Explorer
                </span>
              </Show>
            </div>
          }
        >
          <GraphVisualization
            elements={graphElements()}
            highlightedIds={props.highlightedIds}
            onNodeClick={props.onNodeClick}
            onEdgeClick={props.onEdgeClick}
            extraStyles={turnStyles()}
          />
        </Show>

        {/* FloatingPanel overlay */}
        <FloatingPanel.Positioner>
          <FloatingPanel.Content
            bg="dark-bg-secondary/95"
            border="1 dark-border-primary"
            rounded="lg"
            shadow="lg"
            overflow="hidden"
            flex="~ col"
          >
            {/* Header with drag + All/None controls */}
            <FloatingPanel.Header
              flex="~"
              items="center"
              justify="between"
              p="2 3"
              bg="dark-bg-tertiary"
              border="b dark-border-primary"
              cursor="default"
            >
              <FloatingPanel.DragTrigger flex="1 ~" items="center" gap="2" cursor="grab">
                <span
                  class="i-material-symbols-drag-indicator"
                  style={{ width: '16px', height: '16px', color: '#71717a' }}
                />
                <span text="sm dark-text-primary" font="medium">
                  Turn Explorer
                </span>
              </FloatingPanel.DragTrigger>
              {/* Content actions — NOT window controls, so they live in a
                  plain div: FloatingPanel.Control is the slot for the stage/
                  close triggers below (canonical Ark anatomy). */}
              <div flex="~" items="center" gap="1" m="r-2">
                <Show when={turnsWithGraphData().length > 0}>
                  <button
                    onClick={selectAllTurns}
                    p="x-2 y-0.5"
                    text="2xs green-400"
                    bg="green-600/10 hover:green-600/20"
                    border="1 green-500/30"
                    rounded="sm"
                    cursor="pointer"
                  >
                    All
                  </button>
                  <button
                    onClick={clearSelection}
                    p="x-2 y-0.5"
                    text="2xs dark-text-tertiary"
                    bg="zinc-600/10 hover:zinc-600/20"
                    border="1 zinc-500/30"
                    rounded="sm"
                    cursor="pointer"
                  >
                    None
                  </button>
                </Show>
              </div>
              <FloatingPanel.Control flex="~" items="center" gap="0.5">
                <Show when={props.panelStage !== 'minimized'}>
                  <FloatingPanel.StageTrigger
                    stage="minimized"
                    p="1"
                    rounded="sm"
                    cursor="pointer"
                    bg="hover:dark-bg-primary"
                    text="dark-text-tertiary hover:dark-text-primary"
                    title="Minimize"
                  >
                    <span
                      class="i-material-symbols-minimize"
                      style={{ width: '14px', height: '14px', display: 'block' }}
                    />
                  </FloatingPanel.StageTrigger>
                </Show>
                <Show when={props.panelStage !== 'maximized'}>
                  <FloatingPanel.StageTrigger
                    stage="maximized"
                    p="1"
                    rounded="sm"
                    cursor="pointer"
                    bg="hover:dark-bg-primary"
                    text="dark-text-tertiary hover:dark-text-primary"
                    title="Maximize (fills the graph area)"
                  >
                    <span
                      class="i-material-symbols-fullscreen"
                      style={{ width: '14px', height: '14px', display: 'block' }}
                    />
                  </FloatingPanel.StageTrigger>
                </Show>
                <Show when={props.panelStage !== 'default' && props.panelStage !== undefined}>
                  <FloatingPanel.StageTrigger
                    stage="default"
                    p="1"
                    rounded="sm"
                    cursor="pointer"
                    bg="hover:dark-bg-primary"
                    text="dark-text-tertiary hover:dark-text-primary"
                    title="Restore"
                  >
                    <span
                      class={
                        props.panelStage === 'maximized'
                          ? 'i-material-symbols-fullscreen-exit'
                          : 'i-material-symbols-expand-content'
                      }
                      style={{ width: '14px', height: '14px', display: 'block' }}
                    />
                  </FloatingPanel.StageTrigger>
                </Show>
                <FloatingPanel.CloseTrigger
                  p="1"
                  rounded="sm"
                  cursor="pointer"
                  bg="hover:dark-bg-primary"
                  text="dark-text-tertiary hover:dark-text-primary"
                  title="Close"
                >
                  <span
                    class="i-material-symbols-close"
                    style={{ width: '14px', height: '14px', display: 'block' }}
                  />
                </FloatingPanel.CloseTrigger>
              </FloatingPanel.Control>
            </FloatingPanel.Header>

            {/* Body: horizontal flex of turn columns */}
            <FloatingPanel.Body flex="1" overflow="auto" p="2">
              <Show
                when={turnsWithGraphData().length > 0}
                fallback={
                  <div flex="~" items="center" justify="center" h="full" p="4">
                    <span text="xs dark-text-tertiary">No graph data in any turn yet</span>
                  </div>
                }
              >
                <div
                  flex="~"
                  gap="2"
                  overflow="x-auto"
                  min-h="0"
                  style={{ 'align-items': 'flex-start' }}
                >
                  <For each={turnsWithGraphData()}>
                    {(turn) => (
                      <TurnColumn
                        turn={turn}
                        selected={selectedTurns().has(turn.turnNumber)}
                        onToggle={() => toggleTurn(turn.turnNumber)}
                      />
                    )}
                  </For>
                </div>
              </Show>
            </FloatingPanel.Body>

            {/* Resize handle (bottom-right) — hidden while minimized (the
                panel is header-height, the handle would overlap it) or
                maximized (size is stage-managed). */}
            <Show when={(props.panelStage ?? 'default') === 'default'}>
              <FloatingPanel.ResizeTrigger
                axis="se"
                style={{
                  position: 'absolute',
                  bottom: '0',
                  right: '0',
                  width: '14px',
                  height: '14px',
                  cursor: 'se-resize',
                }}
              >
                <span
                  style={{
                    display: 'block',
                    width: '8px',
                    height: '8px',
                    'border-right': '2px solid #52525b',
                    'border-bottom': '2px solid #52525b',
                    margin: '3px 0 0 3px',
                  }}
                />
              </FloatingPanel.ResizeTrigger>
            </Show>
          </FloatingPanel.Content>
        </FloatingPanel.Positioner>

        {/* Turn Color Legend */}
        <Show when={selectedTurnNumbers().length > 0}>
          <div
            style={{
              position: 'absolute',
              bottom: '12px',
              right: '12px',
              'z-index': '20',
              'pointer-events': 'none',
            }}
            bg="dark-bg-secondary/90"
            border="1 dark-border-primary"
            rounded="lg"
            p="2 3"
          >
            <div text="2xs dark-text-tertiary" m="b-1" font="medium">
              Turns
            </div>
            <For each={selectedTurnNumbers()}>
              {(n) => (
                <div flex="~" items="center" gap="2" m="y-0.5">
                  <span
                    style={{
                      width: '8px',
                      height: '8px',
                      'border-radius': '50%',
                      background: getTurnColor(n),
                      'flex-shrink': '0',
                    }}
                  />
                  <span text="2xs dark-text-secondary">Turn {n}</span>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  )
}

// ============================================================================
// Turn Column Component
// ============================================================================

interface TurnColumnProps {
  turn: TurnData
  selected: boolean
  onToggle: () => void
}

const TurnColumn = (props: TurnColumnProps) => {
  const color = () => getTurnColor(props.turn.turnNumber)
  const resultCount = () => props.turn.graphToolResults.length

  return (
    <div
      flex="~ col"
      min-w="[140px]"
      max-w="[200px]"
      border="1"
      rounded="lg"
      overflow="hidden"
      transition="all"
      style={{
        'border-color': props.selected ? color() + '60' : '#27272a',
        background: props.selected ? color() + '08' : 'transparent',
        'flex-shrink': '0',
      }}
    >
      {/* Turn Header */}
      <div
        flex="~"
        items="center"
        gap="1.5"
        p="2"
        bg="dark-bg-tertiary/50"
        border="b dark-border-primary"
        cursor="pointer"
        onClick={() => props.onToggle()}
        transition="all"
      >
        {/* Color swatch */}
        <span
          style={{
            width: '10px',
            height: '10px',
            'border-radius': '3px',
            background: color(),
            opacity: props.selected ? '1' : '0.4',
            'flex-shrink': '0',
            border: props.selected ? `2px solid ${color()}` : '2px solid transparent',
          }}
        />
        {/* Turn label */}
        <div flex="~ col" min-w="0">
          <span text="xs" font="medium" style={{ color: props.selected ? color() : '#a1a1aa' }}>
            Turn {props.turn.turnNumber}
          </span>
          <span
            text="2xs dark-text-tertiary"
            style={{ overflow: 'hidden', 'text-overflow': 'ellipsis', 'white-space': 'nowrap' }}
          >
            {getUserMessagePreview(props.turn)}
          </span>
        </div>
        {/* Result count badge */}
        <span
          text="2xs"
          p="x-1"
          rounded="full"
          style={{
            'margin-left': 'auto',
            background: props.selected ? color() + '20' : '#27272a',
            color: props.selected ? color() : '#71717a',
            'flex-shrink': '0',
          }}
        >
          {resultCount()}
        </span>
      </div>

      {/* Tool results list */}
      <div flex="~ col" p="1" gap="0.5">
        <For each={props.turn.graphToolResults}>
          {(item) => (
            <Tooltip.Root openDelay={300} closeDelay={100}>
              <Tooltip.Trigger
                flex="~"
                items="center"
                gap="1"
                p="1 1.5"
                rounded="md"
                text="2xs dark-text-secondary"
                bg="hover:dark-bg-tertiary/50"
                transition="all"
                cursor="default"
                style={{ opacity: props.selected ? '1' : '0.5' }}
              >
                <span
                  style={{
                    width: '4px',
                    height: '4px',
                    'border-radius': '50%',
                    background: item.data.success ? color() : '#ef4444',
                    'flex-shrink': '0',
                  }}
                />
                <span
                  style={{
                    overflow: 'hidden',
                    'text-overflow': 'ellipsis',
                    'white-space': 'nowrap',
                  }}
                >
                  {toolDisplayName(item.data.tool)}
                </span>
              </Tooltip.Trigger>
              <Tooltip.Positioner>
                <Tooltip.Content
                  bg="dark-bg-primary"
                  border="1 dark-border-primary"
                  rounded="md"
                  p="2"
                  shadow="lg"
                  max-w="[280px]"
                  style={{ 'z-index': '200' }}
                >
                  <div text="2xs dark-text-tertiary" font="mono" m="b-1">
                    {item.data.tool}
                  </div>
                  <Show when={item.data.summary}>
                    <div text="xs dark-text-secondary">{item.data.summary}</div>
                  </Show>
                  <Show when={!item.data.summary}>
                    <div text="xs dark-text-tertiary" font="italic">
                      {truncate(JSON.stringify(item.data.result), 200)}
                    </div>
                  </Show>
                  {/* Whatever is shown above is post-guard text (SA-H10). */}
                  <Show when={item.data.sanitized}>
                    {(summary) => (
                      <div m="t-1">
                        <SanitizedChip summary={summary()} compact />
                      </div>
                    )}
                  </Show>
                </Tooltip.Content>
              </Tooltip.Positioner>
            </Tooltip.Root>
          )}
        </For>
      </div>
    </div>
  )
}

// ============================================================================
// Wrapper — provides FloatingPanel.Root context
// ============================================================================

export const AllGraphTabWrapper = (props: AllGraphTabProps) => {
  // Current panel stage, fed by onStageChange (the zag api exposes no
  // readable stage). Passed down so the header can hide/show the
  // minimize/maximize/restore triggers.
  const [stage, setStage] = createSignal<PanelStage>('default')
  return (
    <FloatingPanel.Root
      strategy="absolute"
      defaultSize={{ width: 480, height: 340 }}
      minSize={{ width: 280, height: 200 }}
      persistRect
      draggable
      resizable
      closeOnEscape
      onStageChange={(d) => setStage(d.stage)}
    >
      <AllGraphTab {...props} panelStage={stage()} />
    </FloatingPanel.Root>
  )
}
