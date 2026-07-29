import { Splitter } from '@ark-ui/solid/splitter'
import { createSignal, createMemo, createResource, createEffect, onCleanup, onMount } from 'solid-js'
import { ChatInterface } from '~/components/ark-ui/ChatInterface'
import type { Message } from '~/components/ark-ui/ChatMessages'
import { ChatSidebar, mergeThreadsWithPlaceholder } from '~/components/ark-ui/ChatSidebar'
import { SupportPanel, type GraphElement } from '~/components/ark-ui/SupportPanel'
import type { ContextEvent, UnifiedContext, ToolResultEventData } from '~/lib/harness-patterns'
import { executeCypherWrite } from '~/lib/neo4j/write-action'
import { mergeGraphElements } from '~/lib/graph-merge'
import { listConversations, type OpenReferenceTarget } from '~/lib/harness-client'
import { newSessionId } from '~/lib/session-id'
import type { StashAction } from '~/components/ark-ui/DataStashPanel'
import { createChainProgress, type ChainProgressController } from '~/components/ark-ui/useChainProgress'
import { DEFAULT_RUN_STATE, countRunning, type SessionRunState } from '~/lib/run-registry'

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
  // A citation clicked in an assistant message → SupportPanel switches to the
  // Data Stash tab and opens the inline viewer at that reference.
  const [pendingReference, setPendingReference] = createSignal<OpenReferenceTarget | null>(null)
  const [contextEvents, setContextEvents] = createSignal<ContextEvent[]>([])
  const [unifiedContext, setUnifiedContext] = createSignal<UnifiedContext | undefined>(undefined)

  // Block the chat composer while uploaded sources are still embedding, so the
  // user can't query the retriever before its documents are searchable. Tracked
  // here (always mounted) via a light status poll — works even when the Data
  // Stash tab (which also polls) is closed; the list cache keeps polls cheap.
  const [embeddingSources, setEmbeddingSources] = createSignal(false)
  let embedPollTimer: ReturnType<typeof setTimeout> | undefined
  let embedPolls = 0
  const pollEmbedding = async (sid: string) => {
    if (!sid) return
    try {
      const res = await fetch(`/api/stash/upload?sessionId=${encodeURIComponent(sid)}`)
      const body = res.ok ? ((await res.json()) as { documents?: Array<{ ingestStatus?: string }> }) : {}
      if (sid !== selectedSessionId()) return // session switched mid-poll
      const pending = (body.documents ?? []).some((d) => d.ingestStatus === 'pending')
      setEmbeddingSources(pending)
      embedPolls += 1
      // Keep watching while pending (cap ~6 min so a stuck ingest can't block forever).
      if (pending && embedPolls < 120) embedPollTimer = setTimeout(() => void pollEmbedding(sid), 3000)
    } catch {
      setEmbeddingSources(false)
    }
  }
  const watchEmbedding = (sid: string) => {
    if (embedPollTimer) clearTimeout(embedPollTimer)
    embedPolls = 0
    if (sid) void pollEmbedding(sid)
  }
  // Poll on session open (catches a session reopened mid-embed) and after uploads.
  createEffect(() => {
    const sid = selectedSessionId()
    setEmbeddingSources(false)
    watchEmbedding(sid)
  })
  onCleanup(() => {
    if (embedPollTimer) clearTimeout(embedPollTimer)
  })
  // The conversation's selected agent, reported up from ChatInterface, so the
  // Tools panel's code-mode gate tracks the live selection (default until set).
  const [currentAgentId, setCurrentAgentId] = createSignal<string>('default')

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

  // Promotion: flip the row's kind in-place so it moves from Actions to Chats.
  const handlePromoted = (sid: string) => {
    mutateThreads(list =>
      (list ?? []).map(t => (t.id === sid ? { ...t, kind: 'conversation' as const } : t)),
    )
  }

  // Background actions complete off any browser channel, so poll the list while
  // at least one action is still `running` to surface the running→done flip.
  // The effect re-runs on every threads() change; it only arms an interval when
  // a running action exists, and clears it as soon as none remain.
  createEffect(() => {
    const hasRunningAction = (threads() ?? []).some(
      t => t.kind === 'action' && t.status === 'running',
    )
    if (!hasRunningAction) return
    const interval = setInterval(() => refetchThreads(), 5000)
    onCleanup(() => clearInterval(interval))
  })

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

  // How many conversations are streaming right now. Drives the sidebar's
  // header badge and the composer's cap guard (#105 slice 2) — the count is
  // only knowable here, since each ChatInterface sees just its own session.
  const runningCount = createMemo(() => countRunning(runStates()))

  // ---------------------------------------------------------------------------
  // Per-session chat message buffers (#105 slice 1)
  // ---------------------------------------------------------------------------
  // The in-flight turn is NOT persisted until the run ends, so a buffer that
  // lives in ChatInterface's closure is destroyed the moment the user switches
  // threads — the run finishes server-side but the live view never reattaches.
  // Hoisting the buffer here (next to `progressBySession`) means the streaming
  // turn keeps accumulating into its own session's array while the user reads
  // another chat, and switching back just renders it.
  //
  // Buffers for idle sessions are disposable: the hydration effect reloads
  // those from Postgres, which is authoritative once a run has ended. Only a
  // *running* session's buffer is irreplaceable, so `pruneIdleBuffers` keeps
  // the map from growing without bound as the user browses.
  const messagesBySession = new Map<string, ReturnType<typeof createSignal<Message[]>>>()
  const messagesSignal = (sid: string) => {
    let sig = messagesBySession.get(sid)
    if (!sig) {
      sig = createSignal<Message[]>([])
      messagesBySession.set(sid, sig)
    }
    return sig
  }
  const getMessages = (sid: string): Message[] => messagesSignal(sid)[0]()
  const setMessages = (
    sid: string,
    next: Message[] | ((prev: Message[]) => Message[]),
  ) => {
    const set = messagesSignal(sid)[1]
    // Solid reads a bare function argument as an updater — wrap plain arrays.
    if (typeof next === 'function') set(next)
    else set(() => next)
  }
  const pruneIdleBuffers = (keep: string) => {
    const states = runStates()
    for (const sid of [...messagesBySession.keys()]) {
      if (sid === keep || states[sid]?.isProcessing) continue
      messagesBySession.delete(sid)
    }
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
    pruneIdleBuffers(id)
    setSelectedSessionId(id)
    setPlaceholderSessionId(id)
    setFocusInputToken(t => t + 1)
  }

  const handleSelectThread = (threadId: string) => {
    if (threadId === selectedSessionId()) return
    resetForNewSession()
    pruneIdleBuffers(threadId)
    setSelectedSessionId(threadId)
    // User picked an existing thread — drop the optimistic row.
    setPlaceholderSessionId(null)
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
              getRunState={getRunState}
              runningCount={runningCount()}
            />
            <div flex="1" overflow="hidden">
              <ChatInterface
                sessionId={selectedSessionId()}
                onGraphUpdate={accumulateGraphElements}
                onEventsUpdate={accumulateEvents}
                onContextUpdate={handleContextUpdate}
                onResetForNewSession={resetForNewSession}
                onAgentChangeRequestsNewSession={handleNewChat}
                onSelectedAgentChange={setCurrentAgentId}
                graphEntityNames={graphEntityNames()}
                onHighlightEntities={setHighlightedIds}
                onOpenReference={setPendingReference}
                embeddingSources={embeddingSources()}
                getProgress={getProgress}
                getRunState={getRunState}
                updateRunState={updateRunState}
                getMessages={getMessages}
                setMessages={setMessages}
                runningCount={runningCount()}
                registerAbortController={registerAbortController}
                unregisterAbortController={unregisterAbortController}
                onTitleUpdated={handleTitleUpdated}
                onPromoted={handlePromoted}
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
            agentId={currentAgentId()}
            onStashAction={handleStashAction}
            pendingReference={pendingReference()}
            onUploaded={() => watchEmbedding(selectedSessionId())}
          />
        </Splitter.Panel>
      </Splitter.Root>
    </main>
  )
}
