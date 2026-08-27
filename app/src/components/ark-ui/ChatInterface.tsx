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
 * - The streaming turn itself lives in `lib/turn-stream.ts` (#226 B2): this
 *   component supplies the request and a `TurnSink` bound to the session
 *   captured at submit time, and renders what comes back.
 * - Uses harness-client server actions
 * - Per-session state (messages, events, graph, context, progress, run state,
 *   abort controllers) is read from the `SessionRegistry` in context, not
 *   handed down as eleven accessor props — see #226 B1. The fetch loop
 *   captures `runSessionId` at submit time and addresses the registry with it,
 *   so a run keeps filling its own conversation after the user switches
 *   threads (#47 / #105).
 */

import { createSignal, createEffect, createMemo, untrack, Show } from 'solid-js'
import { ChatMessages, type Message } from './ChatMessages'
import { ChatInput } from './ChatInput'
import { AgentSelector } from './AgentSelector'
import { ConversationTierSwitch } from './ConversationTierSwitch'
import { LiveProgressBar } from './LiveProgressBar'
import {
  approveAction,
  rejectAction,
  promoteAction,
  loadConversation,
  extractGraphElements,
  extractReferences,
  type OpenReferenceTarget,
} from '~/lib/harness-client'
import { getSettings } from '~/lib/settings-store'
import { applyApprovalResult, runTurn, type TurnSink } from '~/lib/turn-stream'
import type { GraphElement } from './SupportPanel'
import type { UnifiedContext } from '~/lib/harness-patterns'
import {
  capReachedMessage,
  isAtConcurrencyCap,
  type RunOutcome,
  type SessionRunState,
} from '~/lib/run-registry'
import { useSessionRegistry } from '~/lib/session-registry-context'

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
  /** A turn (or a hydration) produced a fresh `UnifiedContext`. The route
   *  files it in the registry AND refreshes the sidebar — titles update once
   *  the first user_message lands — which is why this stays a callback
   *  rather than a direct registry write. */
  onContextUpdate?: (sessionId: string, ctx: UnifiedContext) => void
  /** Called when the user changes agent — parent should mint a fresh sessionId so
   *  the new agent gets its own conversation row rather than overwriting an existing one. */
  onAgentChangeRequestsNewSession?: () => void
  /** Reports the conversation's selected agent (initial, on load, and on change)
   *  so the parent can drive agent-aware UI. */
  onSelectedAgentChange?: (agentId: string) => void
  /** Map of entity/relation names → graph element IDs for interactive highlighting */
  graphEntityNames?: Map<string, string[]>
  /** Callback to highlight specific graph element IDs — driven both by a click
   *  in the transcript and by a batch of graph elements landing in the thread
   *  currently on screen. */
  onHighlightEntities?: (ids: string[]) => void
  /** Open the inline file viewer for a citation clicked in an assistant message. */
  onOpenReference?: (target: OpenReferenceTarget) => void
  /** True while uploaded sources are still embedding — blocks the composer so the
   *  user can't query the retriever before its documents are searchable. */
  embeddingSources?: boolean
  /** Fired once per run, on the first SSE event. By then the server has
   *  persisted the conversation row (the early save in `runTurn` strictly
   *  precedes event emission), so the route can refetch the sidebar and the
   *  new thread appears with its derived title while still streaming (#105). */
  onRunStarted?: (sessionId: string) => void
  /** Fired when a run finishes, with how it ended. The route refetches the
   *  thread list and marks the row so a run that lands while the user is
   *  elsewhere is visible (#105). Not fired for an abort — that's page teardown. */
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
  // Per-session state lives in the registry (#226 B1), so an in-flight turn
  // survives the user switching threads (#105). Writes that belong to a
  // specific run always address `runSessionId` explicitly rather than going
  // through these displayed-session shorthands.
  const registry = useSessionRegistry()
  const messages = () => registry.messages(props.sessionId)
  const setMessages = (next: Message[] | ((prev: Message[]) => Message[])) =>
    registry.setMessages(props.sessionId, next)

  /**
   * File a batch of graph elements against the run's own conversation, and
   * move the highlight only when that conversation is the one on screen —
   * highlighting is view state, not per-session data.
   */
  const pushGraph = (sid: string, elements: GraphElement[]) => {
    if (elements.length === 0) return
    const ids = registry.mergeGraph(sid, elements)
    if (sid === props.sessionId) props.onHighlightEntities?.(ids)
  }
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
  const currentProgress = createMemo(() => registry.progress(props.sessionId))
  const currentSnapshot = () => currentProgress().snapshot()
  const currentRunState = () => registry.runState(props.sessionId)
  const isProcessing = () => currentRunState().isProcessing
  const runningTool = () => currentRunState().runningTool
  /** The cold-start notice for the thread on screen, if its turn hit one. */
  const warming = () => currentRunState().warming

  /**
   * The tier switch's most recent write, while it is in flight.
   *
   * `runSend` awaits it before starting the turn. For a conversation with no row
   * yet the flip lands in the user's seed and the first turn's pre-seed reads
   * that seed, so a send that overtook the write would start the conversation on
   * the tier the user had just left — and RECORD it, since the pre-seed stamps
   * the row. One await removes the ordering question rather than trusting a
   * person to be slower than a round trip. Failures are swallowed here: the
   * switch already reports them, and a send must not be lost to one.
   */
  let pendingTierWrite: Promise<unknown> | null = null
  const setPendingTierWrite = (write: Promise<unknown>) => {
    pendingTierWrite = write
  }

  // Sessions the user explicitly stopped. `runSend`'s catch cannot otherwise
  // tell a deliberate cancel from the page-unload abort, and the two want
  // different transcripts: teardown stays silent, a cancel gets a bubble.
  const stoppedSessions = new Set<string>()

  const handleStop = () => {
    const sid = props.sessionId
    if (!currentRunState().isProcessing) return
    stoppedSessions.add(sid)
    registry.abort(sid)
  }

  // Concurrency cap (#105 slice 2). Multiple sessions may stream at once; at
  // the cap a send into an *idle* conversation is refused outright rather
  // than queued, and nothing already running is ever interrupted.
  const concurrencyCap = () => getSettings().maxConcurrentRuns
  const atCap = () =>
    isAtConcurrencyCap({
      runningCount: registry.runningCount(),
      cap: concurrencyCap(),
      thisSessionRunning: isProcessing(),
    })

  /**
   * Does `sid`'s buffer hold something a hydration must not replace?
   *
   * The hydration effect below asks this three times — once before wiping, and
   * once in each branch of the load. Only the first used to exist, and it asked
   * a narrower question: "is a run in flight". That reads as "do not clobber a
   * live run" and only holds if the load resolves before the run starts. The
   * load is a network round trip, so that is a race — and for a brand-new chat
   * it is the REJECT path that races, because `loadConversation` fails for an id
   * with no row. A rejection landing after the first `send` replaced the user's
   * message and its answer with the welcome bubble: nothing wrong on the wire —
   * the turn ran, the row was written — and a transcript missing its first
   * exchange on screen. `05-multi-turn.browser.ts` is what caught it.
   *
   * In flight is the wrong question at RESOLUTION time, and that is the part
   * worth reading twice: a short turn is already finished by then, so the run
   * state says idle while its transcript is the only copy of what happened. The
   * effect empties the buffer before loading, so a non-empty one means something
   * else filled it — which is exactly the thing to keep.
   *
   * Untracked for the same reason the entry check is: subscribing would re-run
   * the effect the instant a run finished, wiping the panels that just streamed.
   */
  const hasLocalTurn = (sid: string) =>
    untrack(() => registry.runState(sid).isProcessing || registry.messages(sid).length > 0)

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
    if (hasLocalTurn(sid)) return

    registry.setMessages(sid, [])
    prevEventCount = 0
    // Wipe this conversation's panel state so a rehydration replaces rather
    // than appends. Progress is NOT cleared — a still-running stream for
    // another thread keeps populating its own controller.
    registry.clearPanels(sid)

    // Default to 'conversation' until the load resolves — a brand-new chat
    // (load rejects) must never gate its first send.
    setCurrentKind('conversation')

    loadConversation(sid)
      .then((loaded) => {
        // A turn happened while this load was in flight — see `hasLocalTurn`.
        // Its buffer is the only copy of what is on screen; replacing it with
        // the persisted history would drop the message the user just sent, and
        // replaying the stored events would double the panels.
        if (hasLocalTurn(sid)) return
        // Hydration is async: the user may have moved on. The messages still
        // belong in `sid`'s buffer, but view-level state and the parent's
        // graph/observability callbacks must not stomp the thread now on screen.
        const stillDisplayed = () => sid === props.sessionId
        if (stillDisplayed()) {
          setSelectedAgent(loaded.agentId)
          setCurrentKind(loaded.kind)
        }
        registry.setMessages(
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
          registry.appendEvents(sid, events)
          pushGraph(sid, extractGraphElements(events.filter((e) => e.type === 'tool_result')))
          if (props.onContextUpdate) {
            props.onContextUpdate(sid, ctx)
          }
          // Re-attach retriever citations to the latest assistant message so the
          // Sources footer + inline chips survive reload (best-effort — only the
          // most recent turn's references are recoverable from the event stream).
          const refs = extractReferences(events)
          if (refs.length) {
            registry.setMessages(sid, (prev) => {
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
        // Either a brand-new session id or no row yet — show the welcome.
        //
        // PREPENDED rather than assigned, and that is the whole fix. A
        // brand-new chat rejects here, and the rejection is a network round
        // trip, so it can land after the user has already sent into the
        // conversation. Assigning replaced their message and its answer with
        // the welcome bubble; skipping the write instead (the first version of
        // this guard) dropped the welcome bubble whenever the send won the
        // race, which left the transcript's first line depending on which of
        // two round trips finished first — visible as scenario 07's chat-view
        // baseline differing between two runs of the same code.
        //
        // Prepending is deterministic in both orders: the welcome is always the
        // first bubble, and nothing a turn wrote is ever lost. The buffer was
        // emptied at the top of this effect, so there is no earlier welcome to
        // duplicate.
        registry.setMessages(sid, (prev) => [WELCOME_MESSAGE, ...prev])
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

  /**
   * The narrow set of effects a turn performs, all bound to the session
   * captured at submit time. Both the streaming turn and the approval path
   * write through this, which is what stops the two fanning out differently.
   */
  const sinkFor = (runSessionId: string): TurnSink => {
    const progress = registry.progress(runSessionId)
    return {
      appendMessage: (message) => registry.appendMessage(runSessionId, message),
      pushEvents: (events) => registry.appendEvents(runSessionId, events),
      pushGraph: (elements) => pushGraph(runSessionId, elements),
      setContext: (context) => {
        // The cursor the approval path slices its event delta from.
        prevEventCount = context.events?.length ?? prevEventCount
        props.onContextUpdate?.(runSessionId, context)
      },
      ingestProgress: (event) => progress.ingest(event),
      finishProgress: () => progress.finish(),
      // Stamped on ARRIVAL, in this browser's clock: the countdown ticks
      // against `receivedAt`, and mixing a server stamp into that subtraction
      // would measure clock skew as well as elapsed time.
      onWarming: (notice) =>
        registry.updateRunState(runSessionId, {
          warming: notice ? { ...notice, receivedAt: Date.now() } : null,
        }),
      onStarted: () => props.onRunStarted?.(runSessionId),
      onTitleUpdated: (sid, title) => props.onTitleUpdated?.(sid, title),
      // Run state is a projection of the turn state: streaming means the
      // composer is blocked and may name a tool; every terminal state releases it.
      onState: (state) =>
        registry.updateRunState(runSessionId, {
          isProcessing: state.status === 'streaming',
          runningTool: state.status === 'streaming' ? state.runningTool : null,
        }),
    }
  }

  const runSend = async (content: string) => {
    // Snapshot the active sessionId at submit time. The user may switch
    // threads mid-stream; without this, late-arriving events would corrupt
    // whichever thread happens to be in view (#47).
    const runSessionId = props.sessionId

    registry.progress(runSessionId).reset()

    // Add the user message to *this run's* buffer. No "still on this thread"
    // guard is needed any more: the buffer is addressed by session id, so
    // switching away can't misfile it into the thread now on screen (#105).
    registry.appendMessage(runSessionId, {
      id: Date.now().toString(),
      role: 'user',
      content,
      timestamp: new Date(),
    })

    // Settle any tier flip first — see `pendingTierWrite`.
    if (pendingTierWrite) await pendingTierWrite.catch(() => {})

    const abortController = new AbortController()
    registry.registerAbort(runSessionId, abortController)

    try {
      const { outcome, aborted } = await runTurn(
        {
          sessionId: runSessionId,
          message: content,
          agentId: selectedAgent(),
          settings: getSettings(),
          signal: abortController.signal,
        },
        sinkFor(runSessionId),
      )

      // A torn-down stream is either the user's Stop or page teardown, and the
      // two want different transcripts: teardown stays silent, a deliberate
      // cancel says what actually happens next.
      if (aborted && stoppedSessions.has(runSessionId)) {
        registry.appendMessage(runSessionId, {
          id: `stop-${Date.now()}`,
          role: 'warning',
          content: 'Stopped watching this response.',
          hint: 'The agent finishes server-side — reopen this chat to see the result.',
          timestamp: new Date(),
        })
      }
      if (!aborted) props.onRunSettled?.(runSessionId, outcome)
    } finally {
      // Belt and braces: if a Stop raced the stream to completion no abort was
      // reported, and a stale flag here would put a spurious "stopped" bubble
      // on the NEXT teardown of this session.
      stoppedSessions.delete(runSessionId)
      registry.updateRunState(runSessionId, {
        isProcessing: false,
        runningTool: null,
        warming: null,
      })
      registry.unregisterAbort(runSessionId)
    }
  }

  const handleApproveWrite = async (messageId: string) => {
    registry.updateRunState(props.sessionId, { isProcessing: true })

    try {
      // Execute the approved operation
      const result = await approveAction(props.sessionId)

      // Same fan-out as the streaming turn, through the same sink — only the
      // event slicing differs, because an approval resumes an existing context.
      prevEventCount = applyApprovalResult(result, prevEventCount, sinkFor(props.sessionId))

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
      registry.updateRunState(props.sessionId, { isProcessing: false })
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
    <div data-testid="chat-column" flex="~ col" h="full" bg="ui-bg-secondary">
      {/* Agent selector + the conversation's inference tier. Two settings of
          the same weight: which harness answers, and which infrastructure it
          answers on. They differ in one way that is not visual — changing the
          agent mints a NEW conversation (see `handleAgentChange`), while the
          tier is a property of THIS one and may be flipped mid-thread. */}
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
        <ConversationTierSwitch sessionId={props.sessionId} onPendingWrite={setPendingTierWrite} />
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
            warming={warming()}
            visible={
              isProcessing() &&
              !currentSnapshot().done &&
              // A cold start has its own reason to be on screen and its own
              // reason not to show a bar: the chain's denominator is seeded by
              // the turn's FIRST event, so the bar is already projectable while
              // the box is still starting, and would sit at 0/N for the whole
              // wait. The notice takes the slot until the box answers.
              (!!warming() || currentSnapshot().maxProjection > 0)
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
          onStop={handleStop}
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
