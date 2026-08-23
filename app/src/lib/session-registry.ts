/**
 * Session registry — the per-conversation state the chat route has to keep
 * alive across a sidebar switch (#226 B1).
 *
 * Before this module the route *was* the registry: eight parallel `Map`s keyed
 * by session id, each with its own lazily-creating accessor, and a lifecycle
 * spread across three partial sweeps that each knew a different subset of them
 * (`pruneIdleBuffers` touched 1, `prunePanelState` 3, `handleDeleteThreads` 8).
 * Adding a ninth per-session concern meant editing four places and remembering
 * all of them; the consequence downstream was a 25-prop `ChatInterface`, 11 of
 * whose props existed only to hand a child an accessor back into those maps.
 *
 * What lives here is everything addressed by a session id:
 *
 * | slot         | why it survives a switch                                  |
 * | ------------ | --------------------------------------------------------- |
 * | `messages`   | the in-flight turn is not persisted until the run ends     |
 * | `events`     | observability panel is per-session (SA-H8)                 |
 * | `graph`      | ditto — a backgrounded run keeps filling its own graph     |
 * | `context`    | the last `UnifiedContext` the run reported                 |
 * | `progress`   | the live bar and submit guard (#47)                        |
 * | `runState`   | `isProcessing` / `runningTool`, read by chat AND sidebar   |
 * | `completion` | a run that landed while the user was reading elsewhere     |
 * | `abort`      | the open SSE stream's controller (explicit cancel, unload) |
 *
 * and, crucially, the two lifecycle rules over them: `dispose` (the ONE place
 * a session is forgotten) and `pruneIdle` (the ONE prune rule).
 *
 * Reactivity: reads are plain function calls that read a Solid signal, so
 * calling `registry.runState(sid)` inside a memo/effect subscribes to exactly
 * that session's slot. Signals are created lazily on first touch; they carry
 * no owner, so creating one during a tracked read is safe.
 */
import { createSignal, type Signal } from 'solid-js'
import type { Message } from '~/components/ark-ui/ChatMessages'
import type { GraphElement } from '~/lib/harness-client/types'
import type { ContextEvent, UnifiedContext } from '~/lib/harness-patterns'
import {
  createChainProgress,
  type ChainProgressController,
} from '~/components/ark-ui/useChainProgress'
import { mergeGraphElements } from '~/lib/graph-merge'
import {
  COMPLETION_FLASH_MS,
  DEFAULT_RUN_STATE,
  countRunning,
  type CompletionMark,
  type RunOutcome,
  type SessionRunState,
} from '~/lib/run-registry'

// ============================================================================
// Interface
// ============================================================================

export interface SessionRegistry {
  // -- reads (reactive, one subscription per slot) --------------------------
  messages(sessionId: string): Message[]
  events(sessionId: string): ContextEvent[]
  graph(sessionId: string): GraphElement[]
  context(sessionId: string): UnifiedContext | undefined
  progress(sessionId: string): ChainProgressController
  runState(sessionId: string): SessionRunState
  completion(sessionId: string): CompletionMark | undefined
  /** How many conversations have a stream open right now. */
  runningCount(): number

  // -- writes ---------------------------------------------------------------
  setMessages(sessionId: string, next: Message[] | ((prev: Message[]) => Message[])): void
  appendMessage(sessionId: string, message: Message): void
  appendEvents(sessionId: string, events: ContextEvent[]): void
  /** Rewrite one session's events in place (the Data Stash hide/archive flags). */
  mapEvents(sessionId: string, map: (event: ContextEvent) => ContextEvent): void
  /**
   * Merge freshly-extracted elements into a session's graph and return the ids
   * that arrived in this batch (the caller decides whether they deserve a
   * highlight — that is view state, not session state).
   */
  mergeGraph(sessionId: string, elements: GraphElement[]): string[]
  setContext(sessionId: string, context: UnifiedContext): void
  updateRunState(sessionId: string, patch: Partial<SessionRunState>): void

  // -- clears ---------------------------------------------------------------
  clearGraph(sessionId: string): void
  /** Events + the unified context: what the observability panel projects. */
  clearEvents(sessionId: string): void
  /** Both of the above — what a rehydration does so it replaces rather than appends. */
  clearPanels(sessionId: string): void

  // -- completion marks -----------------------------------------------------
  /** Mark a finished run, flash it once, then decay to the static border. */
  markCompleted(sessionId: string, outcome: RunOutcome): void
  clearCompletion(sessionId: string): void

  // -- in-flight streams ----------------------------------------------------
  registerAbort(sessionId: string, controller: AbortController): void
  unregisterAbort(sessionId: string): void
  /** Explicit user cancel. Tears down the browser half only — the chain keeps
   *  running server-side and persists its result. */
  abort(sessionId: string): void
  /** Page unload: drop every open stream. */
  abortAll(): void

  // -- lifecycle ------------------------------------------------------------
  /** The ONE place a session is forgotten. Every slot above, in one call. */
  dispose(sessionIds: string[]): void
  /**
   * The ONE prune rule. Panel and message buffers for an *idle* session are
   * disposable — the chat view reloads them from Postgres on the next visit —
   * so browsing does not grow the registry without bound. A *running*
   * session's buffers are the only live copy and are never dropped, and
   * neither is `keep` (the conversation about to be displayed).
   *
   * Progress controllers are deliberately NOT pruned: the live bar for a
   * finished-but-unvisited run is cheap and there is nothing to rebuild it from.
   */
  pruneIdle(keep: string): void
  /** Cancel outstanding flash timers. Call from the owner's `onCleanup`. */
  destroy(): void
}

// ============================================================================
// Factory
// ============================================================================

export function createSessionRegistry(): SessionRegistry {
  const messagesBySession = new Map<string, Signal<Message[]>>()
  const eventsBySession = new Map<string, Signal<ContextEvent[]>>()
  const graphBySession = new Map<string, Signal<GraphElement[]>>()
  const contextBySession = new Map<string, Signal<UnifiedContext | undefined>>()
  const progressBySession = new Map<string, ChainProgressController>()
  const abortControllers = new Map<string, AbortController>()
  const flashTimers = new Map<string, ReturnType<typeof setTimeout>>()

  // Run state and completion marks are records behind a single signal rather
  // than a signal-per-session: both are read across *all* sessions at once
  // (the running count, the sidebar's row list), which a Map of signals cannot
  // express without subscribing to a Map identity Solid never diffs.
  const [runStates, setRunStates] = createSignal<Record<string, SessionRunState>>({})
  const [completions, setCompletions] = createSignal<Record<string, CompletionMark>>({})

  // The signal tuple is stored whole rather than destructured: getter and
  // setter are looked up together by session id on every access, which is
  // what the `solid/reactivity` destructuring hint disallows by default.
  const lazy = <T>(map: Map<string, Signal<T>>, sid: string, initial: () => T): Signal<T> => {
    let sig = map.get(sid)
    if (!sig) {
      // eslint-disable-next-line solid/reactivity
      sig = createSignal<T>(initial())
      map.set(sid, sig)
    }
    return sig
  }

  const messagesSignal = (sid: string) => lazy(messagesBySession, sid, () => [] as Message[])
  const eventsSignal = (sid: string) => lazy(eventsBySession, sid, () => [] as ContextEvent[])
  const graphSignal = (sid: string) => lazy(graphBySession, sid, () => [] as GraphElement[])
  const contextSignal = (sid: string) =>
    lazy(contextBySession, sid, () => undefined as UnifiedContext | undefined)

  const registry: SessionRegistry = {
    // -- reads --------------------------------------------------------------
    messages: (sid) => messagesSignal(sid)[0](),
    events: (sid) => eventsSignal(sid)[0](),
    graph: (sid) => graphSignal(sid)[0](),
    context: (sid) => contextSignal(sid)[0](),
    progress: (sid) => {
      let p = progressBySession.get(sid)
      if (!p) {
        p = createChainProgress()
        progressBySession.set(sid, p)
      }
      return p
    },
    runState: (sid) => runStates()[sid] ?? DEFAULT_RUN_STATE,
    completion: (sid) => completions()[sid],
    runningCount: () => countRunning(runStates()),

    // -- writes -------------------------------------------------------------
    setMessages: (sid, next) => {
      const set = messagesSignal(sid)[1]
      // Solid reads a bare function argument as an updater — wrap plain arrays.
      if (typeof next === 'function') set(next)
      else set(() => next)
    },
    appendMessage: (sid, message) => {
      messagesSignal(sid)[1]((prev) => [...prev, message])
    },
    appendEvents: (sid, events) => {
      if (events.length === 0) return
      eventsSignal(sid)[1]((prev) => [...prev, ...events])
    },
    mapEvents: (sid, map) => {
      eventsSignal(sid)[1]((prev) => prev.map(map))
    },
    mergeGraph: (sid, elements) => {
      // Dedup + touched-flag refresh lives in `mergeGraphElements` so it can be
      // unit-tested in isolation.
      graphSignal(sid)[1]((prev) => mergeGraphElements(prev, elements))
      return elements.map((e) => e.data?.id).filter((id): id is string => !!id)
    },
    setContext: (sid, context) => {
      contextSignal(sid)[1](() => context)
    },
    updateRunState: (sid, patch) => {
      setRunStates((prev) => ({
        ...prev,
        [sid]: { ...DEFAULT_RUN_STATE, ...prev[sid], ...patch },
      }))
    },

    // -- clears -------------------------------------------------------------
    clearGraph: (sid) => {
      graphSignal(sid)[1](() => [])
    },
    clearEvents: (sid) => {
      eventsSignal(sid)[1](() => [])
      contextSignal(sid)[1](() => undefined)
    },
    clearPanels: (sid) => {
      registry.clearGraph(sid)
      registry.clearEvents(sid)
    },

    // -- completion marks ---------------------------------------------------
    markCompleted: (sid, outcome) => {
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
    },
    clearCompletion: (sid) => {
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
    },

    // -- in-flight streams --------------------------------------------------
    registerAbort: (sid, controller) => {
      abortControllers.set(sid, controller)
    },
    unregisterAbort: (sid) => {
      abortControllers.delete(sid)
    },
    abort: (sid) => {
      const ac = abortControllers.get(sid)
      if (!ac) return
      try {
        ac.abort()
      } catch {
        /* already settled */
      }
    },
    abortAll: () => {
      for (const ac of abortControllers.values()) {
        try {
          ac.abort()
        } catch {
          /* ignore */
        }
      }
      abortControllers.clear()
    },

    // -- lifecycle ----------------------------------------------------------
    dispose: (sessionIds) => {
      if (sessionIds.length === 0) return
      for (const sid of sessionIds) {
        messagesBySession.delete(sid)
        eventsBySession.delete(sid)
        graphBySession.delete(sid)
        contextBySession.delete(sid)
        progressBySession.delete(sid)
        abortControllers.delete(sid)
        registry.clearCompletion(sid)
      }
      setRunStates((prev) => {
        if (!sessionIds.some((sid) => sid in prev)) return prev
        const next = { ...prev }
        for (const sid of sessionIds) delete next[sid]
        return next
      })
    },
    pruneIdle: (keep) => {
      const states = runStates()
      const maps = [messagesBySession, eventsBySession, graphBySession, contextBySession]
      for (const map of maps) {
        for (const sid of [...map.keys()]) {
          if (sid === keep || states[sid]?.isProcessing) continue
          map.delete(sid)
        }
      }
    },
    destroy: () => {
      for (const timer of flashTimers.values()) clearTimeout(timer)
      flashTimers.clear()
    },
  }

  return registry
}
