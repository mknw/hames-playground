/**
 * Built-in content transforms for EventView.
 *
 * These are read-time lenses — they never mutate stored events.
 * Each transform takes a ContextEvent and returns a new one.
 */

import type {
  ContextEvent,
  ContentTransform,
  AssistantMessageEventData,
  ToolResultEventData,
} from './types'

/** Strip <think>...</think> chain-of-thought blocks from assistant messages.
 *  Useful for router history where reasoning tokens waste context and confuse smaller models. */
export const stripThinkBlocks: ContentTransform = (event: ContextEvent): ContextEvent => {
  if (event.type !== 'assistant_message') return event
  const data = event.data as AssistantMessageEventData
  const cleaned = data.content.replace(/<think>[\s\S]*?<\/think>\s*/g, '')
  if (cleaned === data.content) return event // No change, return original
  return {
    ...event,
    data: { ...data, content: cleaned },
  }
}

/** Truncate long tool results to a maximum character count.
 *  Returns a factory — call with max chars: `truncateToolResults(2000)`. */
export const truncateToolResults =
  (maxChars: number): ContentTransform =>
  (event: ContextEvent): ContextEvent => {
    if (event.type !== 'tool_result') return event
    const data = event.data as ToolResultEventData
    const resultStr = typeof data.result === 'string' ? data.result : JSON.stringify(data.result)
    if (resultStr.length <= maxChars) return event
    return {
      ...event,
      data: { ...data, result: resultStr.slice(0, maxChars) + '...[truncated]' },
    }
  }

/**
 * Delete named fields from a tool result, recursively — the lens behind
 * `SimpleLoopConfig.resultOmit`.
 *
 * Same charter as every transform in this file: read-time only, never a
 * mutation of stored data. simpleLoop applies it when building the CONTROLLER
 * TURN LOG, after the full result has already been written to the event store —
 * so the compactExecution, citation extractors and session persistence always see
 * the complete result, and only the loop LLM gets the compact view.
 *
 * Semantics:
 *  - `omit` empty/undefined → identity (same reference, zero cost).
 *  - Primitives (strings, numbers, booleans, null) pass through at every level.
 *    A tool that returns pre-serialized JSON as a string is therefore
 *    unaffected even when it has an omit entry.
 *  - Arrays recurse element-wise; plain objects drop the named keys at EVERY
 *    nesting level and recurse into what remains.
 *
 * Why an omit-list and not a fields-to-keep list: the concrete need is "drop
 * the bulky field" (e.g. a 519-char Loop webUrl that only the compactExecution
 * uses), and an allowlist would silently hide every field a tool adds later
 * until someone remembered to update each agent config. Bloat that slips
 * through an omit-list is visible in token counts; information an allowlist
 * swallows is invisible.
 */
export function omitResultFields(result: unknown, omit: readonly string[] | undefined): unknown {
  if (!omit || omit.length === 0) return result
  if (Array.isArray(result)) return result.map((item) => omitResultFields(item, omit))
  if (result === null || typeof result !== 'object') return result
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(result)) {
    if (omit.includes(key)) continue
    out[key] = omitResultFields(value, omit)
  }
  return out
}
