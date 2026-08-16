/**
 * Background Tool Result Summarization - Server Only
 *
 * Fires after the SSE response is sent to the user. Summarizes tool_result
 * events from the current turn using a lightweight model (DescribeFallback).
 * Summaries are stored on the event data and persisted to session storage,
 * so they're available as compact pointers on subsequent turns.
 */

import { assertServerOnImport } from './assert.server'
import { enrichToolResult } from './context.server'
import { describeToolResultOp } from './baml-adapters.server'
import type {
  UnifiedContext,
  ToolResultEventData,
  ToolCallEventData,
  ControllerActionEventData
} from './types'
import { getRequestSettings } from '../settings-context.server'

assertServerOnImport()

/**
 * Summarize all tool_result events from the most recent user turn.
 * Mutates ctx.events in-place, then calls onPersist() to re-serialize.
 *
 * @param ctx - The live UnifiedContext object (mutated in-place)
 * @param onPersist - Callback to re-serialize the context to session storage
 */
export async function scheduleSummarization(
  ctx: UnifiedContext,
  onPersist: () => Promise<void>
): Promise<void> {
  const events = ctx.events

  // Find events from the current turn (since last user_message)
  let turnStart = 0
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === 'user_message') {
      turnStart = i
      break
    }
  }
  const turnEvents = events.slice(turnStart)

  // Collect tool_result events that need summarization
  const toolResults = turnEvents.filter(
    e => e.type === 'tool_result' && e.id && (e.data as ToolResultEventData).success
  )
  if (toolResults.length === 0) return

  // Summarize each result in parallel (all use a fast/tiny model)
  const summaryTasks = toolResults.map(async (resultEvent) => {
    const d = resultEvent.data as ToolResultEventData
    if (d.hidden || d.archived || d.summary) return

    // Find paired tool_call by callId for argument context
    const callEvent = d.callId
      ? turnEvents.find(
          e => e.type === 'tool_call' && (e.data as ToolCallEventData).callId === d.callId
        )
      : undefined
    const toolArgs = callEvent
      ? JSON.stringify((callEvent.data as ToolCallEventData).args)
      : '{}'

    // Find the controller_action that preceded this result for reasoning context
    const resultIdx = turnEvents.indexOf(resultEvent)
    const actionEvent = turnEvents
      .slice(0, resultIdx)
      .reverse()
      .find(e => e.type === 'controller_action')
    const reasoning = actionEvent
      ? (actionEvent.data as ControllerActionEventData).action.reasoning
      : ''

    // Truncate raw result to avoid overwhelming the summarizer
    const maxSummaryChars = getRequestSettings().maxResultForSummary
    const rawResult = typeof d.result === 'string' ? d.result : JSON.stringify(d.result)
    const resultStr = rawResult.length > maxSummaryChars
      ? rawResult.slice(0, maxSummaryChars) + '...[truncated]'
      : rawResult

    const summary = await describeToolResultOp(d.tool, toolArgs, reasoning, resultStr)
    if (summary) {
      enrichToolResult(ctx, resultEvent.id!, { summary })
    }
  })

  await Promise.allSettled(summaryTasks)
  await onPersist()
}
