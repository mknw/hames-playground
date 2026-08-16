/**
 * Support Panel Component
 *
 * Tabbed interface for knowledge graph visualization and observability tools
 * Tabs: Neo4j Graph | Memory Graph | All (Turn Explorer) | Context manager | Data | Actions | Documents | Tools
 */

import { Tabs } from '@ark-ui/solid/tabs';
import { Show, createSignal, createMemo, createEffect, Suspense } from 'solid-js';
import type { OpenReferenceTarget } from '~/lib/harness-client';
import { GraphVisualization } from './GraphVisualization';
import { ObservabilityPanel } from './ObservabilityPanel';
import { DataStashPanel, type StashAction } from './DataStashPanel';
import { ToolsPanel } from './ToolsPanel';
import { TerminalPanel } from './TerminalPanel';
import { AllGraphTabWrapper } from './AllGraphTab';
import type { ElementDefinition, StylesheetJsonBlock } from 'cytoscape';
import type { ContextEvent, UnifiedContext } from '~/lib/harness-patterns';

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
];

// ============================================================================
// Types
// ============================================================================

export interface PromptStat {
  functionName: string;
  tokens: { input: number; output: number };
  latency: number;
  timestamp: Date;
  status: 'success' | 'error';
}

// Re-export GraphElement from shared types
export type { GraphElement } from '~/lib/harness-client/types'
import type { GraphElement } from '~/lib/harness-client/types'

export interface SupportPanelProps {
  graphElements: GraphElement[];
  highlightedIds?: string[];
  promptStats?: PromptStat[];
  contextEvents?: ContextEvent[];
  unifiedContext?: UnifiedContext;
  onNodeClick?: (nodeId: string, nodeData: Record<string, unknown>) => void;
  onEdgeClick?: (edgeId: string, edgeData: Record<string, unknown>) => void;
  onClearGraph?: () => void;
  onClearEvents?: () => void;
  /** Callback for Cypher write operations (node edits, relation creation) */
  onCypherWrite?: (cypher: string, params?: Record<string, unknown>) => Promise<void>;
  /** Session ID for stash API calls */
  sessionId?: string;
  /** The conversation's currently-selected agent — forwarded to the Tools
   *  panel so its code-mode gate tracks the live selection. */
  agentId?: string;
  /** Callback for data stash actions (hide/unhide/archive/unarchive) */
  onStashAction?: (eventId: string, action: StashAction) => Promise<void>;
  /** A citation clicked in the chat — switch to the Data Stash tab and open the
   *  inline viewer at this reference. */
  pendingReference?: OpenReferenceTarget | null;
  /** Fired after a successful upload so the route can watch embedding status. */
  onUploaded?: () => void;
}

// ============================================================================
// Component
// ============================================================================

export const SupportPanel = (props: SupportPanelProps) => {
  const [selectedTab, setSelectedTab] = createSignal('stats');

  // A chat citation was clicked → surface the Data Stash tab so its inline
  // viewer (opened by DataStashPanel from the same `pendingReference`) is visible.
  createEffect(() => {
    if (props.pendingReference) setSelectedTab('data');
  });

  // Filter graph elements by source
  const neo4jElements = createMemo(() =>
    props.graphElements.filter(e =>
      e.source === 'neo4j' || !e.source // Default to neo4j if source not specified
    )
  );

  const memoryElements = createMemo(() =>
    props.graphElements.filter(e => e.source === 'memory')
  );

  return (
    <div flex="~ col" h="full" bg="dark-bg-primary">
      <Tabs.Root
        value={selectedTab()}
        onValueChange={(details) => setSelectedTab(details.value)}
        lazyMount
        unmountOnExit
        flex="~ col"
        h="full"
      >
        {/* Tab List */}
        <Tabs.List
          bg="dark-bg-secondary"
          border="b dark-border-primary"
          flex="~ wrap"
          p="x-2"
          gap="1"
        >
          <Tabs.Trigger
            value="neo4j-graph"
            p="x-3 y-2"
            text="sm dark-text-primary"
            cursor="pointer"
            border="b-2 transparent"
            transition="all"
            data-state={selectedTab() === 'neo4j-graph' ? 'active' : 'inactive'}
            style={{
              "border-bottom-color": selectedTab() === 'neo4j-graph' ? '#00ffff' : 'transparent',
              "color": selectedTab() === 'neo4j-graph' ? '#00ffff' : '#a1a1aa'
            }}
          >
            <span mr="1">🗄️</span>
            Neo4j
          </Tabs.Trigger>

          <Tabs.Trigger
            value="memory-graph"
            p="x-3 y-2"
            text="sm dark-text-primary"
            cursor="pointer"
            border="b-2 transparent"
            transition="all"
            data-state={selectedTab() === 'memory-graph' ? 'active' : 'inactive'}
            style={{
              "border-bottom-color": selectedTab() === 'memory-graph' ? '#a855f7' : 'transparent',
              "color": selectedTab() === 'memory-graph' ? '#a855f7' : '#a1a1aa'
            }}
          >
            <span mr="1">🧠</span>
            Memory
          </Tabs.Trigger>

          <Tabs.Trigger
            value="all-graph"
            p="x-3 y-2"
            text="sm dark-text-primary"
            cursor="pointer"
            border="b-2 transparent"
            transition="all"
            data-state={selectedTab() === 'all-graph' ? 'active' : 'inactive'}
            style={{
              "border-bottom-color": selectedTab() === 'all-graph' ? '#22c55e' : 'transparent',
              "color": selectedTab() === 'all-graph' ? '#22c55e' : '#a1a1aa'
            }}
          >
            <span mr="1">🕸️</span>
            All
          </Tabs.Trigger>

          <Tabs.Trigger
            value="stats"
            p="x-3 y-2"
            text="sm dark-text-primary"
            cursor="pointer"
            border="b-2 transparent"
            transition="all"
            data-state={selectedTab() === 'stats' ? 'active' : 'inactive'}
            style={{
              "border-bottom-color": selectedTab() === 'stats' ? '#f59e0b' : 'transparent',
              "color": selectedTab() === 'stats' ? '#f59e0b' : '#a1a1aa'
            }}
          >
            Context manager
          </Tabs.Trigger>

          <Tabs.Trigger
            value="data"
            p="x-3 y-2"
            text="sm dark-text-primary"
            cursor="pointer"
            border="b-2 transparent"
            transition="all"
            data-state={selectedTab() === 'data' ? 'active' : 'inactive'}
            style={{
              "border-bottom-color": selectedTab() === 'data' ? '#22d3ee' : 'transparent',
              "color": selectedTab() === 'data' ? '#22d3ee' : '#a1a1aa'
            }}
          >
            Data
          </Tabs.Trigger>

          <Tabs.Trigger
            value="tools"
            p="x-3 y-2"
            text="sm dark-text-primary"
            cursor="pointer"
            border="b-2 transparent"
            transition="all"
            data-state={selectedTab() === 'tools' ? 'active' : 'inactive'}
            style={{
              "border-bottom-color": selectedTab() === 'tools' ? '#ff6600' : 'transparent',
              "color": selectedTab() === 'tools' ? '#ff6600' : '#a1a1aa'
            }}
          >
            Tools
          </Tabs.Trigger>

          <Tabs.Trigger
            value="terminal"
            p="x-3 y-2"
            text="sm dark-text-primary"
            cursor="pointer"
            border="b-2 transparent"
            transition="all"
            data-state={selectedTab() === 'terminal' ? 'active' : 'inactive'}
            style={{
              "border-bottom-color": selectedTab() === 'terminal' ? '#10b981' : 'transparent',
              "color": selectedTab() === 'terminal' ? '#10b981' : '#a1a1aa'
            }}
          >
            <span mr="1">🖥️</span>
            Terminal
          </Tabs.Trigger>

          <Tabs.Trigger
            value="actions"
            p="x-3 y-2"
            text="sm dark-text-tertiary"
            cursor="not-allowed"
            opacity="50"
            disabled
          >
            Actions
          </Tabs.Trigger>

          <Tabs.Trigger
            value="docs"
            p="x-3 y-2"
            text="sm dark-text-tertiary"
            cursor="not-allowed"
            opacity="50"
            disabled
          >
            Documents
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
              onCypherWrite={props.onCypherWrite}
              extraStyles={TOUCHED_NODE_STYLES}
              emptyMessage="No Neo4j graph data yet. Query your knowledge base to see results."
              emptyIcon="🗄️"
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
              emptyIcon="🧠"
            />
          </Tabs.Content>

          {/* All Graphs Tab — Turn-based explorer */}
          <Tabs.Content value="all-graph" h="full" flex="~ col">
            <AllGraphTabWrapper
              contextEvents={props.contextEvents ?? []}
              highlightedIds={props.highlightedIds}
              onNodeClick={props.onNodeClick}
              onEdgeClick={props.onEdgeClick}
              onCypherWrite={props.onCypherWrite}
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
            <Suspense fallback={<div p="4" text="sm dark-text-tertiary">Loading data…</div>}>
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

          {/* Tools Tab. Same local-Suspense guard (belt-and-braces with the
              panel's own internal boundary) against the tab-mount white flash. */}
          <Tabs.Content value="tools" h="full">
            <Suspense fallback={<div p="4" text="sm dark-text-tertiary">Loading tools…</div>}>
              <ToolsPanel sessionId={props.sessionId} agentId={props.agentId} />
            </Suspense>
          </Tabs.Content>

          {/* Terminal Tab — read-only feed + interactive shell (#79) */}
          <Tabs.Content value="terminal" h="full">
            <TerminalPanel events={props.contextEvents ?? []} sessionId={props.sessionId} agentId={props.agentId} />
          </Tabs.Content>

          {/* Actions Tab (Future) */}
          <Tabs.Content value="actions" h="full">
            <PlaceholderPanel
              icon="M13 10V3L4 14h7v7l9-11h-7z"
              title="Actions Panel"
              description="Context-based action suggestions, n8n workflow triggers, and file operations"
              phase="Phase 6"
            />
          </Tabs.Content>

          {/* Documents Tab (Future) */}
          <Tabs.Content value="docs" h="full">
            <PlaceholderPanel
              icon="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z"
              title="Document Panel"
              description="File uploads, Google Drive integration, and context management"
              phase="Phase 7"
            />
          </Tabs.Content>
        </div>
      </Tabs.Root>
    </div>
  );
};

// ============================================================================
// Graph Tab Content Component
// ============================================================================

interface GraphTabContentProps {
  elements: ElementDefinition[];
  highlightedIds?: string[];
  onNodeClick?: (nodeId: string, nodeData: Record<string, unknown>) => void;
  onEdgeClick?: (edgeId: string, edgeData: Record<string, unknown>) => void;
  onClearGraph?: () => void;
  onCypherWrite?: (cypher: string, params?: Record<string, unknown>) => Promise<void>;
  emptyMessage: string;
  emptyIcon: string;
  extraStyles?: StylesheetJsonBlock[];
}

const GraphTabContent = (props: GraphTabContentProps) => {
  const [syncEnabled, setSyncEnabled] = createSignal(true);
  const [frozenElements, setFrozenElements] = createSignal<ElementDefinition[]>([]);

  const effectiveElements = () => syncEnabled() ? props.elements : frozenElements();
  const nodeCount = () => effectiveElements().filter(e => !e.data?.source).length;
  const edgeCount = () => effectiveElements().filter(e => e.data?.source).length;

  const toggleSync = () => {
    if (syncEnabled()) {
      // Freezing: snapshot current elements
      setFrozenElements([...props.elements]);
    }
    setSyncEnabled(!syncEnabled());
  };

  return (
    <>
      {/* Graph Controls Bar */}
      <Show when={effectiveElements().length > 0}>
        <div
          flex="~"
          items="center"
          justify="between"
          p="2 3"
          bg="dark-bg-tertiary"
          border="b dark-border-primary"
        >
          <div text="xs dark-text-secondary">
            {nodeCount()} nodes, {edgeCount()} edges
          </div>
          <div flex="~" items="center" gap="2">
            <button
              onClick={toggleSync}
              p="x-2 y-1"
              text={syncEnabled() ? "xs cyan-400" : "xs amber-400"}
              bg={syncEnabled() ? "cyan-600/10 hover:cyan-600/20" : "amber-600/10 hover:amber-600/20"}
              border={syncEnabled() ? "1 cyan-500/30" : "1 amber-500/30"}
              rounded="md"
              cursor="pointer"
              transition="all"
              title={syncEnabled() ? "Pause graph sync with conversation" : "Resume graph sync with conversation"}
            >
              {syncEnabled() ? '⏸ Sync' : '▶ Sync'}
            </button>
            <button
              onClick={() => props.onClearGraph?.()}
              p="x-2 y-1"
              text="xs red-400"
              bg="red-600/10 hover:red-600/20"
              border="1 red-500/30"
              rounded="md"
              cursor="pointer"
              transition="all"
            >
              Clear Graph
            </button>
          </div>
        </div>
      </Show>

      {/* Graph or Empty State */}
      <div flex="1" overflow="hidden">
        <Show
          when={effectiveElements().length > 0}
          fallback={
            <div flex="~ col" items="center" justify="center" h="full" text="center">
              <span text="4xl mb-4">{props.emptyIcon}</span>
              <span text="sm dark-text-secondary" max-w="xs">
                {props.emptyMessage}
              </span>
            </div>
          }
        >
          <GraphVisualization
            elements={effectiveElements()}
            highlightedIds={props.highlightedIds}
            onNodeClick={props.onNodeClick}
            onEdgeClick={props.onEdgeClick}
            onCypherWrite={props.onCypherWrite}
            extraStyles={props.extraStyles}
          />
        </Show>
      </div>
    </>
  );
};

// ============================================================================
// Placeholder Component
// ============================================================================

interface PlaceholderPanelProps {
  icon: string;
  title: string;
  description: string;
  phase: string;
}

const PlaceholderPanel = (props: PlaceholderPanelProps) => (
  <div flex="~" items="center" justify="center" h="full" bg="dark-bg-primary">
    <div text="center">
      <svg
        width="64"
        height="64"
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
        style={{"margin":"0 auto", "color":"#4f46e5", "opacity":"0.5"}}
      >
        <path
          stroke-linecap="round"
          stroke-linejoin="round"
          stroke-width="2"
          d={props.icon}
        />
      </svg>
      <div text="lg dark-text-secondary" font="medium" m="t-4">
        {props.title}
      </div>
      <div text="sm dark-text-tertiary" m="t-2" max-w="sm">
        {props.description}
      </div>
      <div text="xs dark-text-tertiary" m="t-4">
        Coming in {props.phase}
      </div>
    </div>
  </div>
);
