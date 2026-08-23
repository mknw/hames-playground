import { Splitter } from '@ark-ui/solid/splitter'
import {
  createSignal,
  createMemo,
  createResource,
  createEffect,
  onCleanup,
  onMount,
} from 'solid-js'
import { ChatInterface } from '~/components/ark-ui/ChatInterface'
import type { Message } from '~/components/ark-ui/ChatMessages'
import { ChatSidebar, mergeThreadsWithPlaceholder } from '~/components/ark-ui/ChatSidebar'
import { SupportPanel, type GraphElement } from '~/components/ark-ui/SupportPanel'
import type { ContextEvent, UnifiedContext, ToolResultEventData } from '~/lib/harness-patterns'
import { mergeGraphElements } from '~/lib/graph-merge'
import { isEdgeElement, isNodeElement } from '~/lib/harness-client/graph-extractor'
import {
  listConversations,
  deleteConversationsBulk,
  type OpenReferenceTarget,
} from '~/lib/harness-client'
import { newSessionId } from '~/lib/session-id'
import type { StashAction } from '~/components/ark-ui/DataStashPanel'
import {
  createChainProgress,
  type ChainProgressController,
} from '~/components/ark-ui/useChainProgress'
import {
  DEFAULT_RUN_STATE,
  COMPLETION_FLASH_MS,
  countRunning,
  type CompletionMark,
  type RunOutcome,
  type SessionRunState,
} from '~/lib/run-registry'

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

  const [highlightedIds, setHighlightedIds] = createSignal<string[]>([])
  // A citation clicked in an assistant message → SupportPanel switches to the
  // Data Stash tab and opens the inline viewer at that reference.
  const [pendingReference, setPendingReference] = createSignal<OpenReferenceTarget | null>(null)

  // ---------------------------------------------------------------------------
  // Per-session panel state (SA-H8)
  // ---------------------------------------------------------------------------
  // Graph elements, the observability event stream and the unified context used
  // to be three route-level singletons shared by every thread, on the
  // assumption that only the thread on screen produces them. Two things break
  // that: a run keeps streaming after the user switches away, and the hydration
  // effect in ChatInterface deliberately early-returns for a session that is
  // still processing (it must not wipe a live buffer, #105) — so
  // `onResetForNewSession` never fires on the way back in. Run A, switch to B,
  // return to A, and A's live events appended onto B's panels: a graph and a
  // timeline mixing two conversations, with no indication of it.
  //
  // The fix is the one #105 already applied to chat buffers: address the state
  // by session id and let each thread accumulate its own. The panels then read
  // the *displayed* session and nothing else.
  const eventsBySession = new Map<string, ReturnType<typeof createSignal<ContextEvent[]>>>()
  const graphBySession = new Map<string, ReturnType<typeof createSignal<GraphElement[]>>>()
  const contextBySession = new Map<
    string,
    ReturnType<typeof createSignal<UnifiedContext | undefined>>
  >()

  const eventsSignal = (sid: string) => {
    let sig = eventsBySession.get(sid)
    if (!sig) {
      sig = createSignal<ContextEvent[]>([])
      eventsBySession.set(sid, sig)
    }
    return sig
  }
  const graphSignal = (sid: string) => {
    let sig = graphBySession.get(sid)
    if (!sig) {
      sig = createSignal<GraphElement[]>([])
      graphBySession.set(sid, sig)
    }
    return sig
  }
  const contextSignal = (sid: string) => {
    let sig = contextBySession.get(sid)
    if (!sig) {
      sig = createSignal<UnifiedContext | undefined>(undefined)
      contextBySession.set(sid, sig)
    }
    return sig
  }

  // What the panels render: always the session currently on screen.
  const contextEvents = () => eventsSignal(selectedSessionId())[0]()
  const graphElements = () => graphSignal(selectedSessionId())[0]()
  const unifiedContext = () => contextSignal(selectedSessionId())[0]()

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
      const body = res.ok
        ? ((await res.json()) as { documents?: Array<{ ingestStatus?: string }> })
        : {}
      if (sid !== selectedSessionId()) return // session switched mid-poll
      const pending = (body.documents ?? []).some((d) => d.ingestStatus === 'pending')
      setEmbeddingSources(pending)
      embedPolls += 1
      // Keep watching while pending (cap ~6 min so a stuck ingest can't block forever).
      if (pending && embedPolls < 120)
        embedPollTimer = setTimeout(() => void pollEmbedding(sid), 3000)
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
  // agent-aware support panels track the live selection (default until set).
  const [currentAgentId, setCurrentAgentId] = createSignal<string>('default')

  // Sidebar threads — refetched after each turn completes (see onContextUpdate).
  // `mutate` is exposed so the `title_updated` SSE event can patch a single
  // row's title in-place without re-querying the full list (the server already
  // gave us the new title in the event payload).
  //
  // IMPORTANT: read via `threads.latest`, never `threads()` (#105). The app
  // root wraps routes in an empty-fallback <Suspense>; a plain read
  // re-registers with that boundary on every `refetchThreads()`, detaching
  // the ENTIRE route for the duration of the DB query — a blank flash that
  // drops composer focus and chat scroll (typed text survives because the
  // nodes are re-attached, not recreated). `latest` returns the stale list
  // without touching Suspense once a first value exists; the initial page
  // load still suspends as before.
  const [threads, { refetch: refetchThreads, mutate: mutateThreads }] = createResource(() =>
    listConversations(),
  )

  // Push-driven title update from the SSE stream — the server emits a
  // `title_updated` event after the LLM title generator resolves. We splice
  // the new title into the threads cache; no refetch needed.
  const handleTitleUpdated = (sid: string, title: string) => {
    mutateThreads((list) => (list ?? []).map((t) => (t.id === sid ? { ...t, title } : t)))
  }

  // Promotion: flip the row's kind in-place so it moves from Actions to Chats.
  const handlePromoted = (sid: string) => {
    mutateThreads((list) =>
      (list ?? []).map((t) => (t.id === sid ? { ...t, kind: 'conversation' as const } : t)),
    )
  }

  // Background actions complete off any browser channel, so poll the list while
  // at least one action is still `running` to surface the running→done flip.
  // The effect re-runs on every threads() change; it only arms an interval when
  // a running action exists, and clears it as soon as none remain.
  createEffect(() => {
    const hasRunningAction = (threads.latest ?? []).some(
      (t) => t.kind === 'action' && t.status === 'running',
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
    setRunStates((prev) => ({
      ...prev,
      [sid]: { ...DEFAULT_RUN_STATE, ...prev[sid], ...patch },
    }))
  }

  // How many conversations are streaming right now. Drives the composer's
  // cap guard (#105 slice 2) — the count is only knowable here, since each
  // ChatInterface sees just its own session.
  const runningCount = createMemo(() => countRunning(runStates()))

  // ---------------------------------------------------------------------------
  // Completion marks (#105)
  // ---------------------------------------------------------------------------
  // With several conversations running at once, a run landing in a thread the
  // user isn't looking at is otherwise silent. Mark the row: it flashes once,
  // then holds a quiet accent border until the thread is opened.
  const [completions, setCompletions] = createSignal<Record<string, CompletionMark>>({})
  const getCompletion = (sid: string): CompletionMark | undefined => completions()[sid]
  const flashTimers = new Map<string, ReturnType<typeof setTimeout>>()

  const clearCompletion = (sid: string) => {
    const timer = flashTimers.get(sid)
    if (timer) {
      clearTimeout(timer)
      flashTimers.delete(sid)
    }
    setCompletions((prev) => {
      if (!(sid in prev)) return prev
      const next = { ...prev }
      delete next[sid]
      return next
    })
  }

  // First SSE event of a run — the early-persisted row is now in Postgres, so
  // a refetch surfaces the new conversation (derived title + live indicator)
  // while it is still streaming. Replaces the placeholder in the same pass.
  const handleRunStarted = (_sid: string) => {
    refetchThreads()
  }

  const handleRunSettled = (sid: string, outcome: RunOutcome) => {
    // Refetch regardless of which thread is in view: the run's final save
    // bumped title/status server-side, and for a backgrounded new chat this
    // is what makes it appear at all if the start-refetch was missed.
    refetchThreads()
    // The user watched this one land — nothing to announce, and a mark here
    // would just need dismissing.
    if (sid === selectedSessionId()) return
    const existing = flashTimers.get(sid)
    if (existing) clearTimeout(existing)
    setCompletions((prev) => ({ ...prev, [sid]: { outcome, flashing: true } }))
    flashTimers.set(
      sid,
      setTimeout(() => {
        flashTimers.delete(sid)
        // Decay to the static border; the mark itself survives until visited.
        setCompletions((prev) =>
          sid in prev ? { ...prev, [sid]: { ...prev[sid], flashing: false } } : prev,
        )
      }, COMPLETION_FLASH_MS),
    )
  }

  onCleanup(() => {
    for (const timer of flashTimers.values()) clearTimeout(timer)
    flashTimers.clear()
  })

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
  const setMessages = (sid: string, next: Message[] | ((prev: Message[]) => Message[])) => {
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
  // Explicit user cancel from the composer's Stop control (SA-M11). Aborting
  // only tears down the browser's half of the stream — the chain keeps running
  // server-side and persists its result, which is what the bubble the composer
  // leaves behind says.
  const abortSession = (sid: string) => {
    const ac = abortControllers.get(sid)
    if (!ac) return
    try {
      ac.abort()
    } catch {
      /* already settled */
    }
  }

  onMount(() => {
    const onUnload = () => {
      for (const ac of abortControllers.values()) {
        try {
          ac.abort()
        } catch {
          /* ignore */
        }
      }
      abortControllers.clear()
    }
    window.addEventListener('beforeunload', onUnload)
    onCleanup(() => window.removeEventListener('beforeunload', onUnload))
  })

  // Accumulate graph elements for one session. Dedup + touched-flag refresh
  // logic lives in `mergeGraphElements` so it can be unit-tested in isolation.
  const accumulateGraphElements = (sid: string, newElements: GraphElement[]) => {
    graphSignal(sid)[1]((prev) => mergeGraphElements(prev, newElements))
    // Highlighting is view state, not per-session data: only a batch landing in
    // the thread on screen should move the highlight.
    if (sid !== selectedSessionId()) return
    const newIds = newElements.map((e) => e.data?.id).filter((id): id is string => !!id)
    setHighlightedIds(newIds)
  }

  // Accumulate context events for one session.
  const accumulateEvents = (sid: string, newEvents: ContextEvent[]) => {
    eventsSignal(sid)[1]((prev) => [...prev, ...newEvents])
  }

  const setSessionContext = (sid: string, ctx: UnifiedContext) => {
    contextSignal(sid)[1](() => ctx)
  }

  // Clear one session's graph.
  const clearGraph = (sid: string = selectedSessionId()) => {
    graphSignal(sid)[1](() => [])
    if (sid === selectedSessionId()) setHighlightedIds([])
  }

  // Clear one session's events + context.
  const clearEvents = (sid: string = selectedSessionId()) => {
    eventsSignal(sid)[1](() => [])
    contextSignal(sid)[1](() => undefined)
  }

  // Wipe one conversation's panel state. Called by ChatInterface before it
  // hydrates a session, so a rehydration replaces rather than appends. Progress
  // state is NOT cleared here — it belongs to the per-session registry, so a
  // still-running stream for another thread keeps populating its own
  // controller.
  const resetForNewSession = (sid: string) => {
    clearGraph(sid)
    clearEvents(sid)
  }

  // Panel state for an idle session is disposable — ChatInterface reloads it
  // from the persisted context on the next visit — so it is pruned alongside
  // the chat buffers. A *running* session's buffers are the only live copy and
  // are never dropped.
  const prunePanelState = (keep: string) => {
    const states = runStates()
    for (const map of [eventsBySession, graphBySession, contextBySession]) {
      for (const sid of [...map.keys()]) {
        if (sid === keep || states[sid]?.isProcessing) continue
        map.delete(sid)
      }
    }
  }

  const handleNewChat = () => {
    const id = newSessionId()
    // A fresh id has no panel state to clear; what matters is not clearing the
    // outgoing thread's (it may still be streaming into it).
    pruneIdleBuffers(id)
    prunePanelState(id)
    setSelectedSessionId(id)
    setPlaceholderSessionId(id)
    setFocusInputToken((t) => t + 1)
  }

  const handleSelectThread = (threadId: string) => {
    if (threadId === selectedSessionId()) return
    // Opening the thread is the acknowledgement — drop its completion mark.
    clearCompletion(threadId)
    pruneIdleBuffers(threadId)
    prunePanelState(threadId)
    setSelectedSessionId(threadId)
    // User picked an existing thread — drop the optimistic row.
    setPlaceholderSessionId(null)
  }

  // Delete conversations (#71). The sidebar owns the confirm UX; this owns
  // the mutation because the per-session registries live here. The cache is
  // patched from the server's RETURNING list (ground truth), batched once.
  // Running rows never reach this path — the sidebar hides their delete
  // affordance and select-mode skips them — so every cleaned-up registry
  // entry is idle by construction.
  const handleDeleteThreads = async (ids: string[]) => {
    const { deleted } = await deleteConversationsBulk(ids)
    if (deleted.length === 0) return
    const gone = new Set(deleted)
    mutateThreads((list) => (list ?? []).filter((t) => !gone.has(t.id)))
    for (const id of deleted) {
      messagesBySession.delete(id)
      progressBySession.delete(id)
      eventsBySession.delete(id)
      graphBySession.delete(id)
      contextBySession.delete(id)
      clearCompletion(id)
      abortControllers.delete(id)
    }
    setRunStates((prev) => {
      if (!deleted.some((id) => id in prev)) return prev
      const next = { ...prev }
      for (const id of deleted) delete next[id]
      return next
    })
    // If the open conversation was deleted, land somewhere sensible: the
    // most recent remaining thread, or a fresh chat when none are left.
    if (gone.has(selectedSessionId())) {
      const remaining = (threads.latest ?? []).filter((t) => !gone.has(t.id))
      if (remaining.length > 0) handleSelectThread(remaining[0].id)
      else handleNewChat()
    }
  }

  // Once the persisted row for the placeholder lands in the threadsResource,
  // drop the optimistic row so the real one (with its sticky title) takes over.
  createEffect(() => {
    const ph = placeholderSessionId()
    if (!ph) return
    const list = threads.latest ?? []
    if (list.some((t) => t.id === ph)) {
      setPlaceholderSessionId(null)
    }
  })

  // Display threads = optimistic placeholder (if any) on top, then persisted
  // rows, deduped by id. See `mergeThreadsWithPlaceholder` for the rule.
  const displayThreads = createMemo(() =>
    mergeThreadsWithPlaceholder(threads.latest ?? [], placeholderSessionId()),
  )

  // Wrap the supplied unified-context setter so each save also refreshes the
  // sidebar list (titles update once the first user_message lands).
  const handleContextUpdate = (sid: string, ctx: UnifiedContext) => {
    setSessionContext(sid, ctx)
    refetchThreads()
  }

  // Handle data stash actions (hide/unhide/archive/unarchive). The panel only
  // ever shows the displayed session, so that is the buffer this patches.
  const handleStashAction = async (eventId: string, action: StashAction) => {
    const sid = selectedSessionId()
    // Optimistic UI update: mutate local signal immediately
    eventsSignal(sid)[1]((prev) =>
      prev.map((e) => {
        if (e.id !== eventId || e.type !== 'tool_result') return e
        const d = { ...(e.data as ToolResultEventData) }
        if (action === 'hide') d.hidden = true
        if (action === 'unhide') d.hidden = false
        if (action === 'archive') {
          d.archived = true
          d.hidden = false
        }
        if (action === 'unarchive') d.archived = false
        return { ...e, data: d }
      }),
    )

    // Persist to server
    await fetch('/api/stash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sid, eventId, action }),
    })
  }

  // Build a set of known entity names/labels from graph elements for chat
  // highlighting. Nodes are indexed first so a name that is both a node label
  // and a relationship type resolves to the node's id first; node-vs-edge is
  // read off the extractor's explicit `data.kind` stamp rather than guessed
  // from a `source` key (SA-M12).
  const graphEntityNames = createMemo(() => {
    const names = new Map<string, string[]>() // name → [id1, id2, ...]
    const index = (el: GraphElement) => {
      const d = el.data
      if (!d?.id) return
      const label = d.label as string | undefined
      if (!label) return
      const existing = names.get(label) ?? []
      existing.push(d.id as string)
      names.set(label, existing)
    }
    for (const el of graphElements()) if (isNodeElement(el)) index(el)
    for (const el of graphElements()) if (isEdgeElement(el)) index(el)
    return names
  })

  return (
    <main h="[calc(100vh-4rem)]">
      <Splitter.Root
        orientation="horizontal"
        defaultSize={[60, 40]}
        panels={[
          { id: 'chat', collapsible: true, minSize: 40, maxSize: 80 },
          { id: 'support', collapsible: true, minSize: 30, maxSize: 60 },
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
              getProgress={getProgress}
              getCompletion={getCompletion}
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
                onRunStarted={handleRunStarted}
                onRunSettled={handleRunSettled}
                registerAbortController={registerAbortController}
                unregisterAbortController={unregisterAbortController}
                abortSession={abortSession}
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
            onClearGraph={() => clearGraph()}
            onClearEvents={() => clearEvents()}
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
