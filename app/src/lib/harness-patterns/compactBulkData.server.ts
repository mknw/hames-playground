/**
 * compactBulkData — Background Tool Result Compaction - Server Only
 *
 * The third member of the compaction family (`compactIntent` upstream of a
 * chain, `compactExecution` at its end, `compactBulkData` after the turn):
 * fires once the SSE response has been sent to the user, and summarizes the
 * turn's `tool_result` events with the lightweight describe-tier client.
 * Summaries are stored on the event data and persisted to session storage,
 * so they're available as compact pointers on subsequent turns.
 *
 * The turn's results are summarized in BATCHES — one `ResultDescribeBatch` call
 * carries up to `MAX_BATCH_ITEMS` results and returns one summary per item,
 * keyed by an id it echoes back (#83 Part E). Before that, a 6-result turn cost
 * 6 round-trips and 6 copies of the same system prompt. Anything the batch
 * leaves unanswered — a dropped id, a blank summary, a failed call — falls back
 * to the single-item `ResultDescribe` path for that item alone.
 */

import { assertServerOnImport } from './assert.server'
import { enrichToolResult } from './context.server'
import {
  describeToolResultOp,
  describeToolResultsBatchOp,
  type DescribeBatchItem,
} from './baml-adapters.server'
import type {
  UnifiedContext,
  ToolResultEventData,
  ToolCallEventData,
  ControllerActionEventData
} from './types'
import { getRequestSettings } from '../settings-context.server'
import { estimateTokens, getContextWindow } from './token-budget.server'
import { resolveClientForRole } from './clients.server'

assertServerOnImport()

/**
 * Max tool results folded into one `ResultDescribeBatch` call.
 *
 * Bounded by the OUTPUT side, not the input: each summary is capped at ~200
 * tokens by the prompt, so 8 items ≈ 1.6K output tokens — an order of magnitude
 * under the describe client's cap, leaving room for a verbose batch. A
 * truncated response would silently drop the tail items (the per-item fallback
 * repairs it, but at the cost the batching exists to avoid).
 */
export const MAX_BATCH_ITEMS = 8

/** Fraction of the describe client's context window a single batch's INPUT may
 *  occupy. Items are already individually capped at `maxResultForSummary`, so
 *  this only bites when that setting is raised a long way. */
const BATCH_INPUT_WINDOW_SHARE = 0.25

/** A tool result queued for summarization, with the context its prompt needs. */
interface CompactionTarget extends DescribeBatchItem {
  /** `ContextEvent.id` of the tool_result this summary belongs on. */
  eventId: string
}

/**
 * Split targets into batches of at most `MAX_BATCH_ITEMS` that also fit the
 * describe client's input budget. An item too large to share a batch with
 * anything ends up alone, which routes it back to the single-item call.
 */
function batchTargets(targets: CompactionTarget[], budgetTokens: number): CompactionTarget[][] {
  const batches: CompactionTarget[][] = []
  let current: CompactionTarget[] = []
  let currentTokens = 0

  for (const target of targets) {
    const cost = estimateTokens(target.result) + estimateTokens(target.toolArgs)
    const full = current.length >= MAX_BATCH_ITEMS
    const overBudget = current.length > 0 && currentTokens + cost > budgetTokens
    if (full || overBudget) {
      batches.push(current)
      current = []
      currentTokens = 0
    }
    current.push(target)
    currentTokens += cost
  }
  if (current.length > 0) batches.push(current)
  return batches
}

/**
 * Summarize all tool_result events from the most recent user turn.
 * Mutates ctx.events in-place, then calls onPersist() to re-serialize.
 *
 * @param ctx - The live UnifiedContext object (mutated in-place)
 * @param onPersist - Callback to re-serialize the context to session storage
 */
export async function compactBulkData(
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

  const maxSummaryChars = getRequestSettings().maxResultForSummary

  // Build one target per result still wanting a summary. Ids are positional
  // labels rather than event ids: short to echo, cheap in both directions, and
  // never leaking a storage identifier into a prompt.
  const targets: CompactionTarget[] = []
  for (const resultEvent of toolResults) {
    const d = resultEvent.data as ToolResultEventData
    if (d.hidden || d.archived || d.summary) continue

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
    const rawResult = typeof d.result === 'string' ? d.result : JSON.stringify(d.result)
    const resultStr = rawResult.length > maxSummaryChars
      ? rawResult.slice(0, maxSummaryChars) + '...[truncated]'
      : rawResult

    targets.push({
      id: String(targets.length + 1),
      eventId: resultEvent.id!,
      tool: d.tool,
      toolArgs,
      reasoning,
      result: resultStr,
    })
  }

  const summarizeOne = async (target: CompactionTarget): Promise<void> => {
    const summary = await describeToolResultOp(
      target.tool,
      target.toolArgs,
      target.reasoning,
      target.result,
    )
    if (summary) enrichToolResult(ctx, target.eventId, { summary })
  }

  const summarizeBatch = async (batch: CompactionTarget[]): Promise<void> => {
    // A lone target skips the batch prompt entirely — same cost, and the
    // single-item prompt is the one tuned for it.
    if (batch.length === 1) return summarizeOne(batch[0])

    const byId = await describeToolResultsBatchOp(batch)
    const unanswered: CompactionTarget[] = []
    for (const target of batch) {
      const summary = byId.get(target.id)
      if (summary) enrichToolResult(ctx, target.eventId, { summary })
      else unanswered.push(target)
    }
    // Partial answer: only the items the batch missed pay for a second call.
    if (unanswered.length > 0) {
      await Promise.allSettled(unanswered.map(summarizeOne))
    }
  }

  if (targets.length > 0) {
    const budgetTokens = Math.floor(
      getContextWindow(resolveClientForRole('describe')) * BATCH_INPUT_WINDOW_SHARE,
    )
    // Batches run concurrently — they're independent calls on a fast model.
    await Promise.allSettled(batchTargets(targets, budgetTokens).map(summarizeBatch))
  }

  await onPersist()
}
