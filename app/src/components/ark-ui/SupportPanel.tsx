/**
 * Support Panel Component
 *
 * Tabbed interface for knowledge graph visualization and observability tools
 * Tabs: Neo4j | Memory | Context manager | Data | Terminal
 */

import { Tabs } from '@ark-ui/solid/tabs'
import { Show, createSignal, createMemo, createEffect, Suspense } from 'solid-js'
import type { OpenReferenceTarget } from '~/lib/harness-client'
import { GraphVisualization } from './GraphVisualization'
import { ObservabilityPanel } from './ObservabilityPanel'
import { DataStashPanel, type StashAction } from './DataStashPanel'
import { TerminalPanel } from './TerminalPanel'
import type { ElementDefinition, StylesheetJsonBlock } from 'cytoscape'
import type { ContextEvent, UnifiedContext } from '~/lib/harness-patterns'

/** Highlight nodes the agent's query actually touched (vs. surrounding context).
 *  The extractor sets `data.touched = true` on these — see `graph-extractor.ts`. */
const TOUCHED_NODE_STYLES: StylesheetJsonBlock[] = [
  {
    selector: 'node[touched]',
    style: {
      'background-color': '#ff00ff',
      'border-color': '#ff00ff',
      'border-width': 4,
      'overlay-color': '#ff00ff',
      'overlay-opacity': 0.3,
    },
  },
]

// ============================================================================
// Types
// ============================================================================

export interface PromptStat {
  functionName: string
  tokens: { input: number; output: number }
  latency: number
  timestamp: Date
  status: 'success' | 'error'
}

// Re-export GraphElement from shared types
export type { GraphElement } from '~/lib/harness-client/types'
import type { GraphElement } from '~/lib/harness-client/types'
import { isEdgeElement, isNodeElement } from '~/lib/harness-client/graph-extractor'

export interface SupportPanelProps {
  graphElements: GraphElement[]
  highlightedIds?: string[]
  promptStats?: PromptStat[]
  contextEvents?: ContextEvent[]
  unifiedContext?: UnifiedContext
  onNodeClick?: (nodeId: string, nodeData: Record<string, unknown>) => void
  onEdgeClick?: (edgeId: string, edgeData: Record<string, unknown>) => void
  onClearGraph?: () => void
  onClearEvents?: () => void
  /** Session ID for stash API calls */
  sessionId?: string
  /** The conversation's currently-selected agent — forwarded to the Data
   *  Stash and Terminal panels. */
  agentId?: string
  /** Callback for data stash actions (hide/unhide/archive/unarchive) */
  onStashAction?: (eventId: string, action: StashAction) => Promise<void>
  /** A citation clicked in the chat — switch to the Data Stash tab and open the
   *  inline viewer at this reference. */
  pendingReference?: OpenReferenceTarget | null
  /** Fired after a successful upload so the route can watch embedding status. */
  onUploaded?: () => void
}

// ============================================================================
// Component
// ============================================================================

export const SupportPanel = (props: SupportPanelProps) => {
  const [selectedTab, setSelectedTab] = createSignal('stats')

  // A chat citation was clicked → surface the Data Stash tab so its inline
  // viewer (opened by DataStashPanel from the same `pendingReference`) is visible.
  createEffect(() => {
    if (props.pendingReference) setSelectedTab('data')
  })

  // Filter graph elements by source
  const neo4jElements = createMemo(() =>
    props.graphElements.filter(
      (e) => e.source === 'neo4j' || !e.source, // Default to neo4j if source not specified
    ),
  )

  const memoryElements = createMemo(() => props.graphElements.filter((e) => e.source === 'memory'))

  return (
    <div flex="~ col" h="full" bg="ui-bg-primary">
      <Tabs.Root
        value={selectedTab()}
        onValueChange={(details) => setSelectedTab(details.value)}
        lazyMount
        unmountOnExit
        flex="~ col"
        h="full"
      >
        {/* Tab List */}
        <Tabs.List bg="ui-bg-secondary" border="b ui-border-primary" flex="~ wrap" p="x-2" gap="1">
          <Tabs.Trigger
            value="neo4j-graph"
            p="x-3 y-2"
            text="sm ui-text-primary"
            flex="~"
            items="center"
            gap="1"
            cursor="pointer"
            border="b-2 transparent"
            transition="all"
            data-state={selectedTab() === 'neo4j-graph' ? 'active' : 'inactive'}
            style={{
              'border-bottom-color':
                selectedTab() === 'neo4j-graph' ? 'var(--ui-accent)' : 'transparent',
              color:
                selectedTab() === 'neo4j-graph' ? 'var(--ui-accent)' : 'var(--ui-text-secondary)',
            }}
          >
            <span class="i-material-symbols-database-outline" w="4" h="4" aria-hidden="true" />
            Neo4j
          </Tabs.Trigger>

          <Tabs.Trigger
            value="memory-graph"
            p="x-3 y-2"
            text="sm ui-text-primary"
            flex="~"
            items="center"
            gap="1"
            cursor="pointer"
            border="b-2 transparent"
            transition="all"
            data-state={selectedTab() === 'memory-graph' ? 'active' : 'inactive'}
            style={{
              'border-bottom-color': selectedTab() === 'memory-graph' ? '#a855f7' : 'transparent',
              color: selectedTab() === 'memory-graph' ? '#a855f7' : 'var(--ui-text-secondary)',
            }}
          >
            <span class="i-material-symbols-psychology-outline" w="4" h="4" aria-hidden="true" />
            Memory
          </Tabs.Trigger>

          <Tabs.Trigger
            value="stats"
            p="x-3 y-2"
            text="sm ui-text-primary"
            cursor="pointer"
            border="b-2 transparent"
            transition="all"
            data-state={selectedTab() === 'stats' ? 'active' : 'inactive'}
            style={{
              'border-bottom-color': selectedTab() === 'stats' ? '#f59e0b' : 'transparent',
              color: selectedTab() === 'stats' ? '#f59e0b' : 'var(--ui-text-secondary)',
            }}
          >
            Context manager
          </Tabs.Trigger>

          <Tabs.Trigger
            value="data"
            p="x-3 y-2"
            text="sm ui-text-primary"
            cursor="pointer"
            border="b-2 transparent"
            transition="all"
            data-state={selectedTab() === 'data' ? 'active' : 'inactive'}
            style={{
              'border-bottom-color': selectedTab() === 'data' ? '#22d3ee' : 'transparent',
              color: selectedTab() === 'data' ? '#22d3ee' : 'var(--ui-text-secondary)',
            }}
          >
            Data
          </Tabs.Trigger>

          <Tabs.Trigger
            value="terminal"
            p="x-3 y-2"
            text="sm ui-text-primary"
            flex="~"
            items="center"
            gap="1"
            cursor="pointer"
            border="b-2 transparent"
            transition="all"
            data-state={selectedTab() === 'terminal' ? 'active' : 'inactive'}
            style={{
              'border-bottom-color': selectedTab() === 'terminal' ? '#10b981' : 'transparent',
              color: selectedTab() === 'terminal' ? '#10b981' : 'var(--ui-text-secondary)',
            }}
          >
            <span class="i-material-symbols-terminal" w="4" h="4" aria-hidden="true" />
            Terminal
          </Tabs.Trigger>
        </Tabs.List>

        {/* Tab Content */}
        <div flex="1" overflow="hidden">
          {/* Neo4j Graph Tab */}
          <Tabs.Content value="neo4j-graph" h="full" flex="~ col">
            <GraphTabContent
              elements={neo4jElements()}
              highlightedIds={props.highlightedIds}
              onNodeClick={props.onNodeClick}
              onEdgeClick={props.onEdgeClick}
              onClearGraph={props.onClearGraph}
              extraStyles={TOUCHED_NODE_STYLES}
              emptyMessage="No Neo4j graph data yet. Query your knowledge base to see results."
              emptyIconClass="i-material-symbols-database-outline"
            />
          </Tabs.Content>

          {/* Memory Graph Tab */}
          <Tabs.Content value="memory-graph" h="full" flex="~ col">
            <GraphTabContent
              elements={memoryElements()}
              highlightedIds={props.highlightedIds}
              onNodeClick={props.onNodeClick}
              onEdgeClick={props.onEdgeClick}
              onClearGraph={props.onClearGraph}
              emptyMessage="No memory graph data yet. Use agents that interact with the Memory MCP to see data."
              emptyIconClass="i-material-symbols-psychology-outline"
            />
          </Tabs.Content>

          {/* Context manager Tab - ContextEvents based */}
          <Tabs.Content value="stats" h="full">
            <ObservabilityPanel
              events={props.contextEvents ?? []}
              context={props.unifiedContext}
              onClear={props.onClearEvents}
            />
          </Tabs.Content>

          {/* Data Stash Tab. Local Suspense so the panel's resource load on
              (lazy) mount can't bubble to the empty-fallback root <Suspense>
              in app.tsx and flash the whole app white. */}
          <Tabs.Content value="data" h="full">
            <Suspense
              fallback={
                <div p="4" text="sm ui-text-tertiary">
                  Loading data…
                </div>
              }
            >
              <DataStashPanel
                events={props.contextEvents ?? []}
                sessionId={props.sessionId ?? ''}
                agentId={props.agentId}
                onStashAction={props.onStashAction ?? (async () => {})}
                pendingReference={props.pendingReference}
                onUploaded={props.onUploaded}
              />
            </Suspense>
          </Tabs.Content>

          {/* Terminal Tab — read-only feed + interactive shell (#79) */}
          <Tabs.Content value="terminal" h="full">
            <TerminalPanel
              events={props.contextEvents ?? []}
              sessionId={props.sessionId}
              agentId={props.agentId}
            />
          </Tabs.Content>
        </div>
      </Tabs.Root>
    </div>
  )
}

// ============================================================================
// Graph Tab Content Component
// ============================================================================

interface GraphTabContentProps {
  elements: ElementDefinition[]
  highlightedIds?: string[]
  onNodeClick?: (nodeId: string, nodeData: Record<string, unknown>) => void
  onEdgeClick?: (edgeId: string, edgeData: Record<string, unknown>) => void
  onClearGraph?: () => void
  emptyMessage: string
  /** Icon utility class for the empty state — see GraphVisualization. */
  emptyIconClass: string
  extraStyles?: StylesheetJsonBlock[]
}

const GraphTabContent = (props: GraphTabContentProps) => {
  const [syncEnabled, setSyncEnabled] = createSignal(true)
  const [frozenElements, setFrozenElements] = createSignal<ElementDefinition[]>([])

  const effectiveElements = () => (syncEnabled() ? props.elements : frozenElements())
  // See SA-M12: `data.kind` is the discriminator, not the presence of a
  // `source` key (which is also a legitimate node property).
  const nodeCount = () => effectiveElements().filter(isNodeElement).length
  const edgeCount = () => effectiveElements().filter(isEdgeElement).length

  /**
   * Clearing has to leave the freeze, not just empty the source. While sync is
   * paused the canvas renders `frozenElements`, so resetting only the
   * conversation's own list leaves the snapshot on screen — and puts it back on
   * the canvas the next time the element effect re-runs (it re-runs on tab
   * visibility, not just on new elements).
   *
   * Resuming sync is part of the same thought and not a convenience: this bar
   * is hidden while the tab has nothing to show, so a clear that left the view
   * paused would take the toggle away with it and strand the tab frozen on an
   * empty snapshot — no later element could bring either back.
   */
  const clearGraph = () => {
    setFrozenElements([])
    setSyncEnabled(true)
    props.onClearGraph?.()
  }

  const toggleSync = () => {
    if (syncEnabled()) {
      // Freezing: snapshot current elements
      setFrozenElements([...props.elements])
    }
    setSyncEnabled(!syncEnabled())
  }

  return (
    <>
      {/* Graph Controls Bar */}
      <Show when={effectiveElements().length > 0}>
        <div
          flex="~"
          items="center"
          justify="between"
          p="2 3"
          bg="ui-bg-tertiary"
          border="b ui-border-primary"
        >
          <div text="xs ui-text-secondary">
            {nodeCount()} nodes, {edgeCount()} edges
          </div>
          <div flex="~" items="center" gap="2">
            <button
              onClick={toggleSync}
              p="x-2 y-1"
              text={syncEnabled() ? 'xs cyan-400' : 'xs amber-400'}
              bg={
                syncEnabled() ? 'cyan-600/10 hover:cyan-600/20' : 'amber-600/10 hover:amber-600/20'
              }
              border={syncEnabled() ? '1 cyan-500/30' : '1 amber-500/30'}
              rounded="md"
              cursor="pointer"
              transition="all"
              flex="~"
              items="center"
              gap="1"
              title={
                syncEnabled()
                  ? 'Pause graph sync with conversation'
                  : 'Resume graph sync with conversation'
              }
              aria-label={syncEnabled() ? 'Pause graph sync' : 'Resume graph sync'}
            >
              <span
                class={syncEnabled() ? 'i-material-symbols-pause' : 'i-material-symbols-play-arrow'}
                w="3.5"
                h="3.5"
                aria-hidden="true"
              />
              Sync
            </button>
          </div>
        </div>
      </Show>

      {/* Graph — mounted even with nothing in it, so the manual Cypher box is
          reachable before any chat interaction has populated the graph (#237
          follow-up). GraphVisualization owns the empty state; the per-tab copy
          that used to live in a fallback here is passed into it. */}
      <div flex="1" overflow="hidden">
        <GraphVisualization
          elements={effectiveElements()}
          highlightedIds={props.highlightedIds}
          onNodeClick={props.onNodeClick}
          onEdgeClick={props.onEdgeClick}
          extraStyles={props.extraStyles}
          onClearGraph={props.onClearGraph ? clearGraph : undefined}
          emptyIconClass={props.emptyIconClass}
          emptyMessage={props.emptyMessage}
        />
      </div>
    </>
  )
}
