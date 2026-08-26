/**
 * The streaming turn — one user message, one SSE stream, one transcript
 * (#226 B2).
 *
 * This used to be `ChatInterface.runSend`: 223 lines inside a Solid component
 * doing the POST, the SSE iteration, the per-event-type dispatch, the run-state
 * transitions, the assistant-message construction (including the paused
 * `pendingAction` shape) and a `finally` that had to fire four callbacks in
 * order. None of it could be exercised without mounting a component and
 * stubbing `fetch`, and it had already drifted from its sibling —
 * `handleApproveWrite` repeated the same graph/events/context fan-out with
 * different semantics.
 *
 * The module is framework-free: no Solid, no DOM. It takes a `TurnRequest`,
 * writes through a narrow `TurnSink` of effects, and reports where the turn
 * ended as an explicit `TurnState`. The component becomes wiring, the state
 * machine is testable against a scripted event array, and the approval path
 * (`applyApprovalResult`) feeds the *same* sink, so the two cannot drift.
 *
 * The wire format is untouched — `parseChatStream` still owns it.
 */
import { extractGraphElements, extractGraphFromResult } from '~/lib/harness-client/graph-extractor'
import { extractReferences } from '~/lib/harness-client/reference-extractor'
// Imported from the module rather than the barrel: `replay.ts` is deliberately
// dependency-free (no server-only imports), and the stream handler wants
// exactly that guarantee.
import { errorBubble } from '~/lib/harness-client/replay'
import { parseChatStream, type DoneEventData, type WarmingEventData } from '~/lib/sse-client'
import { openChatStream } from '~/lib/api-client'
import type { Message } from '~/components/ark-ui/ChatMessages'
import type { GraphElement } from '~/lib/harness-client/types'
import type {
  ContextEvent,
  UnifiedContext,
  ControllerActionEventData,
  ErrorEventData,
} from '~/lib/harness-patterns'
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
 * differently: `done` and `awaiting-approval` are results worth announcing,
 * `error` paints a bubble, and `stopped` is a torn-down stream — either the
 * user's Stop or page teardown — which by itself says nothing about the run,
 * because the chain keeps going server-side.
 */
export type TurnState =
  | { status: 'idle' }
  | { status: 'streaming'; runningTool: string | null }
  | { status: 'awaiting-approval'; tool: string; reason: string }
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
export async function runTurn(request: TurnRequest, sink: TurnSink): Promise<TurnResult> {
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

  try {
    const response = await openChatStream(
      {
        sessionId: request.sessionId,
        message: request.message,
        agentId: request.agentId,
        settings: request.settings,
      },
      request.signal,
    )

    let finalResult: DoneEventData | null = null
    let runAnnounced = false

    // Typed SSE iteration — the parser handles frame buffering, malformed
    // JSON, partial reads, and yields discriminated `ChatStreamEvent`s.
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
      }

      sink.pushEvents([evt])
      if (evt.type === 'tool_result') sink.pushGraph(extractGraphElements([evt]))
    }

    sink.finishProgress()
    clearWarming()

    if (finalResult?.context) sink.setContext(finalResult.context)

    const pending = pendingActionOf(finalResult)
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
        toolCall: pending
          ? {
              type: 'neo4j',
              status: 'pending',
              tool: pending.action,
              explanation: pending.reason,
              isReadOnly: false,
            }
          : undefined,
      })
    }

    if (finalResult?.status === 'error') {
      return {
        state: transition({ status: 'error', message: finalResponse }),
        outcome: 'error',
        aborted: false,
      }
    }
    if (pending) {
      return {
        state: transition({
          status: 'awaiting-approval',
          tool: pending.action,
          reason: pending.reason,
        }),
        outcome: 'done',
        aborted: false,
      }
    }
    return { state: transition({ status: 'done' }), outcome: 'done', aborted: false }
  } catch (error) {
    sink.finishProgress()
    clearWarming()
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

/** The paused write a `done` frame is asking approval for, if any. */
function pendingActionOf(
  final: DoneEventData | null,
): { action: string; reason: string } | undefined {
  if (final?.status !== 'paused') return undefined
  const pending = (final.data as Record<string, unknown>).pendingAction as
    { action: string; reason: string } | undefined
  return pending
}

// ============================================================================
// The approval path
// ============================================================================

/**
 * Fan a resumed run's result out through the same sink the streaming turn
 * uses. This is the half that had drifted: it slices an event *delta* (the
 * approval resumes an existing context, so `result.context.events` is the
 * whole history) where `runTurn` emits each event as it arrives.
 *
 * Returns the new event cursor.
 */
export function applyApprovalResult(
  result: { context?: UnifiedContext },
  fromEventIndex: number,
  sink: TurnSink,
): number {
  sink.pushGraph(extractGraphFromResult(result))
  if (!result.context) return fromEventIndex

  const events = result.context.events
  if (events) sink.pushEvents(events.slice(fromEventIndex))
  sink.setContext(result.context)
  return events?.length ?? fromEventIndex
}
