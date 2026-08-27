import { Splitter } from '@ark-ui/solid/splitter'
import { createSignal, createMemo, createEffect, onCleanup, onMount } from 'solid-js'
import { useSearchParams } from '@solidjs/router'
import { ChatInterface } from '~/components/ark-ui/ChatInterface'
import { ChatSidebar, mergeThreadsWithPlaceholder } from '~/components/ark-ui/ChatSidebar'
import { SupportPanel, type GraphElement } from '~/components/ark-ui/SupportPanel'
import type { UnifiedContext, ToolResultEventData } from '~/lib/harness-patterns'
import { isEdgeElement, isNodeElement } from '~/lib/harness-client/graph-extractor'
import type { OpenReferenceTarget } from '~/lib/harness-client'
import { newSessionId } from '~/lib/session-id'
import { CONVERSATION_PARAM } from '~/lib/share-link'
import type { StashAction } from '~/components/ark-ui/DataStashPanel'
import { applyToolResultAction } from '~/lib/api-client'
import { hasPendingIngest, refreshDocuments } from '~/lib/stash-documents'
import { createSessionRegistry } from '~/lib/session-registry'
import { SessionRegistryContext } from '~/lib/session-registry-context'
import { createThreadListStore } from '~/lib/thread-list-store'
import type { RunOutcome } from '~/lib/run-registry'

export default function Home() {
  // ---------------------------------------------------------------------------
  // The route composes three stores and renders three panels. It owns only
  // *view* state — which conversation is on screen and what the panels are
  // showing. Everything keyed by a session id lives in `SessionRegistry`
  // (#226 B1); everything about the conversation *list* lives in
  // `ThreadListStore`.
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // The conversation on screen lives in the URL (`/?c=<id>`), so it can be
  // bookmarked, reloaded and sent to a colleague — who, if signed out, goes
  // through sign-in and comes back to this exact conversation (`AuthProvider`
  // carries the target; `lib/auth/return-to.ts` decides what is a safe one).
  //
  // A SEARCH parameter rather than a path segment, and that is a lifetime
  // decision rather than a cosmetic one — see `CONVERSATION_PARAM`. In short:
  // this component owns the `SessionRegistry`, a run deliberately keeps filling
  // its own conversation after the user switches threads (#47 / #105), and
  // moving between two file routes would unmount the component and take that
  // registry — and the live view of everything still running — with it. A
  // search parameter changes on the same mounted route.
  //
  // The id is READ from the URL rather than mirrored into a signal, so the
  // browser's own back and forward buttons move between conversations for free
  // and there is no second copy to fall out of step. `fallbackSessionId` covers
  // the one case the URL cannot: a bare `/`, which is a brand-new chat whose id
  // nothing has any reason to know yet. It gains a URL the moment its first run
  // starts (`handleRunStarted`).
  // ---------------------------------------------------------------------------
  const [searchParams, setSearchParams] = useSearchParams<{ c?: string }>()
  const [fallbackSessionId, setFallbackSessionId] = createSignal(newSessionId())
  const selectedSessionId = createMemo(() => {
    // `useSearchParams` hands back `string | string[] | undefined`: a URL with
    // `?c=a&c=b` is an array, and taking the first is the only reading that is
    // not a crash or a lie.
    const raw = searchParams[CONVERSATION_PARAM]
    const fromUrl = Array.isArray(raw) ? raw[0] : raw
    return fromUrl ? fromUrl : fallbackSessionId()
  })

  /** Put a conversation in the URL. `replace` is for the case where the user
   *  did not navigate — a fresh chat acquiring an id — so it does not become a
   *  history entry they have to press Back through. */
  const goToConversation = (id: string, options: { replace?: boolean } = {}) => {
    setSearchParams({ [CONVERSATION_PARAM]: id }, { replace: options.replace ?? false })
  }

  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false)

  // Optimistic placeholder for a freshly-minted "+ New Chat" id that hasn't
  // been persisted yet (see #44). Cleared once the real row arrives in the
  // thread list, or when the user picks an existing thread.
  const [placeholderSessionId, setPlaceholderSessionId] = createSignal<string | null>(null)

  // Monotonic token: each `+ New Chat` click bumps it, the ChatInput effect
  // focuses the textarea so the user can start typing without an extra click.
  const [focusInputToken, setFocusInputToken] = createSignal(0)

  const [highlightedIds, setHighlightedIds] = createSignal<string[]>([])
  // A citation clicked in an assistant message → SupportPanel switches to the
  // Data Stash tab and opens the inline viewer at that reference.
  const [pendingReference, setPendingReference] = createSignal<OpenReferenceTarget | null>(null)

  // The conversation's selected agent, reported up from ChatInterface, so the
  // agent-aware support panels track the live selection (the default agent
  // until set).
  const [currentAgentId, setCurrentAgentId] = createSignal<string>('search')

  // ---------------------------------------------------------------------------
  // Stores
  // ---------------------------------------------------------------------------
  const registry = createSessionRegistry()
  onCleanup(() => registry.destroy())

  const threadList = createThreadListStore({
    placeholderId: placeholderSessionId,
    setPlaceholderId: setPlaceholderSessionId,
  })

  // Highlighting is view state scoped to the conversation on screen: ids from
  // the outgoing thread mean nothing in the incoming one's graph. (This used
  // to ride along on the hydration wipe, which skipped a still-running thread.)
  createEffect(() => {
    selectedSessionId()
    setHighlightedIds([])
  })

  // What the panels render: always the session currently on screen.
  const contextEvents = () => registry.events(selectedSessionId())
  const graphElements = () => registry.graph(selectedSessionId())
  const unifiedContext = () => registry.context(selectedSessionId())

  // Display threads = optimistic placeholder (if any) on top, then persisted
  // rows, deduped by id. See `mergeThreadsWithPlaceholder` for the rule.
  const displayThreads = createMemo(() =>
    mergeThreadsWithPlaceholder(threadList.threads(), placeholderSessionId()),
  )

  // ---------------------------------------------------------------------------
  // Embedding gate
  // ---------------------------------------------------------------------------
  // Block the chat composer while uploaded sources are still embedding, so the
  // user can't query the retriever before its documents are searchable. Tracked
  // here (always mounted) via a light status poll — works even when the Data
  // Stash tab (which also polls) is closed. Both pollers now go through
  // `stash-documents`, so they coalesce onto one request and warm one cache
  // (#226 B4).
  const [embeddingSources, setEmbeddingSources] = createSignal(false)
  let embedPollTimer: ReturnType<typeof setTimeout> | undefined
  let embedPolls = 0
  const pollEmbedding = async (sid: string) => {
    if (!sid) return
    try {
      const documents = await refreshDocuments(sid)
      if (sid !== selectedSessionId()) return // session switched mid-poll
      const pending = hasPendingIngest(documents)
      setEmbeddingSources(pending)
      embedPolls += 1
      // Keep watching while pending (cap ~6 min so a stuck ingest can't block forever).
      if (pending && embedPolls < 120)
        embedPollTimer = setTimeout(() => void pollEmbedding(sid), 3000)
    } catch {
      // A poll that cannot reach the server must not leave the composer
      // blocked — the user can always retry the question.
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

  // ---------------------------------------------------------------------------
  // Run lifecycle → thread list
  // ---------------------------------------------------------------------------
  // First SSE event of a run — the early-persisted row is now in Postgres, so
  // a refetch surfaces the new conversation (derived title + live indicator)
  // while it is still streaming. Replaces the placeholder in the same pass.
  const handleRunStarted = (sid: string) => {
    threadList.refetch()
    // A chat opened at a bare `/` now has a row, so it now has a URL. Recorded
    // with `replace`: the user pressed Send, not Back, and a history entry here
    // would make Back return them to the same conversation with its id removed.
    if (sid === selectedSessionId() && !searchParams[CONVERSATION_PARAM]) {
      goToConversation(sid, { replace: true })
    }
  }

  const handleRunSettled = (sid: string, outcome: RunOutcome) => {
    // Refetch regardless of which thread is in view: the run's final save
    // bumped title/status server-side, and for a backgrounded new chat this
    // is what makes it appear at all if the start-refetch was missed.
    threadList.refetch()
    // The user watched this one land — nothing to announce, and a mark here
    // would just need dismissing.
    if (sid === selectedSessionId()) return
    registry.markCompleted(sid, outcome)
  }

  // Wrap the session's unified-context setter so each save also refreshes the
  // sidebar list (titles update once the first user_message lands).
  const handleContextUpdate = (sid: string, ctx: UnifiedContext) => {
    registry.setContext(sid, ctx)
    threadList.refetch()
  }

  onMount(() => {
    const onUnload = () => registry.abortAll()
    window.addEventListener('beforeunload', onUnload)
    onCleanup(() => window.removeEventListener('beforeunload', onUnload))
  })

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------
  const handleNewChat = () => {
    const id = newSessionId()
    // A fresh id has no state to clear; what matters is not clearing the
    // outgoing thread's (it may still be streaming into it).
    registry.pruneIdle(id)
    setFallbackSessionId(id)
    goToConversation(id)
    threadList.showPlaceholder(id)
    setFocusInputToken((t) => t + 1)
  }

  const handleSelectThread = (threadId: string) => {
    if (threadId === selectedSessionId()) return
    // Opening the thread is the acknowledgement — drop its completion mark.
    registry.clearCompletion(threadId)
    registry.pruneIdle(threadId)
    goToConversation(threadId)
    // User picked an existing thread — drop the optimistic row.
    threadList.clearPlaceholder()
  }

  // Delete conversations (#71). The sidebar owns the confirm UX; the list
  // store owns the mutation and the thread cache, and the registry forgets
  // every per-session slot in one call. Running rows never reach this path —
  // the sidebar hides their delete affordance and select-mode skips them.
  const handleDeleteThreads = async (ids: string[]) => {
    const deleted = await threadList.remove(ids)
    if (deleted.length === 0) return
    registry.dispose(deleted)
    // If the open conversation was deleted, land somewhere sensible: the
    // most recent remaining thread, or a fresh chat when none are left.
    const gone = new Set(deleted)
    if (gone.has(selectedSessionId())) {
      const remaining = threadList.threads().filter((t) => !gone.has(t.id))
      if (remaining.length > 0) handleSelectThread(remaining[0].id)
      else handleNewChat()
    }
  }

  // ---------------------------------------------------------------------------
  // Panel actions
  // ---------------------------------------------------------------------------
  const clearGraph = () => {
    registry.clearGraph(selectedSessionId())
    setHighlightedIds([])
  }

  // Handle data stash actions (hide/unhide/archive/unarchive). The panel only
  // ever shows the displayed session, so that is the buffer this patches.
  const handleStashAction = async (eventId: string, action: StashAction) => {
    const sid = selectedSessionId()
    // Optimistic UI update: mutate the session's event buffer immediately.
    registry.mapEvents(sid, (e) => {
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
    })

    await applyToolResultAction(sid, eventId, action)
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
    <SessionRegistryContext.Provider value={registry}>
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
                onTitleRegenerated={threadList.applyTitle}
                onDeleteThreads={handleDeleteThreads}
              />
              <div flex="1" overflow="hidden">
                <ChatInterface
                  sessionId={selectedSessionId()}
                  onContextUpdate={handleContextUpdate}
                  onAgentChangeRequestsNewSession={handleNewChat}
                  onSelectedAgentChange={setCurrentAgentId}
                  graphEntityNames={graphEntityNames()}
                  onHighlightEntities={setHighlightedIds}
                  onOpenReference={setPendingReference}
                  embeddingSources={embeddingSources()}
                  onRunStarted={handleRunStarted}
                  onRunSettled={handleRunSettled}
                  onTitleUpdated={threadList.applyTitle}
                  onPromoted={threadList.markPromoted}
                  focusInputToken={focusInputToken()}
                />
              </div>
            </div>
          </Splitter.Panel>

          {/* Resize Trigger */}
          <Splitter.ResizeTrigger
            id="chat:support"
            w="2"
            bg="ui-border-primary hover:ui-accent/50"
            cursor="col-resize"
            transition="all"
            shadow="hover:[0_0_10px_rgba(0,255,255,0.3)]"
          />

          {/* Support Panel (Graph, Context manager, Data, Terminal, Actions, Docs) */}
          <Splitter.Panel id="support">
            <SupportPanel
              graphElements={graphElements()}
              highlightedIds={highlightedIds()}
              contextEvents={contextEvents()}
              unifiedContext={unifiedContext()}
              onClearGraph={clearGraph}
              onClearEvents={() => registry.clearEvents(selectedSessionId())}
              sessionId={selectedSessionId()}
              agentId={currentAgentId()}
              onStashAction={handleStashAction}
              pendingReference={pendingReference()}
              onUploaded={() => watchEmbedding(selectedSessionId())}
            />
          </Splitter.Panel>
        </Splitter.Root>
      </main>
    </SessionRegistryContext.Provider>
  )
}
