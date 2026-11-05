/**
 * The streaming turn — one user message, one SSE stream, one transcript
 * (#226 B2).
 *
 * This used to be `ChatInterface.runSend`: 223 lines inside a Solid component
 * doing the POST, the SSE iteration, the per-event-type dispatch, the run-state
 * transitions, the assistant-message construction (including the paused
 * `pendingAction` shape) and a `finally` that had to fire four callbacks in
 * order. None of it could be exercised without mounting a component and
 * stubbing `fetch`.
 *
 * The module is framework-free: no Solid, no DOM. It takes a `TurnRequest`,
 * writes through a narrow `TurnSink` of effects, and reports where the turn
 * ended as an explicit `TurnState`. The component becomes wiring, and the state
 * machine is testable against a scripted event array. (The approval path that
 * fed the same sink, `applyApprovalResult`, went with the boolean
 * `resumeHarness` in #433 S3: a resume runs over this stream instead.)
 *
 * The wire format is untouched — `parseChatStream` still owns it.
 */
import { extractGraphElements } from '@hames-ai/agents'
import { extractReferences } from '@hames-ai/agents'
// Imported from the module rather than the barrel: `replay.ts` is deliberately
// dependency-free (no server-only imports), and the stream handler wants
// exactly that guarantee.
import { errorBubble, warningBubble } from '@hames-ai/agents/replay'
import {
  parseChatStream,
  StreamLostError,
  type DoneEventData,
  type WarmingEventData,
} from '~/lib/sse-client'
import { browserTimeZone, openChatStream } from '~/lib/api-client'
import type { Message } from '~/components/ark-ui/ChatMessages'
import type { GraphElement } from '@hames-ai/agents'
import type {
  ContextEvent,
  UnifiedContext,
  ControllerActionEventData,
  ErrorEventData,
  WarningEventData,
} from '@hames-ai/harness-patterns'
import type { HarnessSettings } from '~/lib/settings'
import type { RunOutcome } from '~/lib/run-registry'

// ============================================================================
// State
// ============================================================================

/**
 * Where a conversation's turn is. `idle` is the resting state a caller starts
 * from; `runTurn` reports every transition from `streaming` onwards.
 *
 * The three terminal states are distinct because callers treat them
 * differently: `done` and `awaiting-decision` are results worth announcing,
 * `error` paints a bubble, and `stopped` is a torn-down stream — either the
 * user's Stop or page teardown — which by itself says nothing about the run,
 * because the chain keeps going server-side.
 */
export type TurnState =
  | { status: 'idle' }
  | { status: 'streaming'; runningTool: string | null }
  /** The run paused on human-in-the-loop requests (#433). `requestIds` name the
   *  ones the run waits on — a HINT with no consumer outside tests today: the
   *  card, toast and inbox read the authoritative set from the server. */
  | { status: 'awaiting-decision'; requestIds: readonly string[] }
  | { status: 'done' }
  | { status: 'error'; message: string }
  | { status: 'stopped' }

export const IDLE_TURN: TurnState = { status: 'idle' }

/** Everything needed to open the stream. */
export interface TurnRequest {
  sessionId: string
  message: string
  agentId: string
  settings: HarnessSettings
  signal: AbortSignal
  /** `resume` continues a paused run (decision-loop-agent slice 9) after its
   *  answers were recorded: no message is sent, and the server reads the
   *  answers from the store. The stream that follows is an ordinary turn's. */
  mode?: 'interactive' | 'resume'
}

/**
 * The effects a turn performs, and the only way it reaches the outside world.
 * Every write is anonymous: the caller has already bound each one to the
 * session captured at submit time, so a turn that outlives a thread switch
 * cannot misfile itself.
 */
export interface TurnSink {
  appendMessage(message: Message): void
  pushEvents(events: ContextEvent[]): void
  pushGraph(elements: GraphElement[]): void
  setContext(context: UnifiedContext): void
  /** Feed the per-session progress controller. */
  ingestProgress(event: ContextEvent): void
  /** The bar fills, fades and unmounts. Fired exactly once per turn. */
  finishProgress(): void
  /**
   * The turn is waiting on a cold self-hosted box (payload), or is not any more
   * (`null`). While a payload is set the caller shows a spinner and an estimate
   * INSTEAD of the progress bar — the bar's denominator is seeded by the first
   * event of the turn, so without this it would appear at 0/N and sit there for
   * the whole cold start, which is the "is it stuck?" reading this exists to
   * prevent.
   */
  onWarming(notice: WarmingEventData | null): void
  /** First frame of the stream — the server has persisted the row by now. */
  onStarted(): void
  /** The server regenerated a conversation's title mid-stream. Carries its own
   *  session id: the event can be about a thread other than this turn's. */
  onTitleUpdated(sessionId: string, title: string): void
  /** Every state transition, in order. */
  onState(state: TurnState): void
}

/** A conversation as the server persisted it — what a reload would show. */
export interface PersistedTurn {
  /** Lifted row status: `error` and `paused` end the turn as such. */
  status: 'running' | 'paused' | 'done' | 'error'
  /** The whole transcript, replayed from the stored context. */
  messages: Message[]
  context: UnifiedContext
}

/**
 * How a turn whose live stream is lost still reaches its answer. The turn keeps
 * running on the server when its stream stops, and its save is what a reload
 * shows, so the client waits for the save and shows that instead.
 */
export interface TurnRecovery {
  /** Whether a turn still holds the conversation; `null` when it has no row. */
  turnState(): Promise<{ turnInFlight: boolean } | null>
  /** The persisted conversation, once no turn holds it. */
  load(): Promise<PersistedTurn>
  /** Replace this conversation's transcript and panels with `turn`. */
  rehydrate(turn: PersistedTurn): void
}

/** How often a lost stream's turn is polled for completion. */
export const RECOVERY_POLL_MS = 3_000
/** Polls that may find no row before recovery gives up: the turn never persisted. */
export const RECOVERY_MISSING_POLLS = 10

export interface TurnResult {
  /** Terminal state — the last value also handed to `sink.onState`. */
  state: TurnState
  /** How the run ended, for the thread-list completion mark. */
  outcome: RunOutcome
  /** The stream was torn down (explicit Stop, or page unload). The caller
   *  decides which, and whether that deserves a transcript entry. */
  aborted: boolean
}

// ============================================================================
// The turn
// ============================================================================

/**
 * Run one turn: POST the message, consume the SSE stream, and write the
 * transcript, panels and progress through `sink`.
 *
 * Never throws. Every failure path — a non-OK response, an `error` frame, a
 * thrown parse — lands as an `error` state with a bubble already appended.
 */
export async function runTurn(
  request: TurnRequest,
  sink: TurnSink,
  recovery?: TurnRecovery,
): Promise<TurnResult> {
  const transition = (state: TurnState): TurnState => {
    sink.onState(state)
    return state
  }

  transition({ status: 'streaming', runningTool: null })

  // Declared outside the try so both exits below can retract a notice the
  // stream left standing — a turn that is torn down or throws mid-cold-start
  // would otherwise leave a spinner on screen with nothing behind it.
  let warming = false
  const clearWarming = () => {
    if (!warming) return
    warming = false
    sink.onWarming(null)
  }

  // Warnings that arrive AFTER `done` — the title's, sent while the stream is
  // held open for it (#420). The answer is painted only when the stream ends,
  // so appending them on arrival put the notice ABOVE the answer, while replay,
  // which follows event order, puts it below. Held here and appended after the
  // answer, so the transcript reads the same live and after a reload.
  const afterAnswer: Message[] = []
  const flushAfterAnswer = () => {
    for (const message of afterAnswer.splice(0)) sink.appendMessage(message)
  }

  try {
    const response = await openChatStream(
      request.mode === 'resume'
        ? {
            sessionId: request.sessionId,
            settings: request.settings,
            mode: 'resume',
            timeZone: browserTimeZone(),
          }
        : {
            sessionId: request.sessionId,
            message: request.message,
            agentId: request.agentId,
            settings: request.settings,
            timeZone: browserTimeZone(),
          },
      request.signal,
    )

    let finalResult: DoneEventData | null = null
    let runAnnounced = false
    // Set when the stream itself failed — stalled, dropped, or closed without
    // `done` — rather than the server reporting an error. The turn goes on
    // without the stream, so the answer is read back from what it persists.
    let lost: unknown = null

    // Typed SSE iteration — the parser handles frame buffering, malformed
    // JSON, partial reads, and yields discriminated `ChatStreamEvent`s.
    try {
      for await (const sseEvt of parseChatStream(response)) {
        // First event of the stream: the server-side early persist has
        // committed, so the sidebar can pick up the new row.
        if (!runAnnounced) {
          runAnnounced = true
          sink.onStarted()
        }

        // The wait ends when the box answers, and any frame at all is evidence
        // of that — the answer's own `message` frames, or `done`/`error` when the
        // cold call was the turn's last. Clearing on "anything except another
        // warming frame" rather than on a dedicated clear frame is deliberate: a
        // dropped clear frame would leave a spinner up forever, and there is no
        // frame here to drop. Checked BEFORE the per-type dispatch below so a
        // frame that `continue`s still clears.
        if (sseEvt.event === 'warming') {
          warming = true
          sink.onWarming(sseEvt.data)
          continue
        }
        clearWarming()

        if (sseEvt.event === 'done') {
          finalResult = sseEvt.data
          continue
        }
        if (sseEvt.event === 'error') {
          throw new Error(sseEvt.data.error)
        }
        if (sseEvt.event === 'title_updated') {
          // Server pushed the LLM-generated title for this conversation — the
          // caller patches its thread list in place. Lands regardless of which
          // thread the user is currently viewing.
          sink.onTitleUpdated(sseEvt.data.sessionId, sseEvt.data.title)
          continue
        }
        if (sseEvt.event !== 'message') continue // Forward-compat: ignore unknown event names

        const evt = sseEvt.data as ContextEvent
        sink.ingestProgress(evt)

        // Surface the currently-running tool for the composer guard. A
        // multi-call turn shows the batch size ("3 tools") instead of one name.
        if (evt.type === 'controller_action') {
          const data = evt.data as ControllerActionEventData
          const toolName = data.action?.tool_name
          const extraCalls = data.action?.additional_calls?.length ?? 0
          if (toolName && toolName !== 'Return') {
            transition({
              status: 'streaming',
              runningTool: extraCalls > 0 ? `${extraCalls + 1} tools` : toolName,
            })
          } else if (data.action?.is_final) {
            transition({ status: 'streaming', runningTool: null })
          }
        }

        // Inline error/warning bubbles belong to the run's own transcript, so
        // they are emitted here rather than waiting for the final result — a
        // backgrounded run that hits a recoverable error still shows it when the
        // user switches back (#105).
        if (evt.type === 'error') {
          // Presentation lives in `errorBubble` so this and `replayMessages`
          // cannot diverge — the bubble must look identical whether it was
          // painted from the live stream or rebuilt after a reload.
          sink.appendMessage({
            id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            timestamp: new Date(),
            patternId: evt.patternId,
            ...errorBubble(evt.data as ErrorEventData),
          })
        } else if (evt.type === 'warning') {
          // A side task failed and the turn carried on (#420) — same amber
          // bubble, from the same builder replay uses.
          const bubble: Message = {
            id: `warn-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            timestamp: new Date(),
            ...warningBubble(evt.data as WarningEventData),
          }
          if (finalResult) afterAnswer.push(bubble)
          else sink.appendMessage(bubble)
        }

        sink.pushEvents([evt])
        if (evt.type === 'tool_result') sink.pushGraph(extractGraphElements([evt]))
      }
    } catch (error) {
      if (!(error instanceof StreamLostError)) throw error
      lost = error
    }
    // No `done` means the answer has not arrived, and that includes a close
    // with no `done`: the server sends `done` or `error` before it closes, so
    // a bare close means the connection was cut.
    if (!finalResult && recovery) {
      console.warn(
        '[turn] the response stream ended without a result; reading the saved turn instead:',
        lost ?? 'closed without a done frame',
      )
      const persisted = await awaitPersistedTurn(recovery, request.signal)
      sink.finishProgress()
      clearWarming()
      recovery.rehydrate(persisted)
      const settled = settlePersisted(persisted)
      return { state: transition(settled.state), outcome: settled.outcome, aborted: false }
    }
    // A lost stream with no recovery, or a stall after `done` (the answer is
    // in hand; only the title or the close went missing), ends as before.
    if (!finalResult && lost) throw lost

    sink.finishProgress()
    clearWarming()

    if (finalResult?.context) sink.setContext(finalResult.context)

    const pendingIds = pendingRequestIds(finalResult)
    const finalResponse = finalResult?.response ?? ''
    // Only paint an answer when there is a real one — an error status with a
    // stale or empty response is not a reply.
    if (finalResponse && finalResult?.status !== 'error') {
      sink.appendMessage({
        id: Date.now().toString(),
        role: 'assistant',
        content: finalResponse,
        timestamp: new Date(),
        // Retriever citations for this turn (inline superscripts + footer).
        references: extractReferences(finalResult?.context?.events ?? []),
        // Server-computed link verdicts, from the done frame (#901 slice 1).
        recognisedLinkHosts: finalResult?.recognisedLinkHosts,
      })
    }
    flushAfterAnswer()

    if (finalResult?.status === 'error') {
      return {
        state: transition({ status: 'error', message: finalResponse }),
        outcome: 'error',
        aborted: false,
      }
    }
    if (pendingIds.length > 0) {
      return {
        state: transition({ status: 'awaiting-decision', requestIds: pendingIds }),
        outcome: 'done',
        aborted: false,
      }
    }
    return { state: transition({ status: 'done' }), outcome: 'done', aborted: false }
  } catch (error) {
    sink.finishProgress()
    clearWarming()
    flushAfterAnswer()
    // An AbortError is a torn-down stream, not a failed run: the chain keeps
    // going server-side and persists its result.
    if (error instanceof DOMException && error.name === 'AbortError') {
      return { state: transition({ status: 'stopped' }), outcome: 'done', aborted: true }
    }
    const message = error instanceof Error ? error.message : 'Unknown error'
    console.error('Error processing message:', error)
    sink.appendMessage({
      id: Date.now().toString(),
      role: 'error',
      content: message,
      timestamp: new Date(),
    })
    return { state: transition({ status: 'error', message }), outcome: 'error', aborted: false }
  }
}

/**
 * The HITL requests a paused `done` frame names: `hitl_request` events with no
 * `hitl_response` for the same id. Core's own reader is server-only, so this is
 * only a HINT for the client's state — the card, toast and inbox read the
 * authoritative pending set from the server, and nothing here gates an answer.
 */
function pendingRequestIds(
  final: Pick<DoneEventData, 'status' | 'context'> | null,
): readonly string[] {
  if (final?.status !== 'paused') return []
  const events = final.context?.events ?? []
  const idOf = (e: { data: unknown }) => (e.data as { requestId?: unknown }).requestId
  const answered = new Set(events.filter((e) => e.type === 'hitl_response').map(idOf))
  return events
    .filter((e) => e.type === 'hitl_request')
    .map(idOf)
    .filter((id): id is string => typeof id === 'string' && !answered.has(id))
}

/**
 * Wait until no turn holds the conversation, then load what it saved. A
 * transient read failure polls again; Stop (the turn's signal) ends the wait
 * as a teardown. A conversation that never gets a row throws, which the caller
 * paints as an error: there is no saved turn to show.
 */
async function awaitPersistedTurn(
  recovery: TurnRecovery,
  signal: AbortSignal,
): Promise<PersistedTurn> {
  let missing = 0
  for (;;) {
    if (signal.aborted) throw stopped()
    const state = await recovery.turnState().catch((err: unknown) => {
      console.warn('[turn] could not read whether the turn finished; retrying:', err)
      return undefined
    })
    if (state && !state.turnInFlight) return recovery.load()
    if (state === null && ++missing >= RECOVERY_MISSING_POLLS) {
      throw new Error('The response stream was lost and the conversation was not saved.')
    }
    await sleep(RECOVERY_POLL_MS, signal)
  }
}

/** Where a recovered turn ended, read from its saved row and context. */
function settlePersisted(turn: PersistedTurn): { state: TurnState; outcome: RunOutcome } {
  if (turn.status === 'error') {
    const last = turn.messages.at(-1)
    return {
      state: { status: 'error', message: last?.role === 'error' ? last.content : '' },
      outcome: 'error',
    }
  }
  const pendingIds = pendingRequestIds({ status: turn.status, context: turn.context })
  if (pendingIds.length > 0) {
    return { state: { status: 'awaiting-decision', requestIds: pendingIds }, outcome: 'done' }
  }
  return { state: { status: 'done' }, outcome: 'done' }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(stopped())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Stop during the wait is a teardown, the same `AbortError` a Stop mid-stream raises. */
function stopped(): DOMException {
  return new DOMException('Stopped while waiting for the saved turn', 'AbortError')
}
