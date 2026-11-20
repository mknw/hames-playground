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

import {
  createSignal,
  createEffect,
  createMemo,
  onCleanup,
  onMount,
  untrack,
  Show,
  on,
} from 'solid-js'
import { ChatMessages } from './ChatMessages'
import { ChatInput } from './ChatInput'
import { AgentSelector } from './AgentSelector'
import { ConversationTierSwitch } from './ConversationTierSwitch'
import { ShareConversationButton } from './ShareConversationButton'
import { MemoryProposalPrompt } from './MemoryProposalPrompt'
import { OrgProposalPrompt } from './OrgProposalPrompt'
import { BlockingRequestPrompt } from './BlockingRequestPrompt'
import { LiveProgressBar } from './LiveProgressBar'
import {
  getWarmingBoxStates,
  type WarmingBoxState,
} from '~/lib/harness-client/preview-header.server'
import {
  promoteAction,
  loadConversation,
  getConversationTurnState,
  extractGraphElements,
  extractReferences,
  getAgentList,
  type OpenReferenceTarget,
  type LoadedConversation,
  type ConversationTurnState,
} from '~/lib/harness-client'
import { getSettings } from '~/lib/settings-store'
import { adoptRunningTurn, runTurn, type TurnRecovery, type TurnSink } from '~/lib/turn-stream'
import type { Message } from './ChatMessages'
import { startTrailingRefresh } from '~/lib/trailing-refresh'
import { warningBubble } from '@hames-ai/agents/replay'
import type { GraphElement } from './SupportPanel'
import type { UnifiedContext, WarningEventData } from '@hames-ai/harness-patterns'
import {
  capReachedMessage,
  isAtConcurrencyCap,
  type RunOutcome,
  type SessionRunState,
} from '~/lib/run-registry'
import { useSessionRegistry } from '~/lib/session-registry-context'
import { createLinkAcceptanceStore } from '~/lib/link-acceptance'
import { DEFAULT_AGENT_ID } from '~/lib/harness-client/agent-ids'

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
   *  so the parent can drive agent-aware UI. `capabilities` is the agent's
   *  registry entry — undefined until the agent list has loaded (or if it
   *  failed to), and reported again once it has. */
  onSelectedAgentChange?: (agentId: string, capabilities?: { usesSandbox: boolean }) => void
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
  /** Text to seed the composer with on first mount — the use-cases page's
   *  "Try this" rides this in through a `?q=` query parameter (read once by
   *  the route, then stripped from the URL). Read at mount only; it is a
   *  starting draft, never a live override. */
  initialDraft?: string
}

// ============================================================================
// Component
// ============================================================================

export const ChatInterface = (props: ChatInterfaceProps) => {
  // Per-session state lives in the registry (#226 B1), so an in-flight turn
  // survives the user switching threads (#105). Writes that belong to a
  // specific run always address `runSessionId` explicitly rather than going
  // through this displayed-session shorthand.
  const registry = useSessionRegistry()
  const messages = () => registry.messages(props.sessionId)

  // Session-scoped link acceptance (#901 slice 3): ONE store per SESSION,
  // recreated when the session switches. The scoping is load-bearing, not
  // hygiene: replayed transcripts reuse message ids across sessions
  // (`replay-N`, one counter per conversation), so a store that outlived its
  // session would carry an acceptance from one conversation's message onto
  // ANOTHER conversation's `replay-0` — accepting one link silently accepting
  // another, exactly what ruling Q2 forbids. A store that dies with its
  // session can only lose acceptances (fail-closed: the link reviews
  // again), never lend one.
  const linkAcceptance = createMemo(
    on(
      () => props.sessionId,
      () => createLinkAcceptanceStore(),
    ),
  )

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
  const [selectedAgent, setSelectedAgent] = createSignal(DEFAULT_AGENT_ID)

  // The registry's greeting for whichever agent is selected — what an empty
  // conversation says instead of the one fixed "your knowledge assistant"
  // paragraph every agent used to open with.
  //
  // A plain signal filled on mount, deliberately not a `createResource`:
  // reading a resource here registers with the root `<Suspense>` in `app.tsx`,
  // which has no fallback, so a slow agent-list fetch would blank the whole app
  // (the same trap `SupportPanel`'s local Suspense exists for). Nothing here
  // needs loading state or refetching — until it arrives, `ChatMessages` shows
  // its generic pair. `getAgentList` is a read of an in-memory registry map, so
  // the second call (AgentSelector makes the first, for the picker) costs a
  // round trip and no work.
  const [agentMeta, setAgentMeta] = createSignal<Awaited<ReturnType<typeof getAgentList>>>([])
  onMount(() => {
    void getAgentList()
      .then(setAgentMeta)
      .catch((err) => console.error('[ChatInterface] failed to fetch agent metadata:', err))
  })
  const welcome = () => {
    const agent = agentMeta().find((a) => a.id === selectedAgent())
    return agent ? { title: agent.name, body: agent.welcome } : undefined
  }
  // Row kind for the open thread — gates the promotion confirm on send. A
  // brand-new chat (load throws) stays 'conversation'. Set from loadConversation.
  const [currentKind, setCurrentKind] = createSignal<'conversation' | 'action'>('conversation')
  // Pending promotion: holds the drafted message while the confirm modal is up.
  // null → modal closed. Declining clears it WITHOUT sending (hard gate).
  const [promotionDraft, setPromotionDraft] = createSignal<string | null>(null)
  const [promoting, setPromoting] = createSignal(false)
  /** Bumped when a turn of the on-screen conversation settles, so the memory
   *  prompt knows to look for a proposal the store step may have raised. */
  const [settledTick, setSettledTick] = createSignal(0)
  // Report the selected agent up to the parent (initial DEFAULT_AGENT_ID, then on load
  // and on every change) so agent-aware UI can react. Consumers today are the
  // SupportPanel's Data tab (uploads carry agentId, which gates auto-ingest) and
  // its Sandbox tab (the Shell needs the id to hydrate /work/in, and the tab is
  // greyed out for an agent whose registry entry says it has no sandbox). The
  // entry rides along from the list this component already fetched for the
  // greeting, so the parent needs no second copy of it. The Tools panel this
  // comment used to name was removed in #234.
  createEffect(() => {
    const id = selectedAgent()
    props.onSelectedAgentChange?.(
      id,
      agentMeta().find((a) => a.id === id),
    )
  })
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
   * Modal's live word on the boxes the notice waits on (#1057 §3): booting,
   * restoring or not starting, with the elapsed time from Modal's own container
   * start. Read ONLY while a notice is on screen — a settled chat never asks —
   * at the strip's transition rate, and it is the control plane's read (never a
   * request to a box). A failed read keeps the last good one; the notice's own
   * countdown is unaffected. Empty on a deployment without Modal control.
   */
  const [boxStates, setBoxStates] = createSignal<{
    states: WarmingBoxState[]
    receivedAt: number
  } | null>(null)
  createEffect(() => {
    if (!warming()) {
      setBoxStates(null)
      return
    }
    let alive = true
    const read = async () => {
      try {
        const states = await getWarmingBoxStates()
        if (alive) setBoxStates({ states, receivedAt: Date.now() })
      } catch {
        // keeps the last good reading
      }
    }
    void read()
    const timer = setInterval(() => void read(), WARMING_BOX_POLL_MS)
    onCleanup(() => {
      alive = false
      clearInterval(timer)
    })
  })

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

  /**
   * Put a persisted conversation on screen under `sid`, as a reload shows it:
   * the replayed transcript, then the stored events into the graph and
   * observability panels. The caller has cleared `sid`'s panels. Filed under
   * `sid`, so a slow load that resolves after the user moved on lands in the
   * right thread rather than the visible one.
   */
  const showPersisted = (sid: string, messages: Message[], ctx: UnifiedContext | null) => {
    registry.setMessages(sid, messages)
    if (!ctx) return
    const events = ctx.events ?? []
    registry.appendEvents(sid, events)
    pushGraph(sid, extractGraphElements(events.filter((e) => e.type === 'tool_result')))
    props.onContextUpdate?.(sid, ctx)
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
  }

  /**
   * How a turn whose stream is lost still shows its answer: wait for the turn
   * to release the conversation, then show what it saved, as a reload would.
   */
  const recoveryFor = (runSessionId: string): TurnRecovery => ({
    turnState: () => getConversationTurnState(runSessionId),
    load: async () => {
      const [loaded, state] = await Promise.all([
        loadConversation(runSessionId),
        getConversationTurnState(runSessionId),
      ])
      return {
        status: state?.status ?? 'done',
        messages: toMessages(loaded.messages),
        context: JSON.parse(loaded.serialized) as UnifiedContext,
      }
    },
    rehydrate: (turn) => {
      registry.clearPanels(runSessionId)
      showPersisted(runSessionId, turn.messages, turn.context)
    },
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
    if (hasLocalTurn(sid)) return

    registry.setMessages(sid, [])
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
        let ctx: UnifiedContext | null = null
        try {
          ctx = JSON.parse(loaded.serialized) as UnifiedContext
        } catch (err) {
          console.warn('[ChatInterface] failed to replay events:', err)
        }
        showPersisted(sid, toMessages(loaded.messages), ctx)
        // #1045: the turn may still be RUNNING on the server — this tab was
        // (re)loaded mid-run, or the thread was opened elsewhere. Server
        // state, not per-tab memory: the lease says a turn holds this
        // conversation, and `watchServerTurn` re-derives the running view
        // from it.
        void watchServerTurn(sid)
      })
      .catch(() => {
        // Either a brand-new session id or no row yet. Nothing to plant: the
        // buffer was cleared above, and an empty transcript is what makes
        // ChatMessages render the selected agent's greeting (`welcome` below).
        // It used to plant one fixed assistant message here, which greeted
        // every agent as "your knowledge assistant" and put words in the
        // assistant's mouth before it had said anything.
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
      removeMessages: (ids) =>
        registry.setMessages(runSessionId, (prev) => prev.filter((m) => !ids.has(m.id))),
      pushEvents: (events) => registry.appendEvents(runSessionId, events),
      pushGraph: (elements) => pushGraph(runSessionId, elements),
      setContext: (context) => props.onContextUpdate?.(runSessionId, context),
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

  /**
   * The turn's trailing pass (the post-turn summaries) runs detached, after the
   * answer reached the caller, so its describe calls, memory writes and the
   * summaries they leave behind reach the panels only through the persisted
   * context (#784 item 12). Poll for it rather than holding the stream open —
   * see `trailing-refresh.ts`. Shared by the live run and an adopted one
   * (#1045): both settled a turn whose trailing pass is still to land.
   */
  const startTrailingRefreshFor = (sid: string) => {
    startTrailingRefresh({
      local: () => registry.events(sid),
      fetch: async () => {
        const loaded = await loadConversation(sid)
        return (JSON.parse(loaded.serialized) as UnifiedContext).events ?? []
      },
      append: (events) => {
        registry.appendEvents(sid, [...events])
        // A summarizer-failure `warning` reaches the transcript as the same
        // amber bubble the live stream (`turn-stream.ts`) and replay
        // (`replay.ts`) paint, so all three views agree without a reload.
        for (const evt of events) {
          if (evt.type !== 'warning') continue
          registry.appendMessage(sid, {
            id: `warn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            timestamp: new Date(),
            ...warningBubble(evt.data as WarningEventData),
          })
        }
      },
      map: (map) => registry.mapEvents(sid, map),
    })
  }

  /**
   * Run one turn: a message, or (`mode: 'resume'`) the continuation of a paused
   * run whose answers the blocking prompt has just recorded — the same stream,
   * the same sink, and no user message in the transcript.
   */
  const runSend = async (content: string, mode: 'interactive' | 'resume' = 'interactive') => {
    // Snapshot the active sessionId at submit time. The user may switch
    // threads mid-stream; without this, late-arriving events would corrupt
    // whichever thread happens to be in view (#47).
    const runSessionId = props.sessionId

    registry.progress(runSessionId).reset()

    // Add the user message to *this run's* buffer. No "still on this thread"
    // guard is needed any more: the buffer is addressed by session id, so
    // switching away can't misfile it into the thread now on screen (#105).
    if (mode === 'interactive') {
      registry.appendMessage(runSessionId, {
        id: Date.now().toString(),
        role: 'user',
        content,
        timestamp: new Date(),
      })
    }

    // Claim the run BEFORE the tier-write await (#1045 review): the await is
    // a round trip, and until the stream's first state lands nothing marks
    // this session as running — so an adoption whose turn-state read resolved
    // inside the window adopted over this send, the server refused the send
    // (a turn still holds the row), and the `finally` below then unregistered
    // the abort handle, leaving the adoption polling with a Stop that no
    // longer reached it. Marked here, `watchServerTurn`'s local-run guard
    // reads the send and stands down. The abort handle moves up with the mark
    // so a Stop pressed inside the window reaches this run too; `finally`
    // clears both exactly as before.
    const abortController = new AbortController()
    registry.registerAbort(runSessionId, abortController)
    registry.updateRunState(runSessionId, { isProcessing: true })

    // Settle any tier flip first — see `pendingTierWrite`.
    if (pendingTierWrite) await pendingTierWrite.catch(() => {})

    try {
      const { outcome, aborted } = await runTurn(
        {
          sessionId: runSessionId,
          message: content,
          agentId: selectedAgent(),
          settings: getSettings(),
          signal: abortController.signal,
          mode,
        },
        sinkFor(runSessionId),
        recoveryFor(runSessionId),
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
      if (!aborted) {
        if (outcome === 'done') startTrailingRefreshFor(runSessionId)
        props.onRunSettled?.(runSessionId, outcome)
        if (runSessionId === props.sessionId) setSettledTick((n) => n + 1)
      }
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

  // ---------------------------------------------------------------------------
  // A turn found already running on the server (#1045)
  // ---------------------------------------------------------------------------

  /** Sessions whose server-side turn this tab has adopted. Guarding the read
   *  as well as the write: two hydrations of one thread must not start two
   *  watches, and a watch must never adopt over a local run. */
  const watched = new Set<string>()

  /**
   * Adopt a turn the SERVER says is running in this conversation — what a page
   * (re)loaded mid-run shows (#1045).
   *
   * `isProcessing` used to be per-tab memory: the tab that sent the message
   * knew the turn was running, and a Ctrl+R in the middle of a minutes-long
   * GPU wait left the conversation looking idle until the turn's final save
   * arrived. The server has the fact all along — the turn's lease
   * (`turn_claimed_at`) says a turn holds this conversation — so a hydration
   * asks once and, when the answer is yes, drives the ordinary turn sink from
   * the adoption poller: the composer blocks, the sidebar strip runs, the GPU
   * wait (when that is what the turn is still inside) puts the notice back on
   * screen from the server's estimate, and the outcome lands when the turn
   * releases the row — the same recovery path a lost stream takes.
   *
   * Stop means what it means for a lost stream: this tab stops watching. The
   * turn keeps running server-side and persists its result either way.
   */
  const watchServerTurn = async (sid: string) => {
    let server: ConversationTurnState | null = null
    try {
      server = await getConversationTurnState(sid)
    } catch {
      // A brand-new chat has no row to ask about; anything else here is a read
      // that the next hydration will retry.
      return
    }
    if (!server?.turnInFlight || watched.has(sid)) return
    // A run in THIS tab won the race (the user sent while the read was out):
    // its stream is the live view and needs no adoption. The transcript the
    // hydration planted does NOT count — `hasLocalTurn` is true after every
    // rehydrate, because the persisted history is exactly what an adoption
    // has to watch over. A run live in this tab is the thing to defer to,
    // and after one truly settles the server says no turn holds the row.
    // Untracked for `hasLocalTurn`'s reason: this is a policy read at adoption
    // time, not a subscription.
    if (untrack(() => registry.runState(sid).isProcessing)) return
    watched.add(sid)
    const controller = new AbortController()
    registry.registerAbort(sid, controller)
    registry.updateRunState(sid, { watching: true })
    try {
      const { outcome, aborted } = await adoptRunningTurn(
        sid,
        recoveryFor(sid),
        sinkFor(sid),
        controller.signal,
        server.warming,
      )
      if (aborted && stoppedSessions.has(sid)) {
        registry.appendMessage(sid, {
          id: `stop-${Date.now()}`,
          role: 'warning',
          content: 'Stopped watching this response.',
          hint: 'The agent finishes server-side — reopen this chat to see the result.',
          timestamp: new Date(),
        })
      }
      if (!aborted) {
        if (outcome === 'done') startTrailingRefreshFor(sid)
        props.onRunSettled?.(sid, outcome)
        if (sid === props.sessionId) setSettledTick((n) => n + 1)
      }
    } finally {
      stoppedSessions.delete(sid)
      watched.delete(sid)
      registry.updateRunState(sid, {
        isProcessing: false,
        runningTool: null,
        warming: null,
        watching: false,
      })
      registry.unregisterAbort(sid)
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
        {/* The "agent" caption matches the nav's "metrics" / "use cases"
            captions — the three page controls read as one group (owner,
            2026-11-02). */}
        <span text="2xs ui-text-primary">agent</span>
        <div w="64">
          <AgentSelector
            selectedAgent={selectedAgent()}
            onAgentChange={handleAgentChange}
            disabled={isProcessing()}
          />
        </div>
        <ConversationTierSwitch sessionId={props.sessionId} onPendingWrite={setPendingTierWrite} />
        {/* Share sits at the far end of the conversation header, after the
            agent picker and the tier switch. It is not disabled during a turn:
            sharing reads and writes one plaintext column and touches nothing
            the run is using. */}
        <div m="l-auto">
          <ShareConversationButton sessionId={props.sessionId} />
        </div>
      </div>

      {/* Messages — the live progress bar rides as a trailing slot so it
            appears where the next assistant bubble will land, then animates
            out as that bubble takes its place. */}
      <ChatMessages
        messages={messages()}
        welcome={welcome()}
        linkAcceptance={linkAcceptance()}
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
            boxStates={boxStates()}
            visible={
              isProcessing() &&
              !currentSnapshot().done &&
              // A cold start has its own reason to be on screen and its own
              // reason not to show a bar: the chain's denominator is seeded by
              // the turn's FIRST event, so the bar is already projectable while
              // the box is still starting, and would sit at 0/N for the whole
              // wait. The notice takes the slot until the box answers.
              //
              // An ADOPTED turn (#1045) has the opposite problem: no stream
              // will ever arrive to seed the denominator, so without this the
              // running state would block the composer while showing nothing
              // where the answer will land.
              (!!warming() || currentSnapshot().maxProjection > 0 || currentRunState().watching)
            }
          />
        )}
      />

      <MemoryProposalPrompt sessionId={props.sessionId} settledTick={settledTick()} />
      <OrgProposalPrompt
        sessionId={props.sessionId}
        settledTick={settledTick()}
        // Not `pushGraph`: an acceptance carries its own highlight (`added`), and
        // moving the query highlight onto its neighbours would mark them too.
        onAccepted={(sid, elements) => void registry.mergeGraph(sid, elements)}
      />
      <BlockingRequestPrompt
        sessionId={props.sessionId}
        settledTick={settledTick()}
        busy={isProcessing()}
        onResume={() => {
          if (!isProcessing() && !atCap()) void runSend('', 'resume')
        }}
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
          initialValue={props.initialDraft}
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
                text="xs ui-on-accent"
                bg="ui-accent hover:ui-accent-deep"
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

/** How often the notice re-reads Modal's word on a box it waits on: the
 *  header strip's own mid-transition rate (`ACTIVE_POLL_INTERVAL_MS`). */
export const WARMING_BOX_POLL_MS = 3_000

/** Replayed messages with their timestamps revived. Spread, don't re-list: a
 *  field list silently dropped the hint/patternId/turnInfo that error and
 *  warning bubbles carry. */
function toMessages(messages: LoadedConversation['messages']): Message[] {
  return messages.map((m) => ({ ...m, timestamp: new Date(m.timestamp) }))
}
