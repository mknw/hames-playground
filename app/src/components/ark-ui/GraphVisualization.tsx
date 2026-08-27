/**
 * Graph Visualization Component
 *
 * Interactive graph visualization using Cytoscape.js
 * Displays Neo4j graph data with dark futuristic theme
 *
 * Features:
 * - Multiple layout options
 * - Manual Cypher query input (non-agentic, uses neo4j-driver directly)
 * - Node/edge click handlers
 */

import cytoscape, {
  type CollectionReturnValue,
  type Core,
  type ElementDefinition,
  type LayoutOptions,
  type StylesheetJsonBlock,
} from 'cytoscape'
import { createSignal, onMount, onCleanup, createEffect, Show, For } from 'solid-js'
import { Collapsible } from '@ark-ui/solid/collapsible'
import { runManualCypher, getNodeProperties } from '~/lib/neo4j/queries'
import {
  createGraphNode,
  linkGraphNodes,
  setGraphNodeProperty,
} from '~/lib/neo4j/graph-edit.server'

// ============================================================================
// Types
// ============================================================================

export interface GraphVisualizationProps {
  elements: ElementDefinition[]
  highlightedIds?: string[]
  onNodeClick?: (nodeId: string, nodeData: Record<string, unknown>) => void
  onEdgeClick?: (edgeId: string, edgeData: Record<string, unknown>) => void
  onElementsChange?: (elements: ElementDefinition[]) => void
  /** Reset the accumulated elements this canvas is fed from. Supplying it is
   *  what renders the clear control, because a clear is only meaningful where
   *  something owns `elements` and can empty it — the turn explorer derives its
   *  own from the selected turns, so a clear there would be undone by the next
   *  re-derivation. */
  onClearGraph?: () => void
  layout?: 'cose' | 'cola' | 'dagre' | 'circle' | 'grid' | 'breadthfirst'
  /** Additional Cytoscape stylesheets appended after base styles (e.g. per-turn colors) */
  extraStyles?: StylesheetJsonBlock[]
  /** Icon utility class (`i-material-symbols-*`) for the built-in empty-graph
   *  state, in place of the default glyph. */
  emptyIconClass?: string
  /** Per-tab copy for the built-in empty-graph state. */
  emptyMessage?: string
}

// ============================================================================
// Base Cytoscape Styles (dark futuristic theme)
// ============================================================================

const BASE_STYLES: StylesheetJsonBlock[] = [
  // Node styles
  {
    selector: 'node',
    style: {
      'background-color': '#00ffff',
      label: 'data(label)',
      color: '#e4e4e7',
      'text-valign': 'top',
      'text-halign': 'center',
      'text-margin-y': -8,
      'font-size': '12px',
      'font-family': 'Inter, sans-serif',
      'border-width': 2,
      'border-color': '#4f46e5',
      width: 50,
      height: 50,
      'text-wrap': 'wrap',
      'text-max-width': '100px',
      'text-background-opacity': 1,
      'text-background-color': '#0a0a0f',
      'text-background-padding': '4px',
      'text-background-shape': 'roundrectangle',
    },
  },
  // Edge styles
  {
    selector: 'edge',
    style: {
      width: 2,
      'line-color': '#4f46e5',
      'target-arrow-color': '#4f46e5',
      'target-arrow-shape': 'triangle',
      'curve-style': 'bezier',
      label: 'data(label)',
      'font-size': '10px',
      'font-family': 'Inter, sans-serif',
      color: '#a1a1aa',
      'text-rotation': 'autorotate',
      'text-background-opacity': 1,
      'text-background-color': '#0a0a0f',
      'text-background-padding': '3px',
    },
  },
  // Selected node
  {
    selector: 'node:selected',
    style: {
      'background-color': '#ff00ff',
      'border-color': '#ff00ff',
      'border-width': 3,
    } as Record<string, string | number>,
  },
  // Selected edge
  {
    selector: 'edge:selected',
    style: {
      'line-color': '#ff00ff',
      'target-arrow-color': '#ff00ff',
      width: 3,
    },
  },
  // Hover states
  {
    selector: 'node:active',
    style: {
      'overlay-opacity': 0.2,
      'overlay-color': '#00ffff',
    },
  },
  {
    selector: 'edge:active',
    style: {
      'overlay-opacity': 0.2,
      'overlay-color': '#4f46e5',
    },
  },
  // Highlighted nodes (from latest query)
  {
    selector: 'node.highlighted',
    style: {
      'background-color': '#00ffff',
      'border-color': '#00ffff',
      'border-width': 4,
      'overlay-opacity': 0.3,
      'overlay-color': '#00ffff',
    } as Record<string, string | number>,
  },
  // Highlighted edges (from latest query)
  {
    selector: 'edge.highlighted',
    style: {
      'line-color': '#00ffff',
      'target-arrow-color': '#00ffff',
      width: 3,
      'overlay-opacity': 0.2,
      'overlay-color': '#00ffff',
    },
  },
]

type LayoutName = 'cose' | 'cola' | 'dagre' | 'circle' | 'grid' | 'breadthfirst'

// ============================================================================
// Component
// ============================================================================

export const GraphVisualization = (props: GraphVisualizationProps) => {
  let containerRef: HTMLDivElement | undefined
  let cy: Core | null = null
  let resizeObserver: ResizeObserver | undefined
  let resizeRafId: number | undefined

  // eslint-disable-next-line solid/reactivity
  const [selectedLayout, setSelectedLayout] = createSignal<LayoutName>(props.layout ?? 'cose')
  const [nodeCount, setNodeCount] = createSignal(0)
  const [edgeCount, setEdgeCount] = createSignal(0)
  const [isLoading, setIsLoading] = createSignal(true)
  // Elements Cytoscape refused. Surfaced in the stats bar rather than swallowed
  // — see `addElements` below (SA-H9).
  const [rejectedCount, setRejectedCount] = createSignal(0)

  // Manual Cypher input state
  const [cypherInput, setCypherInput] = createSignal('')
  const [cypherError, setCypherError] = createSignal<string | null>(null)
  const [isExecuting, setIsExecuting] = createSignal(false)
  const [queryHistory, setQueryHistory] = createSignal<string[]>([])

  // Visual controls
  const [nodeDiameter, setNodeDiameter] = createSignal(50)
  const [edgeThickness, setEdgeThickness] = createSignal(2)
  const [fontSize, setFontSize] = createSignal(12)
  const [showEdgeLabels, setShowEdgeLabels] = createSignal(true)

  // Selected node state (for properties panel)
  const [selectedNode, setSelectedNode] = createSignal<{
    id: string
    label: string
    labels: string[]
    properties: Record<string, unknown> | null
    position: { x: number; y: number }
  } | null>(null)
  const [isLoadingProps, setIsLoadingProps] = createSignal(false)

  // Editing state
  const [editingField, setEditingField] = createSignal<{ key: string; value: string } | null>(null)
  const [relationMode, setRelationMode] = createSignal<{
    sourceId: string
    sourceLabel: string
  } | null>(null)
  const [newRelationType, setNewRelationType] = createSignal('RELATES_TO')
  // Visibility tracking (for deferred rendering when tab is inactive)
  const [visible, setVisible] = createSignal(false)
  // Create node form state
  const [showCreateNode, setShowCreateNode] = createSignal(false)
  const [newNodeName, setNewNodeName] = createSignal('')
  const [newNodeLabel, setNewNodeLabel] = createSignal('Concept')
  const [newNodeDescription, setNewNodeDescription] = createSignal('')

  // ========================================
  // Cytoscape Initialization
  // ========================================

  onMount(() => {
    if (!containerRef) return

    // Ensure container has valid dimensions before initializing
    const rect = containerRef.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) {
      console.warn('Graph container has zero dimensions at mount')
    }

    cy = cytoscape({
      container: containerRef,

      // Dark futuristic style (base + optional extras)
      style: [...BASE_STYLES, ...(props.extraStyles ?? [])] as cytoscape.StylesheetJsonBlock[],

      // Initial layout
      layout: getLayoutOptions(selectedLayout()),
    })

    // Event handlers
    // eslint-disable-next-line solid/reactivity
    cy.on('tap', 'node', (evt) => {
      const node = evt.target
      const data = node.data() as Record<string, unknown>
      const renderedPos = node.renderedPosition()
      const nodeId = node.id()

      // If in relation creation mode, complete the relation
      const rm = relationMode()
      if (rm && rm.sourceId !== nodeId) {
        const relType = newRelationType()
        const targetLabel = (data.label as string) || nodeId
        // Add edge to graph visually
        cy?.add({
          data: {
            id: `${rm.sourceId}-${relType}-${nodeId}`,
            source: rm.sourceId,
            target: nodeId,
            label: relType,
          },
        })
        setEdgeCount(cy?.edges().length ?? 0)
        linkGraphNodes(rm.sourceLabel, targetLabel, relType).catch((error) => {
          console.error('Cypher write failed:', error)
        })
        setRelationMode(null)
        return
      }

      // Build properties from the GraphElement data directly
      const internalKeys = new Set([
        'id',
        'label',
        'source',
        'target',
        'type',
        'labels',
        'properties',
      ])
      const inlineProps: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(data)) {
        if (!internalKeys.has(k) && v !== undefined) {
          inlineProps[k] = v
        }
      }

      const mergedProps = {
        ...inlineProps,
        ...((data.properties as Record<string, unknown>) || {}),
      }

      setSelectedNode({
        id: nodeId,
        label: (data.label as string) || 'Node',
        labels: (data.labels as string[]) || (data.type ? [data.type as string] : []),
        properties: Object.keys(mergedProps).length > 0 ? mergedProps : null,
        position: { x: renderedPos.x, y: renderedPos.y },
      })

      props.onNodeClick?.(nodeId, data)
    })

    // eslint-disable-next-line solid/reactivity
    cy.on('tap', 'edge', (evt) => {
      const edge = evt.target
      props.onEdgeClick?.(edge.id(), edge.data() as Record<string, unknown>)
    })

    // Click on background to close panel
    cy.on('tap', (evt) => {
      if (evt.target === cy) {
        setSelectedNode(null)
      }
    })

    // Double-click to center on node
    cy.on('dbltap', 'node', (evt) => {
      cy?.animate(
        {
          center: { eles: evt.target },
          zoom: 1.5,
        },
        {
          duration: 500,
        },
      )
    })

    // Track container visibility via ResizeObserver (for deferred rendering).
    // Guard against detached container + defer to rAF so a notify-during-layout
    // doesn't surface as "ResizeObserver loop completed with undelivered notifications"
    // when the tab unmounts mid-layout. See issue #38.
    resizeObserver = new ResizeObserver((entries) => {
      if (!containerRef?.isConnected) return
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      if (resizeRafId !== undefined) cancelAnimationFrame(resizeRafId)
      resizeRafId = requestAnimationFrame(() => {
        resizeRafId = undefined
        if (!containerRef?.isConnected) return
        setVisible(width > 0 && height > 0)
        cy?.resize()
      })
    })
    resizeObserver.observe(containerRef)

    setIsLoading(false)
  })

  // ========================================
  // Reactive Updates
  // ========================================

  // Re-apply styles when extraStyles change (e.g. per-turn color coding)
  createEffect(() => {
    if (!cy) return
    const extra = props.extraStyles ?? []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(cy as any).style([...BASE_STYLES, ...extra])
  })

  /**
   * Add elements to the graph, degrading one element at a time instead of
   * taking the tab down with the batch.
   *
   * `cy.add()` throws on a malformed element — a missing id, or an edge whose
   * endpoint isn't in the graph. Called bare inside a `createEffect`, that
   * throw propagates out of the effect and the whole canvas renders empty: one
   * bad row from one Cypher query blanked the entire Neo4j tab (SA-H9). The
   * extractor's `nodeElement`/`edgeElement` builders close the id-overwrite
   * hole that produced the known case, but the input is tool output and the
   * failure mode is total, so the render path does not assume it is well-formed.
   *
   * Retrying element-by-element is the whole point: everything renderable
   * renders, and what didn't is counted for the stats bar rather than dropped
   * in silence.
   */
  const addElements = (batch: ElementDefinition[]): CollectionReturnValue | null => {
    const graph = cy
    if (!graph) return null
    try {
      return graph.add(batch)
    } catch (batchErr) {
      // The batch may have been applied up to the offending element before it
      // threw, so re-adding is per-element and skips ids already in the graph.
      console.warn('[GraphVisualization] batch add failed, retrying per element:', batchErr)
      let accepted = graph.collection()
      let rejected = 0
      for (const el of batch) {
        const id = el?.data?.id
        if (id !== undefined && graph.getElementById(String(id)).nonempty()) continue
        try {
          accepted = accepted.union(graph.add(el))
        } catch (err) {
          rejected += 1
          console.warn('[GraphVisualization] element rejected by Cytoscape:', id, err)
        }
      }
      setRejectedCount((n) => n + rejected)
      return accepted.nonempty() ? accepted : null
    }
  }

  // Update graph incrementally when elements change (re-triggers on visibility)
  createEffect(() => {
    const isVisible = visible()
    if (!cy || !containerRef || !isVisible) return

    const elements = props.elements

    if (elements.length === 0) {
      cy.elements().remove()
      setNodeCount(0)
      setEdgeCount(0)
      setRejectedCount(0)
      return
    }

    // Incremental update: only add new elements, preserve existing positions
    const existingIds = new Set(cy.elements().map((el) => el.id()))
    const newElements = elements.filter((el) => !existingIds.has(el.data?.id as string))

    if (newElements.length === 0 && existingIds.size === elements.length) {
      // No changes
      return
    }

    if (existingIds.size === 0) {
      // First load: add all and layout everything
      addElements(elements)
      cy.resize()
      cy.layout(getLayoutOptions(selectedLayout())).run()
      cy.fit(undefined, 50)
    } else if (newElements.length > 0) {
      // Incremental: add new elements, layout only them
      const added = addElements(newElements)
      cy.resize()
      // Run layout on just the new elements to find positions without disrupting existing
      const layoutOpts = getLayoutOptions(selectedLayout())
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(layoutOpts as any).fit = false
      added?.layout(layoutOpts).run()
    }

    setNodeCount(cy.nodes().length)
    setEdgeCount(cy.edges().length)
  })

  // Apply visual controls when they change
  createEffect(() => {
    if (!cy) return
    const size = nodeDiameter()
    const edge = edgeThickness()
    const font = fontSize()
    const showLabels = showEdgeLabels()

    cy.style()
      .selector('node')
      .style({
        width: size,
        height: size,
        'font-size': `${font}px`,
      } as Record<string, unknown>)
      .selector('edge')
      .style({
        width: edge,
        'font-size': `${Math.max(font - 2, 8)}px`,
        label: showLabels ? 'data(label)' : '',
      } as Record<string, unknown>)
      .update()
  })

  // Update highlighting when highlightedIds changes
  createEffect(() => {
    if (!cy) return
    const ids = props.highlightedIds || []
    const cyInstance = cy

    // Remove all existing highlights
    cyInstance.elements().removeClass('highlighted')

    // Add highlight class to new elements
    if (ids.length > 0) {
      ids.forEach((id) => {
        const el = cyInstance.$id(id)
        if (el.length > 0) {
          el.addClass('highlighted')
        }
      })
    }
  })

  // Update layout when changed
  const applyLayout = (layoutName: LayoutName) => {
    if (!cy) return
    setSelectedLayout(layoutName)
    cy.layout(getLayoutOptions(layoutName)).run()
  }

  /**
   * Empty the view: the canvas, the counts, and the accumulated elements
   * behind them. Nothing here touches Neo4j — re-running a query repopulates.
   *
   * Both halves are load-bearing, and each covers the other's blind spot.
   * `props.elements` is the source of truth, so without the owner's reset the
   * next element to arrive re-renders the whole accumulated set (the effect
   * above treats an empty canvas as a first load). But manual-query results are
   * added straight to the Cytoscape instance and never enter `props.elements`
   * (see `renderQueryResult`), so when that array is ALREADY empty — the
   * ordinary case for a manual query before any chat turn — the owner's reset
   * changes no signal, the effect never re-runs, and those elements would
   * survive a clear that only reset the source.
   *
   * The two node panels go with it: both are anchored to a node that is no
   * longer on the canvas, and relation mode is waiting for a second click that
   * can no longer happen.
   */
  const handleClearGraph = () => {
    cy?.elements().remove()
    setNodeCount(0)
    setEdgeCount(0)
    setRejectedCount(0)
    setSelectedNode(null)
    setRelationMode(null)
    props.onClearGraph?.()
  }

  // ========================================
  // Manual Cypher Handler
  // ========================================

  /**
   * Put manual-query results on the canvas.
   *
   * `props.elements` belongs to the conversation, and nothing in the app owns
   * `onElementsChange` — so without this a successful manual query was a silent
   * no-op: the envelope came back fine and the canvas stayed empty (#237
   * follow-up). Additive, and it leaves existing positions alone, exactly like
   * the `props.elements` effect above.
   */
  const renderQueryResult = (elements: ElementDefinition[]) => {
    const graph = cy
    if (!graph) return

    const firstLoad = graph.elements().empty()
    const fresh = elements.filter((el) => graph.getElementById(String(el.data?.id ?? '')).empty())
    const added = fresh.length > 0 ? addElements(fresh) : null

    graph.resize()
    const layoutOpts = getLayoutOptions(selectedLayout())
    if (firstLoad) {
      graph.layout(layoutOpts).run()
      graph.fit(undefined, 50)
    } else if (added) {
      // Lay out only what arrived, so the rest of the graph does not jump.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(layoutOpts as any).fit = false
      added.layout(layoutOpts).run()
    }

    setNodeCount(graph.nodes().length)
    setEdgeCount(graph.edges().length)
  }

  const handleRunCypher = async () => {
    const query = cypherInput().trim()
    if (!query) return

    setIsExecuting(true)
    setCypherError(null)

    try {
      const result = await runManualCypher(query)

      if (result.success && result.graphUpdate) {
        renderQueryResult(result.graphUpdate)
        // Notify parent of graph update
        props.onElementsChange?.(result.graphUpdate)

        // Add to history (keep last 10)
        setQueryHistory((prev) => {
          const updated = [query, ...prev.filter((q) => q !== query)]
          return updated.slice(0, 10)
        })

        // Clear input after successful execution
        setCypherInput('')
      } else {
        setCypherError(result.error || 'Unknown error')
      }
    } catch (error) {
      setCypherError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsExecuting(false)
    }
  }

  const handleKeyDown = (e: KeyboardEvent) => {
    // Cmd/Ctrl + Enter to run query
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      handleRunCypher()
    }
  }

  // ========================================
  // Node Properties Handler
  // ========================================

  const handleLoadProperties = async () => {
    const node = selectedNode()
    if (!node) return

    setIsLoadingProps(true)
    try {
      const result = await getNodeProperties(node.id)
      if (result.success && result.properties) {
        // Update selected node with properties
        setSelectedNode({ ...node, properties: result.properties })

        // Also update Cytoscape node data for future clicks
        cy?.getElementById(node.id).data('properties', result.properties)
      }
    } catch (error) {
      console.error('Failed to load properties:', error)
    } finally {
      setIsLoadingProps(false)
    }
  }

  // ========================================
  // Create Node Handler
  // ========================================

  const handleCreateNode = () => {
    const name = newNodeName().trim()
    if (!name) return

    const label = newNodeLabel().trim() || 'Concept'
    const description = newNodeDescription().trim()

    // Add to Cytoscape locally
    cy?.add({
      data: {
        id: name,
        label: name,
        type: label,
        name,
        ...(description ? { description } : {}),
      },
    })

    // Layout the new node
    const newNode = cy?.$id(name)
    if (newNode && newNode.length > 0) {
      // Position near center of viewport
      const ext = cy!.extent()
      newNode.position({
        x: (ext.x1 + ext.x2) / 2 + (Math.random() - 0.5) * 100,
        y: (ext.y1 + ext.y2) / 2 + (Math.random() - 0.5) * 100,
      })
    }

    setNodeCount(cy?.nodes().length ?? 0)

    // Persist to Neo4j
    createGraphNode(label, name, description || undefined).catch((error) => {
      console.error('Cypher write failed:', error)
    })

    // Reset form
    setNewNodeName('')
    setNewNodeDescription('')
    setShowCreateNode(false)
  }

  // ========================================
  // Cleanup
  // ========================================

  onCleanup(() => {
    if (resizeRafId !== undefined) {
      cancelAnimationFrame(resizeRafId)
      resizeRafId = undefined
    }
    resizeObserver?.disconnect()
    resizeObserver = undefined
    cy?.destroy()
    cy = null
  })

  // ========================================
  // Render
  // ========================================

  return (
    <div flex="~ col" h="full" w="full" bg="ui-bg-primary" position="relative">
      {/* Toolbar */}
      <div
        bg="ui-bg-secondary"
        border="b ui-border-primary"
        p="2"
        flex="~"
        items="center"
        gap="2"
        z="10"
      >
        {/* Layout selector */}
        <div flex="~" items="center" gap="1">
          <span text="xs ui-text-tertiary">Layout:</span>
          <select
            value={selectedLayout()}
            onChange={(e) => applyLayout(e.currentTarget.value as LayoutName)}
            bg="ui-bg-tertiary"
            text="xs ui-text-primary"
            border="1 ui-border-secondary"
            rounded="md"
            p="x-2 y-1"
            cursor="pointer"
          >
            <option value="cose">Force Directed</option>
            <option value="circle">Circle</option>
            <option value="grid">Grid</option>
            <option value="breadthfirst">Hierarchical</option>
          </select>
        </div>

        {/* Stats */}
        <div flex="~ 1" items="center" gap="4" justify="end" text="xs ui-text-tertiary">
          <span>{nodeCount()} nodes</span>
          <span>{edgeCount()} edges</span>
          {/* Elements Cytoscape refused. Glyph + wording, not colour alone
              (`color-not-only`), so the state survives a monochrome view. */}
          <Show when={rejectedCount() > 0}>
            <span
              flex="~"
              items="center"
              gap="1"
              text="xs amber-400"
              title="These elements were malformed (missing id, or an edge pointing at a node that isn't in the graph) and were skipped so the rest of the graph could render."
            >
              <span class="i-material-symbols-warning-outline" w="3.5" h="3.5" aria-hidden="true" />
              {rejectedCount()} skipped
            </span>
          </Show>
        </div>

        {/* Actions */}
        <button
          onClick={() => cy?.fit(undefined, 50)}
          p="x-3 y-1"
          text="xs ui-text-primary"
          bg="ui-bg-tertiary hover:ui-bg-hover"
          border="1 ui-border-secondary"
          rounded="md"
          cursor="pointer"
          transition="colors"
        >
          Fit View
        </button>

        <button
          onClick={() => cy?.zoom(cy.zoom() * 1.2)}
          p="x-3 y-1"
          text="xs ui-text-primary"
          bg="ui-bg-tertiary hover:ui-bg-hover"
          border="1 ui-border-secondary"
          rounded="md"
          cursor="pointer"
          transition="colors"
        >
          +
        </button>

        <button
          onClick={() => cy?.zoom(cy.zoom() * 0.8)}
          p="x-3 y-1"
          text="xs ui-text-primary"
          bg="ui-bg-tertiary hover:ui-bg-hover"
          border="1 ui-border-secondary"
          rounded="md"
          cursor="pointer"
          transition="colors"
        >
          −
        </button>

        {/* Add Node button */}
        <button
          onClick={() => setShowCreateNode(!showCreateNode())}
          p="x-3 y-1"
          text="xs"
          bg={showCreateNode() ? 'ui-accent/30' : 'ui-bg-tertiary hover:ui-bg-hover'}
          border={showCreateNode() ? '1 ui-accent/50' : '1 ui-border-secondary'}
          rounded="md"
          cursor="pointer"
          transition="colors"
          style={{ color: showCreateNode() ? 'var(--ui-accent)' : 'var(--ui-text-primary)' }}
        >
          + Node
        </button>

        {/* Clear the VIEW. Deliberately not a destructive-red affordance and
            deliberately without a confirmation: nothing leaves the database and
            re-running a query brings the graph back. R3 icon-button recipe. */}
        <Show when={props.onClearGraph}>
          <button
            onClick={handleClearGraph}
            title="Clear the graph view (does not change the database)"
            aria-label="Clear graph view"
            w="7"
            h="7"
            flex="~"
            items="center"
            justify="center"
            bg="transparent hover:ui-bg-hover"
            border="1 ui-border-secondary"
            rounded="md"
            cursor="pointer"
            transition="all"
          >
            <span
              class="i-material-symbols-layers-clear-outline"
              w="4"
              h="4"
              text="ui-text-primary"
              aria-hidden="true"
            />
          </button>
        </Show>
      </div>

      {/* Create Node Form */}
      <Show when={showCreateNode()}>
        <div bg="ui-bg-secondary" border="b ui-border-primary" p="3" flex="~ col" gap="2">
          <div text="xs ui-text-secondary" font="medium">
            Create Node
          </div>
          <div flex="~" gap="2">
            <div flex="~ col 1" gap="1">
              <label text="xs ui-text-tertiary">Name *</label>
              <input
                value={newNodeName()}
                onInput={(e) => setNewNodeName(e.currentTarget.value)}
                placeholder="e.g. GraphQL"
                p="x-2 y-1.5"
                bg="ui-bg-tertiary"
                text="xs ui-text-primary"
                border="1 ui-border-secondary focus:ui-accent/50"
                rounded="md"
                outline="none"
              />
            </div>
            <div flex="~ col" gap="1">
              <label text="xs ui-text-tertiary">Label</label>
              <input
                value={newNodeLabel()}
                onInput={(e) => setNewNodeLabel(e.currentTarget.value)}
                placeholder="e.g. Concept"
                p="x-2 y-1.5"
                w="28"
                bg="ui-bg-tertiary"
                text="xs ui-text-primary"
                border="1 ui-border-secondary focus:ui-accent/50"
                rounded="md"
                outline="none"
              />
            </div>
          </div>
          <div flex="~ col" gap="1">
            <label text="xs ui-text-tertiary">Description</label>
            <input
              value={newNodeDescription()}
              onInput={(e) => setNewNodeDescription(e.currentTarget.value)}
              placeholder="Optional description"
              p="x-2 y-1.5"
              bg="ui-bg-tertiary"
              text="xs ui-text-primary"
              border="1 ui-border-secondary focus:ui-accent/50"
              rounded="md"
              outline="none"
            />
          </div>
          <div flex="~" gap="2">
            <button
              onClick={handleCreateNode}
              disabled={!newNodeName().trim()}
              p="x-3 y-1.5"
              text="xs"
              bg="ui-accent/20 hover:ui-accent/30 disabled:opacity-40"
              border="1 ui-accent/50"
              rounded="md"
              cursor="pointer disabled:cursor-not-allowed"
              transition="all"
              style={{ color: 'var(--ui-accent)' }}
            >
              Create
            </button>
            <button
              onClick={() => setShowCreateNode(false)}
              p="x-3 y-1.5"
              text="xs ui-text-tertiary"
              bg="ui-bg-tertiary hover:ui-bg-hover"
              border="1 ui-border-secondary"
              rounded="md"
              cursor="pointer"
            >
              Cancel
            </button>
          </div>
        </div>
      </Show>

      {/* Manual Cypher Query Panel */}
      <Collapsible.Root>
        <Collapsible.Trigger
          w="full"
          p="2"
          bg="ui-bg-secondary"
          border="b ui-border-primary"
          text="xs ui-text-secondary"
          cursor="pointer"
          flex="~"
          items="center"
          gap="2"
          transition="colors"
          hover:bg="ui-bg-hover"
        >
          <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"
            />
          </svg>
          <span>Manual Cypher Query</span>
          <Show when={queryHistory().length > 0}>
            <span text="ui-text-tertiary">({queryHistory().length} recent)</span>
          </Show>
        </Collapsible.Trigger>

        <Collapsible.Content bg="ui-bg-secondary" border="b ui-border-primary" p="3">
          {/* Query Input */}
          <div flex="~ col" gap="2">
            <textarea
              value={cypherInput()}
              onInput={(e) => setCypherInput(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              placeholder="MATCH (n) RETURN n LIMIT 10"
              rows="3"
              w="full"
              p="3"
              bg="ui-bg-tertiary"
              text="sm ui-text-primary font-mono"
              border="1 ui-border-secondary"
              rounded="md"
              outline="none focus:border-ui-accent/50"
              resize="y"
              disabled={isExecuting()}
            />

            <div flex="~" items="center" gap="2">
              <button
                onClick={handleRunCypher}
                disabled={!cypherInput().trim() || isExecuting()}
                p="x-4 y-2"
                text="sm ui-text-primary"
                bg="ui-accent/20 hover:ui-accent/30 disabled:opacity-50"
                border="1 ui-accent/50"
                rounded="md"
                cursor="pointer disabled:cursor-not-allowed"
                transition="all"
                font="medium"
                flex="~"
                items="center"
                gap="2"
              >
                <Show when={isExecuting()} fallback={<span>Run Query</span>}>
                  <span>Executing...</span>
                </Show>
              </button>

              <span text="xs ui-text-tertiary">Cmd/Ctrl + Enter</span>
            </div>

            {/* Error Display */}
            <Show when={cypherError()}>
              <div bg="red-500/10" border="1 red-500/30" rounded="md" p="3" text="sm red-400">
                <div font="medium" m="b-1">
                  Query Error
                </div>
                <div font="mono" text="xs">
                  {cypherError()}
                </div>
              </div>
            </Show>

            {/* Query History */}
            <Show when={queryHistory().length > 0}>
              <div m="t-2">
                <div text="xs ui-text-tertiary" m="b-1">
                  Recent queries:
                </div>
                <div flex="~ wrap" gap="1">
                  <For each={queryHistory()}>
                    {(query) => (
                      <button
                        onClick={() => setCypherInput(query)}
                        p="x-2 y-1"
                        text="xs ui-text-secondary font-mono"
                        bg="ui-bg-tertiary hover:ui-bg-hover"
                        border="1 ui-border-secondary"
                        rounded="sm"
                        cursor="pointer"
                        transition="colors"
                        max-w="200px"
                        truncate
                        title={query}
                      >
                        {query.length > 30 ? query.substring(0, 30) + '...' : query}
                      </button>
                    )}
                  </For>
                </div>
              </div>
            </Show>
          </div>
        </Collapsible.Content>
      </Collapsible.Root>

      {/* Visual Controls Panel */}
      <Collapsible.Root>
        <Collapsible.Trigger
          w="full"
          p="2"
          bg="ui-bg-secondary"
          border="b ui-border-primary"
          text="xs ui-text-secondary"
          cursor="pointer"
          flex="~"
          items="center"
          gap="2"
          transition="colors"
          hover:bg="ui-bg-hover"
        >
          <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="2"
              d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"
            />
          </svg>
          <span>Display Controls</span>
        </Collapsible.Trigger>

        <Collapsible.Content bg="ui-bg-secondary" border="b ui-border-primary" p="3">
          <div flex="~ col" gap="3">
            {/* Node Diameter */}
            <div flex="~" items="center" gap="3">
              <label text="xs ui-text-tertiary" w="24" flex="shrink-0">
                Node Size
              </label>
              <input
                type="range"
                min="20"
                max="100"
                value={nodeDiameter()}
                onInput={(e) => setNodeDiameter(Number(e.currentTarget.value))}
                flex="1"
                cursor="pointer"
              />
              <span text="xs ui-text-tertiary" w="8" text-align="right">
                {nodeDiameter()}
              </span>
            </div>

            {/* Edge Thickness */}
            <div flex="~" items="center" gap="3">
              <label text="xs ui-text-tertiary" w="24" flex="shrink-0">
                Edge Width
              </label>
              <input
                type="range"
                min="1"
                max="6"
                step="0.5"
                value={edgeThickness()}
                onInput={(e) => setEdgeThickness(Number(e.currentTarget.value))}
                flex="1"
                cursor="pointer"
              />
              <span text="xs ui-text-tertiary" w="8" text-align="right">
                {edgeThickness()}
              </span>
            </div>

            {/* Font Size */}
            <div flex="~" items="center" gap="3">
              <label text="xs ui-text-tertiary" w="24" flex="shrink-0">
                Font Size
              </label>
              <input
                type="range"
                min="8"
                max="20"
                value={fontSize()}
                onInput={(e) => setFontSize(Number(e.currentTarget.value))}
                flex="1"
                cursor="pointer"
              />
              <span text="xs ui-text-tertiary" w="8" text-align="right">
                {fontSize()}
              </span>
            </div>

            {/* Show Edge Labels */}
            <div flex="~" items="center" gap="3">
              <label text="xs ui-text-tertiary" w="24" flex="shrink-0">
                Edge Labels
              </label>
              <input
                type="checkbox"
                checked={showEdgeLabels()}
                onChange={(e) => setShowEdgeLabels(e.currentTarget.checked)}
                cursor="pointer"
              />
            </div>
          </div>
        </Collapsible.Content>
      </Collapsible.Root>

      {/* Graph Container */}
      <div ref={containerRef} flex="1" w="full" min-h="200px" position="relative">
        {/* Loading state */}
        <Show when={isLoading()}>
          <div
            {...({
              position: 'absolute',
              top: '0',
              left: '0',
              w: 'full',
              h: 'full',
              flex: '~',
              items: 'center',
              justify: 'center',
              bg: 'ui-bg-primary',
              z: '20',
            } as Record<string, string>)}
          >
            <span text="ui-text-tertiary">Loading graph...</span>
          </div>
        </Show>

        {/* Empty state */}
        <Show when={!isLoading() && nodeCount() === 0}>
          <div
            {...({
              position: 'absolute',
              top: '0',
              left: '0',
              w: 'full',
              h: 'full',
              flex: '~',
              items: 'center',
              justify: 'center',
            } as Record<string, string>)}
          >
            <div text="center" max-w="sm" p="x-6">
              <Show
                when={props.emptyIconClass}
                fallback={
                  <svg
                    width="96"
                    height="96"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                    style={{ margin: '0 auto', color: '#4f46e5', opacity: '0.3' }}
                  >
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0zM10 7v3m0 0v3m0-3h3m-3 0H7"
                    />
                  </svg>
                }
              >
                {(iconClass) => (
                  /* The flex wrapper is what centres it AND what makes `w`/`h`
                     apply — an icon utility sets a 1em box but no `display`, so
                     an icon span outside a flex parent stays a zero-size inline. */
                  <div flex="~" justify="center">
                    <span
                      class={iconClass()}
                      w="16"
                      h="16"
                      text="ui-text-tertiary"
                      aria-hidden="true"
                    />
                  </div>
                )}
              </Show>
              <div text="xl ui-text-secondary" font="medium" m="t-4">
                No Graph Data
              </div>
              <div text="sm ui-text-tertiary" m="t-2">
                {props.emptyMessage ?? 'Ask a question to visualize the knowledge graph'}
              </div>
              <div text="xs ui-text-tertiary" m="t-3">
                Or open <strong text="ui-accent">Manual Cypher Query</strong> above to query Neo4j
                directly.
              </div>
            </div>
          </div>
        </Show>

        {/* Relation mode banner */}
        <Show when={relationMode()}>
          <div
            style={{ position: 'absolute', top: '8px', left: '50%', transform: 'translateX(-50%)' }}
            bg="purple-600/80"
            text="xs white"
            p="x-3 y-2"
            rounded="lg"
            z="50"
            flex="~"
            items="center"
            gap="2"
            shadow="[0_0_15px_rgba(168,85,247,0.4)]"
          >
            <span>
              Select target node for relation from <strong>{relationMode()!.sourceLabel}</strong>
            </span>
            <input
              value={newRelationType()}
              onInput={(e) => setNewRelationType(e.currentTarget.value)}
              bg="purple-800"
              text="xs white"
              border="1 purple-500"
              rounded="md"
              p="x-2 y-1"
              w="32"
              placeholder="REL_TYPE"
            />
            <button
              onClick={() => setRelationMode(null)}
              text="xs white hover:red-300"
              cursor="pointer"
              bg="transparent"
            >
              Cancel
            </button>
          </div>
        </Show>

        {/* Node Properties Panel */}
        <Show when={selectedNode()}>
          {(node) => (
            <div
              style={{
                position: 'absolute',
                left: `${Math.min(node().position.x + 60, (containerRef?.clientWidth || 400) - 280)}px`,
                top: `${Math.max(20, Math.min(node().position.y, (containerRef?.clientHeight || 400) - 200))}px`,
                transform: 'translateY(-50%)',
              }}
              bg="ui-bg-secondary"
              border="1 ui-border-primary"
              rounded="lg"
              p="4"
              min-w="64"
              max-w="72"
              max-h="96"
              overflow="y-auto"
              shadow="[0_0_20px_rgba(0,0,0,0.5)]"
              z="50"
            >
              {/* Header */}
              <div flex="~" justify="between" items="start" m="b-3" gap="2">
                <div>
                  <div text="sm ui-text-primary" font="semibold">
                    {node().label}
                  </div>
                  <Show when={node().labels.length > 0}>
                    <div flex="~ wrap" gap="1" m="t-1">
                      <For each={node().labels}>
                        {(lbl) => (
                          <span
                            text="xs ui-accent"
                            bg="ui-accent/15"
                            border="1 ui-accent/30"
                            rounded="full"
                            p="x-2 y-0.5"
                          >
                            {lbl}
                          </span>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
                <button
                  onClick={() => {
                    setSelectedNode(null)
                    setEditingField(null)
                  }}
                  p="1"
                  text="ui-text-tertiary hover:ui-text-primary"
                  bg="transparent hover:ui-bg-hover"
                  rounded="md"
                  cursor="pointer"
                  transition="colors"
                >
                  <svg width="16" height="16" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M6 18L18 6M6 6l12 12"
                    />
                  </svg>
                </button>
              </div>

              {/* Properties */}
              <Show
                when={node().properties && Object.keys(node().properties!).length > 0}
                fallback={
                  <div>
                    <div text="xs ui-text-tertiary" m="b-2">
                      No properties loaded
                    </div>
                    <button
                      onClick={handleLoadProperties}
                      disabled={isLoadingProps()}
                      p="x-3 y-2"
                      w="full"
                      text="xs ui-text-primary"
                      bg="ui-accent/20 hover:ui-accent/30 disabled:opacity-50"
                      border="1 ui-accent/50"
                      rounded="md"
                      cursor="pointer disabled:cursor-wait"
                      transition="all"
                      font="medium"
                    >
                      {isLoadingProps() ? 'Loading...' : 'Load Properties'}
                    </button>
                  </div>
                }
              >
                <div text="xs" max-h="48" overflow="y-auto" space="y-2">
                  <For each={Object.entries(node().properties!)}>
                    {([key, value]) => (
                      <div border="b ui-border-secondary" p="b-2">
                        <div flex="~" justify="between" items="center">
                          <div text="ui-text-tertiary" font="medium">
                            {key}
                          </div>
                          <Show when={typeof value === 'string'}>
                            <button
                              onClick={() => setEditingField({ key, value: String(value) })}
                              text="ui-text-tertiary hover:ui-accent"
                              bg="transparent"
                              cursor="pointer"
                              p="0.5"
                              title="Edit field"
                            >
                              <svg
                                width="12"
                                height="12"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                              >
                                <path
                                  stroke-linecap="round"
                                  stroke-linejoin="round"
                                  stroke-width="2"
                                  d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
                                />
                              </svg>
                            </button>
                          </Show>
                        </div>
                        <Show
                          when={editingField()?.key === key}
                          fallback={
                            <div text="ui-text-primary" style={{ 'word-break': 'break-word' }}>
                              {typeof value === 'object'
                                ? JSON.stringify(value, null, 2)
                                : String(value)}
                            </div>
                          }
                        >
                          <div flex="~ col" gap="1" m="t-1">
                            <textarea
                              value={editingField()!.value}
                              onInput={(e) =>
                                setEditingField({ key, value: e.currentTarget.value })
                              }
                              rows="2"
                              w="full"
                              p="2"
                              bg="ui-bg-tertiary"
                              text="xs ui-text-primary"
                              border="1 ui-accent/30"
                              rounded="md"
                              outline="none"
                              resize="y"
                            />
                            <div flex="~" gap="1">
                              <button
                                onClick={() => {
                                  const newVal = editingField()!.value
                                  // Update locally
                                  cy?.getElementById(node().id).data(key, newVal)
                                  setSelectedNode({
                                    ...node(),
                                    properties: { ...node().properties!, [key]: newVal },
                                  })
                                  // Persist to Neo4j
                                  setGraphNodeProperty(node().label, key, newVal).catch((error) => {
                                    console.error('Cypher write failed:', error)
                                  })
                                  setEditingField(null)
                                }}
                                p="x-2 y-1"
                                text="xs ui-accent"
                                bg="ui-accent/20 hover:ui-accent/30"
                                border="1 ui-accent/50"
                                rounded="md"
                                cursor="pointer"
                              >
                                Save
                              </button>
                              <button
                                onClick={() => setEditingField(null)}
                                p="x-2 y-1"
                                text="xs ui-text-tertiary"
                                bg="ui-bg-tertiary hover:ui-bg-hover"
                                border="1 ui-border-secondary"
                                rounded="md"
                                cursor="pointer"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              {/* Actions footer */}
              <div m="t-3" p="t-2" border="t ui-border-secondary" space="y-2">
                {/* Create relation button */}
                <button
                  onClick={() => {
                    setRelationMode({ sourceId: node().id, sourceLabel: node().label })
                    setSelectedNode(null)
                  }}
                  p="x-3 y-1.5"
                  w="full"
                  text="xs purple-300"
                  bg="purple-600/20 hover:purple-600/30"
                  border="1 purple-500/50"
                  rounded="md"
                  cursor="pointer"
                  transition="all"
                  flex="~"
                  items="center"
                  justify="center"
                  gap="1"
                >
                  <svg width="12" height="12" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      stroke-width="2"
                      d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
                    />
                  </svg>
                  Create Relation
                </button>

                {/* Node ID */}
                <div text="xs ui-text-tertiary" font="mono">
                  ID: {node().id.length > 20 ? node().id.substring(0, 20) + '...' : node().id}
                </div>
              </div>
            </div>
          )}
        </Show>
      </div>
    </div>
  )
}

// ============================================================================
// Layout Configurations
// ============================================================================

function getLayoutOptions(layoutName: LayoutName): LayoutOptions {
  const baseOptions = {
    animate: true,
    animationDuration: 500,
    animationEasing: 'ease-out' as const,
  }

  switch (layoutName) {
    case 'cose':
      return {
        name: 'cose',
        ...baseOptions,
        nodeRepulsion: 400000,
        idealEdgeLength: 100,
        edgeElasticity: 100,
        nestingFactor: 5,
        gravity: 80,
        numIter: 1000,
        initialTemp: 200,
        coolingFactor: 0.95,
        minTemp: 1.0,
      }

    case 'circle':
      return {
        name: 'circle',
        ...baseOptions,
        radius: undefined,
        spacingFactor: 1.5,
      }

    case 'grid':
      return {
        name: 'grid',
        ...baseOptions,
        rows: undefined,
        cols: undefined,
      }

    case 'breadthfirst':
      return {
        name: 'breadthfirst',
        ...baseOptions,
        directed: true,
        spacingFactor: 1.5,
        circle: false,
      }

    default:
      return {
        name: 'cose',
        ...baseOptions,
      }
  }
}
