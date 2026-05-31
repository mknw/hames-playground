import { Splitter } from '@ark-ui/solid/splitter'
import { createSignal, createMemo, createResource, createEffect, onCleanup, onMount } from 'solid-js'
import { ChatInterface, type SessionRunState } from '~/components/ark-ui/ChatInterface'
import { ChatSidebar, mergeThreadsWithPlaceholder } from '~/components/ark-ui/ChatSidebar'
import { SupportPanel, type GraphElement } from '~/components/ark-ui/SupportPanel'
import type { ContextEvent, UnifiedContext, ToolResultEventData } from '~/lib/harness-patterns'
import { executeCypherWrite } from '~/lib/neo4j/write-action'
import { mergeGraphElements } from '~/lib/graph-merge'
import { listConversations, deleteConversations } from '~/lib/harness-client'
import { newSessionId } from '~/lib/session-id'
import type { StashAction } from '~/components/ark-ui/DataStashPanel'
import { createChainProgress, type ChainProgressController } from '~/components/ark-ui/useChainProgress'

const DEFAULT_RUN_STATE: SessionRunState = { isProcessing: false, runningTool: null }

export default function Home() {
  // Conversation a user is currently viewing. Initial value is a fresh id so
  // the first message creates a new persisted row; switching threads via the
  // sidebar (or "+ New Chat") swaps this signal.
  const [selectedSessionId, setSelectedSessionId] = createSignal(newSessionId())
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false)

  // Optimistic placeholder for a freshly-minted "+ New Chat" id that hasn't
  // been persisted yet (see #44). Cleared once the real row arrives in the
  // threadsResource refetch, or when the user picks an existing thread.
  const [placeholderSessionId, setPlaceholderSessionId] = createSignal<string | null>(null)

  // Monotonic token: each `+ New Chat` click bumps it, the ChatInput effect
  // focuses the textarea so the user can start typing without an extra click.
  const [focusInputToken, setFocusInputToken] = createSignal(0)

  const [graphElements, setGraphElements] = createSignal<GraphElement[]>([])
  const [highlightedIds, setHighlightedIds] = createSignal<string[]>([])
  const [contextEvents, setContextEvents] = createSignal<ContextEvent[]>([])
  const [unifiedContext, setUnifiedContext] = createSignal<UnifiedContext | undefined>(undefined)

  // Sidebar threads — refetched after each turn completes (see onContextUpdate).
  // `mutate` is exposed so the `title_updated` SSE event can patch a single
  // row's title in-place without re-querying the full list (the server already
  // gave us the new title in the event payload).
  const [threads, { refetch: refetchThreads, mutate: mutateThreads }] = createResource(() => listConversations())

  // Push-driven title update from the SSE stream — the server emits a
  // `title_updated` event after the LLM title generator resolves. We splice
  // the new title into the threads cache; no refetch needed.
  const handleTitleUpdated = (sid: string, title: string) => {
    mutateThreads(list => (list ?? []).map(t => (t.id === sid ? { ...t, title } : t)))
  }

  // ===========================================================================
  // Per-session progress + run state (#47)
  // ===========================================================================
  // ChainProgressController instances are owned by the route so the live bar
  // and submit guard persist across sidebar switches. ChatInterface reads its
  // session's controller via `getProgress(sid)` and routes ingest calls into
  // the controller for the captured run sessionId — events arriving for the
  // unfocused chat keep flowing into its own bar.

  const progressBySession = new Map<string, ChainProgressController>()
  const getProgress = (sid: string): ChainProgressController => {
    let p = progressBySession.get(sid)
    if (!p) {
      p = createChainProgress()
      progressBySession.set(sid, p)
    }
    return p
  }

  // Reactive run-state map (`isProcessing`, `runningTool`). Kept as a plain
  // object so Solid can diff equality on the whole record without Map identity.
  const [runStates, setRunStates] = createSignal<Record<string, SessionRunState>>({})
  const getRunState = (sid: string): SessionRunState => runStates()[sid] ?? DEFAULT_RUN_STATE
  const updateRunState = (sid: string, patch: Partial<SessionRunState>) => {
    setRunStates(prev => ({
      ...prev,
      [sid]: { ...DEFAULT_RUN_STATE, ...prev[sid], ...patch },
    }))
  }

  // AbortControllers for in-flight SSE streams. Switching sessions does NOT
  // abort — only an explicit cancel or page unload does (acceptance: "Streams
  // survive chat switches").
  const abortControllers = new Map<string, AbortController>()
  const registerAbortController = (sid: string, ac: AbortController) => {
    abortControllers.set(sid, ac)
  }
  const unregisterAbortController = (sid: string) => {
    abortControllers.delete(sid)
  }

  onMount(() => {
    const onUnload = () => {
      for (const ac of abortControllers.values()) {
        try { ac.abort() } catch { /* ignore */ }
      }
      abortControllers.clear()
    }
    window.addEventListener('beforeunload', onUnload)
    onCleanup(() => window.removeEventListener('beforeunload', onUnload))
  })

  // Accumulate graph elements across calls. Dedup + touched-flag refresh logic
  // lives in `mergeGraphElements` so it can be unit-tested in isolation.
  const accumulateGraphElements = (newElements: GraphElement[]) => {
    setGraphElements(prev => mergeGraphElements(prev, newElements))
    // Track newly added IDs for highlighting
    const newIds = newElements.map(e => e.data?.id).filter((id): id is string => !!id)
    setHighlightedIds(newIds)
  }

  // Accumulate context events
  const accumulateEvents = (newEvents: ContextEvent[]) => {
    setContextEvents(prev => [...prev, ...newEvents])
  }

  // Clear all graph elements
  const clearGraph = () => {
    setGraphElements([])
    setHighlightedIds([])
  }

  // Clear all events
  const clearEvents = () => {
    setContextEvents([])
    setUnifiedContext(undefined)
  }

  // Wipe per-conversation state. Called by ChatInterface before it hydrates a
  // newly selected sessionId so the graph + observability tabs don't keep
  // showing stale data from the previous thread. Progress state is NOT cleared
  // here — it belongs to the per-session registry, so a still-running stream
  // for the previous thread keeps populating its own controller.
  const resetForNewSession = () => {
    clearGraph()
    clearEvents()
  }

  const handleNewChat = () => {
    resetForNewSession()
    const id = newSessionId()
    setSelectedSessionId(id)
    setPlaceholderSessionId(id)
    setFocusInputToken(t => t + 1)
  }

  const handleSelectThread = (threadId: string) => {
    if (threadId === selectedSessionId()) return
    resetForNewSession()
    setSelectedSessionId(threadId)
    // User picked an existing thread — drop the optimistic row.
    setPlaceholderSessionId(null)
  }

  // Delete one or more conversations (#71). Optimistically prunes the threads
  // cache, fires the server action, then — if the active thread was among the
  // deleted — drops the user into a fresh "+ New Chat" so the main pane never
  // shows a conversation that no longer exists.
  const handleDeleteThreads = async (ids: string[]) => {
    if (ids.length === 0) return
    const toDelete = new Set(ids)
    mutateThreads(list => (list ?? []).filter(t => !toDelete.has(t.id)))
    try {
      await deleteConversations(ids)
    } catch (err) {
      console.error('[index] delete conversations failed:', err)
      // Re-sync from the server so a failed delete doesn't leave the sidebar
      // out of step with persisted state.
      refetchThreads()
    }
    if (toDelete.has(selectedSessionId())) {
      handleNewChat()
    }
  }

  // Once the persisted row for the placeholder lands in the threadsResource,
  // drop the optimistic row so the real one (with its sticky title) takes over.
  createEffect(() => {
    const ph = placeholderSessionId()
    if (!ph) return
    const list = threads() ?? []
    if (list.some(t => t.id === ph)) {
      setPlaceholderSessionId(null)
    }
  })

  // Display threads = optimistic placeholder (if any) on top, then persisted
  // rows, deduped by id. See `mergeThreadsWithPlaceholder` for the rule.
  const displayThreads = createMemo(() =>
    mergeThreadsWithPlaceholder(threads() ?? [], placeholderSessionId())
  )

  // Wrap the supplied unified-context setter so each save also refreshes the
  // sidebar list (titles update once the first user_message lands).
  const handleContextUpdate = (ctx: UnifiedContext) => {
    setUnifiedContext(ctx)
    refetchThreads()
  }

  // Execute Cypher write from graph UI (node edit, relation create)
  const handleCypherWrite = async (cypher: string, params?: Record<string, unknown>) => {
    try {
      await executeCypherWrite(cypher, params)
    } catch (error) {
      console.error('Cypher write failed:', error)
    }
  }

  // Handle data stash actions (hide/unhide/archive/unarchive)
  const handleStashAction = async (eventId: string, action: StashAction) => {
    // Optimistic UI update: mutate local signal immediately
    setContextEvents(prev => prev.map(e => {
      if (e.id !== eventId || e.type !== 'tool_result') return e
      const d = { ...(e.data as ToolResultEventData) }
      if (action === 'hide') d.hidden = true
      if (action === 'unhide') d.hidden = false
      if (action === 'archive') { d.archived = true; d.hidden = false }
      if (action === 'unarchive') d.archived = false
      return { ...e, data: d }
    }))

    // Persist to server
    await fetch('/api/stash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: selectedSessionId(), eventId, action }),
    })
  }

  // Build a set of known entity names/labels from graph elements for chat highlighting
  const graphEntityNames = createMemo(() => {
    const names = new Map<string, string[]>() // name → [id1, id2, ...]
    for (const el of graphElements()) {
      const d = el.data
      if (!d?.id) continue
      const label = d.label as string | undefined
      if (label && !d.source) { // node, not edge
        const existing = names.get(label) ?? []
        existing.push(d.id as string)
        names.set(label, existing)
      }
    }
    // Also index edge labels → edge IDs
    for (const el of graphElements()) {
      const d = el.data
      if (!d?.id || !d.source) continue // skip nodes
      const label = d.label as string | undefined
      if (label) {
        const existing = names.get(label) ?? []
        existing.push(d.id as string)
        names.set(label, existing)
      }
    }
    return names
  })

  return (
    <main h="[calc(100vh-4rem)]">
      <Splitter.Root
        orientation="horizontal"
        defaultSize={[60, 40]}
        panels={[
          { id: 'chat', collapsible: true, minSize: 40, maxSize: 80 },
          { id: 'support', collapsible: true, minSize: 30, maxSize: 60 }
        ]}
        h="full"
      >
        {/* Chat Panel — sidebar lives at this level so thread selection can
            swap the sessionId fed into ChatInterface. */}
        <Splitter.Panel id="chat">
          <div flex="~" h="full">
            <ChatSidebar
              collapsed={sidebarCollapsed()}
              onToggle={() => setSidebarCollapsed(!sidebarCollapsed())}
              threads={displayThreads()}
              selectedId={selectedSessionId()}
              onSelectThread={handleSelectThread}
              onNewChat={handleNewChat}
              onTitleRegenerated={handleTitleUpdated}
              onDeleteThreads={handleDeleteThreads}
            />
            <div flex="1" overflow="hidden">
              <ChatInterface
                sessionId={selectedSessionId()}
                onGraphUpdate={accumulateGraphElements}
                onEventsUpdate={accumulateEvents}
                onContextUpdate={handleContextUpdate}
                onResetForNewSession={resetForNewSession}
                onAgentChangeRequestsNewSession={handleNewChat}
                graphEntityNames={graphEntityNames()}
                onHighlightEntities={setHighlightedIds}
                getProgress={getProgress}
                getRunState={getRunState}
                updateRunState={updateRunState}
                registerAbortController={registerAbortController}
                unregisterAbortController={unregisterAbortController}
                onTitleUpdated={handleTitleUpdated}
                focusInputToken={focusInputToken()}
              />
            </div>
          </div>
        </Splitter.Panel>

        {/* Resize Trigger */}
        <Splitter.ResizeTrigger
          id="chat:support"
          w="2"
          bg="dark-border-primary hover:neon-cyan/50"
          cursor="col-resize"
          transition="all"
          shadow="hover:[0_0_10px_rgba(0,255,255,0.3)]"
        />

        {/* Support Panel (Graph, Stats, Actions, Docs, Tools) */}
        <Splitter.Panel id="support">
          <SupportPanel
            graphElements={graphElements()}
            highlightedIds={highlightedIds()}
            contextEvents={contextEvents()}
            unifiedContext={unifiedContext()}
            onClearGraph={clearGraph}
            onClearEvents={clearEvents}
            onCypherWrite={handleCypherWrite}
            sessionId={selectedSessionId()}
            onStashAction={handleStashAction}
          />
        </Splitter.Panel>
      </Splitter.Root>
    </main>
  )
}
