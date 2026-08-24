/**
 * ChatInterface Component
 *
 * Main chat interface that coordinates:
 * - User message input
 * - Agent processing via server actions
 * - Message display with tool calls
 * - Graph visualization updates
 * - Agent selection
 * - Context event streaming for observability
 *
 * Architecture:
 * - Uses harness-client server actions
 * - ContextEvents streamed to parent for observability
 * - Per-session progress + run state lives in the parent route — see #47.
 *   The fetch loop captures `runSessionId` at submit time and routes ingest
 *   calls into the correct controller even after the user switches threads.
 */

import { createSignal, createEffect, createMemo, untrack, Show } from 'solid-js'
import { ChatMessages, type Message } from './ChatMessages'
import { ChatInput } from './ChatInput'
import { AgentSelector } from './AgentSelector'
import { LiveProgressBar } from './LiveProgressBar'
import type { ChainProgressController } from './useChainProgress'
import {
  approveAction,
  rejectAction,
  promoteAction,
  loadConversation,
  extractGraphFromResult,
  extractGraphElements,
  extractReferences,
  type OpenReferenceTarget,
} from '~/lib/harness-client'
// Imported from the module rather than the barrel: `replay.ts` is deliberately
// dependency-free (no server-only imports), and the live stream handler wants
// exactly that guarantee.
import { errorBubble } from '~/lib/harness-client/replay'
import { getSettings } from '~/lib/settings-store'
import { parseChatStream, type DoneEventData } from '~/lib/sse-client'
import type { GraphElement } from './SupportPanel'
import type {
  ContextEvent,
  UnifiedContext,
  ControllerActionEventData,
  ErrorEventData,
} from '~/lib/harness-patterns'
import {
  capReachedMessage,
  isAtConcurrencyCap,
  type RunOutcome,
  type SessionRunState,
} from '~/lib/run-registry'

// ============================================================================
// Types
// ============================================================================

// Run-state shape moved to `~/lib/run-registry` so the sidebar can consume it
// without importing this component. Re-exported for existing callers.
export type { SessionRunState }

export interface ChatInterfaceProps {
  /** Session ID for server-side state (shared with SupportPanel for stash actions).
   *  When this changes, ChatInterface hydrates messages from persisted history. */
  sessionId: string
  // Panel updates are addressed by session id (SA-H8), the same way chat
  // buffers are (#105). A run that continues after the user switches threads
  // keeps filling its OWN session's graph and event stream instead of either
  // being dropped or leaking into whichever thread is on screen.
  onGraphUpdate?: (sessionId: string, elements: GraphElement[]) => void
  onEventsUpdate?: (sessionId: string, events: ContextEvent[]) => void
  onContextUpdate?: (sessionId: string, ctx: UnifiedContext) => void
  /** Called before hydration so the parent can clear that session's
   *  graph/event signals before they are repopulated. */
  onResetForNewSession?: (sessionId: string) => void
  /** Called when the user changes agent — parent should mint a fresh sessionId so
   *  the new agent gets its own conversation row rather than overwriting an existing one. */
  onAgentChangeRequestsNewSession?: () => void
  /** Reports the conversation's selected agent (initial, on load, and on change)
   *  so the parent can drive agent-aware UI. */
  onSelectedAgentChange?: (agentId: string) => void
  /** Map of entity/relation names → graph element IDs for interactive highlighting */
  graphEntityNames?: Map<string, string[]>
  /** Callback to highlight specific graph element IDs */
  onHighlightEntities?: (ids: string[]) => void
  /** Open the inline file viewer for a citation clicked in an assistant message. */
  onOpenReference?: (target: OpenReferenceTarget) => void
  /** True while uploaded sources are still embedding — blocks the composer so the
   *  user can't query the retriever before its documents are searchable. */
  embeddingSources?: boolean
  // ---- Per-session progress + run state (lives in the route, see #47) ----
  getProgress: (sessionId: string) => ChainProgressController
  getRunState: (sessionId: string) => SessionRunState
  updateRunState: (sessionId: string, patch: Partial<SessionRunState>) => void
  registerAbortController: (sessionId: string, ac: AbortController) => void
  unregisterAbortController: (sessionId: string) => void
  /** Abort the in-flight SSE stream for a session. The route owns the
   *  controller map, so it owns the abort; this is what the composer's Stop
   *  control calls (SA-M11). */
  abortSession?: (sessionId: string) => void
  /** Per-session chat buffer, owned by the route (#105). Reads/writes are
   *  always addressed by session id so a backgrounded run keeps filling its
   *  own thread while the user reads another one. */
  getMessages: (sessionId: string) => Message[]
  setMessages: (sessionId: string, next: Message[] | ((prev: Message[]) => Message[])) => void
  /** How many sessions are streaming right now, across the whole route.
   *  Only the route can know this — used for the concurrency cap (#105). */
  runningCount: number
  /** Fired once per run, on the first SSE event. By then the server has
   *  persisted the conversation row (the early save in `runTurn` strictly
   *  precedes event emission), so the route can refetch the sidebar and the
   *  new thread appears with its derived title while still streaming (#105). */
  onRunStarted?: (sessionId: string) => void
  /** Fired when a run finishes, with how it ended. The route marks the
   *  thread so a run that lands while the user is elsewhere is visible
   *  (#105). Not fired for an abort — that's page teardown. */
  onRunSettled?: (sessionId: string, outcome: RunOutcome) => void
  /** Push-driven sidebar title update — fired when the server emits a
   *  `title_updated` SSE event after the first-turn LLM title resolves.
   *  Route patches its threads cache in-place; no refetch required. */
  onTitleUpdated?: (sessionId: string, title: string) => void
  /** Fired after an action is promoted to a conversation (the user confirmed
   *  sending into it). The parent flips the row's `kind` in its threads cache
   *  so it moves from the Actions segment to Chats. */
  onPromoted?: (sessionId: string) => void
  /** Monotonic token forwarded to ChatInput — every change focuses the
   *  composer textarea (used to land focus there after `+ New Chat`). */
  focusInputToken?: number
}

const WELCOME_MESSAGE: Message = {
  id: 'welcome',
  role: 'assistant',
  content:
    "Hello! I'm your knowledge assistant. I can help you:\n\n- Query and explore your Knowledge Base\n- Create new observations\n- Analyze patterns and connections\n- Use additional tools\n\nSelect an agent from the dropdown above, then ask me anything!",
  timestamp: new Date(),
}

// ============================================================================
// Component
// ============================================================================

export const ChatInterface = (props: ChatInterfaceProps) => {
  // Chat buffer for the *displayed* session. The underlying arrays are owned
  // by the route (one per session), so an in-flight turn survives the user
  // switching threads — see #105. Writes that belong to a specific run always
  // address `runSessionId` explicitly rather than going through this setter.
  const messages = () => props.getMessages(props.sessionId)
  const setMessages = (next: Message[] | ((prev: Message[]) => Message[])) =>
    props.setMessages(props.sessionId, next)
  const [selectedAgent, setSelectedAgent] = createSignal('search')
  // Row kind for the open thread — gates the promotion confirm on send. A
  // brand-new chat (load throws) stays 'conversation'. Set from loadConversation.
  const [currentKind, setCurrentKind] = createSignal<'conversation' | 'action'>('conversation')
  // Pending promotion: holds the drafted message while the confirm modal is up.
  // null → modal closed. Declining clears it WITHOUT sending (hard gate).
  const [promotionDraft, setPromotionDraft] = createSignal<string | null>(null)
  const [promoting, setPromoting] = createSignal(false)
  // Report the selected agent up to the parent (initial 'search', then on load
  // and on every change) so agent-aware UI can react. Consumers today are the
  // SupportPanel's Data tab (uploads carry agentId, which gates auto-ingest) and
  // its Terminal tab (the Shell needs it to hydrate /work/in). The Tools panel
  // this comment used to name was removed in #234.
  createEffect(() => props.onSelectedAgentChange?.(selectedAgent()))
  // Cursor into ctx.events — tracks how many events were sent last turn so we
  // emit only the delta (new events) rather than the full accumulated history
  let prevEventCount = 0

  // Reactive accessors into the per-session registries owned by the route.
  // Re-reading `props.sessionId` inside the memo means snapshot/run-state
  // tracking automatically swaps when the user picks a different thread.
  const currentProgress = createMemo(() => props.getProgress(props.sessionId))
  const currentSnapshot = () => currentProgress().snapshot()
  const currentRunState = () => props.getRunState(props.sessionId)
  const isProcessing = () => currentRunState().isProcessing
  const runningTool = () => currentRunState().runningTool

  // Sessions the user explicitly stopped. `runSend`'s catch cannot otherwise
  // tell a deliberate cancel from the page-unload abort, and the two want
  // different transcripts: teardown stays silent, a cancel gets a bubble.
  const stoppedSessions = new Set<string>()

  const handleStop = () => {
    const sid = props.sessionId
    if (!currentRunState().isProcessing) return
    stoppedSessions.add(sid)
    props.abortSession?.(sid)
  }

  // Concurrency cap (#105 slice 2). Multiple sessions may stream at once; at
  // the cap a send into an *idle* conversation is refused outright rather
  // than queued, and nothing already running is ever interrupted.
  const concurrencyCap = () => getSettings().maxConcurrentRuns
  const atCap = () =>
    isAtConcurrencyCap({
      runningCount: props.runningCount,
      cap: concurrencyCap(),
      thisSessionRunning: isProcessing(),
    })

  // When the parent swaps in a different sessionId (sidebar selection or
  // "+ New Chat"), reset local state and try to rehydrate from persisted
  // history. Brand-new sessions throw and we fall through to the welcome msg.
  createEffect(() => {
    const sid = props.sessionId

    // A run is in flight for this session: its buffer is the only copy of the
    // turn (nothing is persisted until the run ends), so wiping and reloading
    // here is precisely the #105 bug. Leave the live view alone.
    //
    // Read untracked — if this effect subscribed to run state it would re-run
    // the instant a run finished, clearing the graph/observability panels that
    // just streamed in and flashing the freshly-landed assistant message.
    if (untrack(() => props.getRunState(sid).isProcessing)) return

    props.setMessages(sid, [])
    prevEventCount = 0
    props.onResetForNewSession?.(sid)

    // Default to 'conversation' until the load resolves — a brand-new chat
    // (load rejects) must never gate its first send.
    setCurrentKind('conversation')

    loadConversation(sid)
      .then((loaded) => {
        // Hydration is async: the user may have moved on. The messages still
        // belong in `sid`'s buffer, but view-level state and the parent's
        // graph/observability callbacks must not stomp the thread now on screen.
        const stillDisplayed = () => sid === props.sessionId
        if (stillDisplayed()) {
          setSelectedAgent(loaded.agentId)
          setCurrentKind(loaded.kind)
        }
        props.setMessages(
          sid,
          // Spread, don't re-list: this map used to pick four fields, which
          // silently dropped the hint/patternId/turnInfo that error and warning
          // bubbles carry. `timestamp` is the only field needing conversion.
          loaded.messages.map((m) => ({ ...m, timestamp: new Date(m.timestamp) })),
        )
        // Replay events to parent so graph + observability repopulate. These
        // are filed under `sid`, so a slow hydration that resolves after the
        // user moved on lands in the right thread instead of the visible one.
        try {
          const ctx = JSON.parse(loaded.serialized) as UnifiedContext
          const events = ctx.events ?? []
          prevEventCount = events.length
          if (props.onEventsUpdate && events.length) {
            props.onEventsUpdate(sid, events)
          }
          if (props.onGraphUpdate) {
            const toolEvents = events.filter((e) => e.type === 'tool_result')
            const els = extractGraphElements(toolEvents)
            if (els.length) props.onGraphUpdate(sid, els)
          }
          if (props.onContextUpdate) {
            props.onContextUpdate(sid, ctx)
          }
          // Re-attach retriever citations to the latest assistant message so the
          // Sources footer + inline chips survive reload (best-effort — only the
          // most recent turn's references are recoverable from the event stream).
          const refs = extractReferences(events)
          if (refs.length) {
            props.setMessages(sid, (prev) => {
              const next = [...prev]
              for (let i = next.length - 1; i >= 0; i--) {
                if (next[i].role === 'assistant') {
                  next[i] = { ...next[i], references: refs }
                  break
                }
              }
              return next
            })
          }
        } catch (err) {
          console.warn('[ChatInterface] failed to replay events:', err)
        }
      })
      .catch(() => {
        // Either a brand-new session id or no row yet — show welcome.
        props.setMessages(sid, [WELCOME_MESSAGE])
      })
  })

  const handleAgentChange = (agentId: string) => {
    // Switching agent starts a new conversation under the new agent rather
    // than mutating the existing row's agent_id. Parent mints the new id.
    setSelectedAgent(agentId)
    props.onAgentChangeRequestsNewSession?.()
  }

  // Promotion gate: sending into an `action` first asks the user to confirm
  // turning it into a conversation. Declining cancels the send entirely (the
  // draft is dropped — the user chose not to interact). Once promoted, the
  // thread is a normal conversation and never gates again.
  const handleSendMessage = (content: string) => {
    // Hard stop at the cap. The composer is already disabled in this state,
    // so this only catches a send that raced the count going up (e.g. another
    // thread started streaming between keystroke and submit).
    if (atCap()) return
    if (currentKind() === 'action') {
      setPromotionDraft(content)
      return
    }
    void runSend(content)
  }

  const confirmPromotion = async () => {
    const content = promotionDraft()
    if (content == null || promoting()) return
    setPromoting(true)
    try {
      await promoteAction(props.sessionId)
      setCurrentKind('conversation')
      props.onPromoted?.(props.sessionId)
      setPromotionDraft(null)
      void runSend(content)
    } catch (err) {
      console.error('[ChatInterface] promotion failed:', err)
      // Leave the modal open so the user can retry or cancel.
    } finally {
      setPromoting(false)
    }
  }

  const cancelPromotion = () => {
    // Hard gate: drop the drafted message without sending.
    setPromotionDraft(null)
  }

  const runSend = async (content: string) => {
    // Snapshot the active sessionId at submit time. The user may switch
    // threads mid-stream; without this, late-arriving events would corrupt
    // whichever thread happens to be in view (#47).
    const runSessionId = props.sessionId

    // Per-session progress controller — owned by the route registry so it
    // survives the user navigating away to a different chat.
    const progress = props.getProgress(runSessionId)
    progress.reset()
    props.updateRunState(runSessionId, { isProcessing: true, runningTool: null })

    // Add the user message to *this run's* buffer. No "still on this thread"
    // guard is needed any more: the buffer is addressed by session id, so
    // switching away can't misfile it into the thread now on screen (#105).
    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content,
      timestamp: new Date(),
    }
    props.setMessages(runSessionId, (prev) => [...prev, userMessage])

    const abortController = new AbortController()
    props.registerAbortController(runSessionId, abortController)

    // How this run ended, reported once in `finally` so the route can mark
    // the thread if the user has moved on. `aborted` stays unreported — that
    // path is page teardown, not a result worth announcing.
    let outcome: RunOutcome = 'done'
    let aborted = false

    try {
      // Stream events via SSE endpoint for real-time updates
      const response = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: runSessionId,
          message: content,
          agentId: selectedAgent(),
          settings: getSettings(),
        }),
        signal: abortController.signal,
      })

      if (!response.ok) {
        throw new Error(`Server error: ${response.status}`)
      }

      let finalResult: DoneEventData | null = null
      let runAnnounced = false

      // Typed SSE iteration — the parser handles frame buffering, malformed
      // JSON, partial reads, and yields discriminated `ChatStreamEvent`s.
      for await (const sseEvt of parseChatStream(response)) {
        // First event of the stream: the server-side early persist has
        // committed, so the sidebar can pick up the new row.
        if (!runAnnounced) {
          runAnnounced = true
          props.onRunStarted?.(runSessionId)
        }
        if (sseEvt.event === 'done') {
          finalResult = sseEvt.data as DoneEventData
          continue
        }
        if (sseEvt.event === 'error') {
          throw new Error((sseEvt.data as { error: string }).error)
        }
        if (sseEvt.event === 'title_updated') {
          // Server pushed the LLM-generated title for this conversation —
          // patch the sidebar's threads cache in place. Lands regardless of
          // which thread the user is currently viewing.
          const { sessionId: sid, title } = sseEvt.data
          props.onTitleUpdated?.(sid, title)
          continue
        }
        if (sseEvt.event !== 'message') continue // Forward-compat: ignore unknown event names

        const evt = sseEvt.data as ContextEvent

        // Progress is always routed into the captured run session's
        // controller, even if the user has navigated away.
        progress.ingest(evt)

        // Surface the currently-running tool for the composer guard. A
        // multi-call turn shows the batch size ("3 tools") instead of one name.
        if (evt.type === 'controller_action') {
          const data = evt.data as ControllerActionEventData
          const toolName = data.action?.tool_name
          const extraCalls = data.action?.additional_calls?.length ?? 0
          if (toolName && toolName !== 'Return') {
            props.updateRunState(runSessionId, {
              runningTool: extraCalls > 0 ? `${extraCalls + 1} tools` : toolName,
            })
          } else if (data.action?.is_final) {
            props.updateRunState(runSessionId, { runningTool: null })
          }
        }

        // Inline error/warning bubbles belong to the run's own transcript, so
        // they are filed by session id ahead of the view guard below — a
        // backgrounded run that hits a recoverable error still shows it when
        // the user switches back (#105).
        if (evt.type === 'error') {
          // Presentation lives in `errorBubble` so this and `replayMessages`
          // cannot diverge — the bubble must look identical whether it was
          // painted from the live stream or rebuilt after a reload.
          const errorMsg: Message = {
            id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            timestamp: new Date(),
            patternId: evt.patternId,
            ...errorBubble(evt.data as ErrorEventData),
          }
          props.setMessages(runSessionId, (prev) => [...prev, errorMsg])
        }

        // Panel state is per-session (SA-H8), so events go to the run's own
        // buffer no matter which thread is on screen. This used to `continue`
        // here for a backgrounded run — which both lost those events from the
        // panels and, because the hydration effect skips a session that is
        // still processing, left the previous thread's events in place when the
        // user came back.
        if (props.onEventsUpdate) {
          props.onEventsUpdate(runSessionId, [evt])
        }

        // Reactive graph update on tool_result events
        if (evt.type === 'tool_result' && props.onGraphUpdate) {
          const graphElements = extractGraphElements([evt])
          if (graphElements.length > 0) {
            props.onGraphUpdate(runSessionId, graphElements)
          }
        }
      }

      // Mark progress complete — bar fills, fades, and unmounts.
      progress.finish()

      // Update the event-count cursor and emit the final context into this
      // run's own session (SA-H8) — no longer gated on it being on screen.
      if (finalResult?.context) {
        prevEventCount = finalResult.context.events?.length ?? 0
        props.onContextUpdate?.(runSessionId, finalResult.context as UnifiedContext)
      }

      // Build assistant message from final result — only if there's a real
      // response (not an error status with empty/stale response). Filed into
      // the run's own buffer, so a turn that lands while the user is reading
      // another chat is waiting for them when they switch back (#105).
      const finalResponse = finalResult?.response ?? ''
      if (finalResult?.status === 'error') outcome = 'error'
      if (finalResponse && finalResult?.status !== 'error') {
        const assistantMessage: Message = {
          id: Date.now().toString(),
          role: 'assistant',
          content: finalResponse,
          timestamp: new Date(),
          // Retriever citations for this turn (inline superscripts + footer).
          references: extractReferences(finalResult?.context?.events ?? []),
          toolCall:
            finalResult?.status === 'paused' &&
            (finalResult.data as Record<string, unknown>).pendingAction
              ? {
                  type: 'neo4j',
                  status: 'pending',
                  tool: (
                    (finalResult.data as Record<string, unknown>).pendingAction as {
                      action: string
                    }
                  ).action,
                  explanation: (
                    (finalResult.data as Record<string, unknown>).pendingAction as {
                      reason: string
                    }
                  ).reason,
                  isReadOnly: false,
                }
              : undefined,
        }
        props.setMessages(runSessionId, (prev) => [...prev, assistantMessage])
      }
    } catch (error) {
      // Suppress the noisy AbortError that fires on page-unload teardown.
      aborted = error instanceof DOMException && error.name === 'AbortError'
      if (aborted && stoppedSessions.delete(runSessionId)) {
        // A deliberate Stop, not teardown. The server-side chain keeps running
        // and its result is persisted, so say exactly that rather than
        // pretending the turn never happened.
        props.setMessages(runSessionId, (prev) => [
          ...prev,
          {
            id: `stop-${Date.now()}`,
            role: 'warning',
            content: 'Stopped watching this response.',
            hint: 'The agent finishes server-side — reopen this chat to see the result.',
            timestamp: new Date(),
          },
        ])
      }
      if (!aborted) {
        outcome = 'error'
        console.error('Error processing message:', error)
        const errorMessage: Message = {
          id: Date.now().toString(),
          role: 'error',
          content: error instanceof Error ? error.message : 'Unknown error',
          timestamp: new Date(),
        }
        props.setMessages(runSessionId, (prev) => [...prev, errorMessage])
      }
      progress.finish()
    } finally {
      // Belt and braces: if a Stop raced the stream to completion no AbortError
      // was thrown, and a stale flag here would put a spurious "stopped" bubble
      // on the NEXT teardown of this session.
      stoppedSessions.delete(runSessionId)
      props.updateRunState(runSessionId, { isProcessing: false, runningTool: null })
      props.unregisterAbortController(runSessionId)
      if (!aborted) props.onRunSettled?.(runSessionId, outcome)
    }
  }

  const handleApproveWrite = async (messageId: string) => {
    props.updateRunState(props.sessionId, { isProcessing: true })

    try {
      // Execute the approved operation
      const result = await approveAction(props.sessionId)

      const sid = props.sessionId

      // Extract graph elements from result and update visualization
      const graphElements = extractGraphFromResult(result)
      if (graphElements.length > 0 && props.onGraphUpdate) {
        props.onGraphUpdate(sid, graphElements)
      }

      // Emit only new context events (delta since last turn)
      if (result.context?.events && props.onEventsUpdate) {
        const newEvents = result.context.events.slice(prevEventCount)
        prevEventCount = result.context.events.length
        if (newEvents.length > 0) props.onEventsUpdate(sid, newEvents)
      }
      if (result.context && props.onContextUpdate) {
        props.onContextUpdate(sid, result.context)
      }

      // Update the message with executed tool call
      setMessages(
        messages().map((msg) => {
          if (msg.id === messageId && msg.toolCall) {
            return {
              ...msg,
              toolCall: { ...msg.toolCall, status: 'executed' as const },
            }
          }
          return msg
        }),
      )

      // Add success message
      const successMessage: Message = {
        id: Date.now().toString(),
        role: 'assistant',
        content: result.response,
        timestamp: new Date(),
      }
      setMessages([...messages(), successMessage])
    } catch (error) {
      console.error('Error executing write query:', error)

      // Update the message to mark tool call as error
      setMessages(
        messages().map((msg) => {
          if (msg.id === messageId && msg.toolCall) {
            return {
              ...msg,
              toolCall: { ...msg.toolCall, status: 'error' as const, error: String(error) },
            }
          }
          return msg
        }),
      )

      const errorMessage: Message = {
        id: Date.now().toString(),
        role: 'assistant',
        content: `Write operation failed:\n\n\`\`\`\n${error instanceof Error ? error.message : 'Unknown error'}\n\`\`\``,
        timestamp: new Date(),
      }
      setMessages([...messages(), errorMessage])
    } finally {
      props.updateRunState(props.sessionId, { isProcessing: false })
    }
  }

  const handleRejectWrite = async (messageId: string) => {
    try {
      // Reject the pending operation
      const result = await rejectAction(props.sessionId)

      // Update the message to show rejection in tool call
      setMessages(
        messages().map((msg) => {
          if (msg.id === messageId && msg.toolCall) {
            return {
              ...msg,
              toolCall: { ...msg.toolCall, status: 'error' as const, error: 'Rejected by user' },
            }
          }
          return msg
        }),
      )

      // Add rejection message from agent
      const responseMessage: Message = {
        id: Date.now().toString(),
        role: 'assistant',
        content: result.response,
        timestamp: new Date(),
      }
      setMessages([...messages(), responseMessage])
    } catch (error) {
      console.error('Error rejecting write:', error)
    }
  }

  // Composer guard banner. Naming the running tool when there is one is the
  // nicety; the load-bearing part is that this returns a string for the whole
  // of `isProcessing()` (SA-M11) — `runningTool` is null in every gap between
  // tool calls, and returning undefined there left the composer blocked with
  // nothing on screen to explain it.
  const blockedMessage = () => {
    if (!isProcessing()) return undefined
    const tool = runningTool()
    return tool
      ? `Waiting for \`${tool}\` to complete. Try later.`
      : 'Working on your last message…'
  }

  return (
    <div flex="~ col" h="full" bg="ui-bg-secondary">
      {/* Agent Selector Header */}
      <div
        flex="~ items-center gap-4"
        border="b ui-border-primary"
        px="4"
        py="2"
        bg="ui-bg-tertiary/50"
      >
        <span text="sm ui-text-secondary">Agent:</span>
        <div w="64">
          <AgentSelector
            selectedAgent={selectedAgent()}
            onAgentChange={handleAgentChange}
            disabled={isProcessing()}
          />
        </div>
      </div>

      {/* Messages — the live progress bar rides as a trailing slot so it
            appears where the next assistant bubble will land, then animates
            out as that bubble takes its place. */}
      <ChatMessages
        messages={messages()}
        onApproveWrite={handleApproveWrite}
        onRejectWrite={handleRejectWrite}
        graphEntityNames={props.graphEntityNames}
        onHighlightEntities={props.onHighlightEntities}
        onOpenReference={props.onOpenReference}
        trailing={() => (
          <LiveProgressBar
            status={currentSnapshot().status}
            current={currentSnapshot().currentTurn}
            pathProjection={currentSnapshot().pathProjection}
            maxProjection={currentSnapshot().maxProjection}
            visible={
              isProcessing() && !currentSnapshot().done && currentSnapshot().maxProjection > 0
            }
          />
        )}
      />

      {/* Input */}
      <div border="t ui-border-primary" p="4" bg="ui-bg-secondary/80" backdrop-blur="sm">
        <ChatInput
          onSend={handleSendMessage}
          disabled={isProcessing() || atCap() || !!props.embeddingSources}
          blockedMessage={
            props.embeddingSources
              ? 'Embedding sources… you can ask once indexing finishes.'
              : atCap()
                ? capReachedMessage(concurrencyCap())
                : blockedMessage()
          }
          isProcessing={isProcessing()}
          onStop={props.abortSession ? handleStop : undefined}
          focusToken={props.focusInputToken}
        />
      </div>

      {/* Promotion confirm — shown when the user sends into an action. */}
      <Show when={promotionDraft() != null}>
        <div
          data-role="promotion-confirm"
          style={{
            position: 'fixed',
            inset: '0',
            'z-index': '200',
            display: 'flex',
            'align-items': 'center',
            'justify-content': 'center',
            background: 'rgba(0,0,0,0.55)',
          }}
          onClick={cancelPromotion}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            bg="ui-bg-secondary"
            border="1 ui-accent/30"
            rounded="lg"
            p="5"
            shadow="2xl"
            style={{ 'max-width': '24rem', margin: '1rem' }}
          >
            <div flex="~" items="center" gap="2" m="b-2">
              <span
                class="i-material-symbols-bolt-outline"
                style={{ width: '20px', height: '20px', color: '#22d3ee' }}
              />
              <span text="sm ui-text-primary" font="medium">
                Turn this action into a conversation?
              </span>
            </div>
            <p text="xs ui-text-secondary" m="b-4" style={{ 'line-height': '1.5' }}>
              Sending a message will promote this triggered action into a regular conversation. If
              you cancel, the message won't be sent and it stays an action.
            </p>
            <div flex="~" gap="2" justify="end">
              <button
                onClick={cancelPromotion}
                disabled={promoting()}
                p="x-3 y-1.5"
                rounded="md"
                text="xs ui-text-secondary"
                bg="transparent hover:ui-bg-hover"
                border="1 ui-border-secondary"
                transition="all"
              >
                Cancel
              </button>
              <button
                onClick={confirmPromotion}
                disabled={promoting()}
                p="x-3 y-1.5"
                rounded="md"
                text="xs white"
                bg="cyber-700 hover:cyber-600"
                font="medium"
                transition="all"
              >
                {promoting() ? 'Promoting…' : 'Promote & send'}
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  )
}
