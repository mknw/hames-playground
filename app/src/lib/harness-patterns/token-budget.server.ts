/**
 * Token Budget Estimation & History Trimming - Server Only
 *
 * Estimates prompt token counts and trims oldest history entries
 * when the prompt would exceed a model's context window.
 */

import { assertServerOnImport } from './assert.server'
import { MODEL_CONTEXT_WINDOWS } from '../settings'

assertServerOnImport()

/** Conservative char-to-token ratio (1 token ~ 4 chars) */
const CHARS_PER_TOKEN = 4

/** Tokens reserved for model output */
const OUTPUT_RESERVE = 4096

/** Estimate token count from a string */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/**
 * Get context window (tokens) for a BAML client name.
 * Falls back to 16K if client is unknown.
 */
export function getContextWindow(clientName?: string): number {
  if (clientName && MODEL_CONTEXT_WINDOWS[clientName]) {
    return MODEL_CONTEXT_WINDOWS[clientName]
  }
  return 16_384
}

/**
 * Trim oldest entries from an array to fit within a token budget.
 *
 * @param items - Array of items (e.g., turns, history messages)
 * @param serializer - Function to serialize items to a string for estimation
 * @param basePromptChars - Approximate chars of the prompt template (fixed overhead)
 * @param contextWindowTokens - Model's context window in tokens
 * @returns Trimmed array (drops oldest entries first)
 */
export function trimToFit<T>(
  items: T[],
  serializer: (items: T[]) => string,
  basePromptChars: number,
  contextWindowTokens: number,
): T[] {
  const budgetTokens = contextWindowTokens - OUTPUT_RESERVE
  if (budgetTokens <= 0) return items

  const estimateTotal = (arr: T[]) =>
    estimateTokens(serializer(arr)) + Math.ceil(basePromptChars / CHARS_PER_TOKEN)

  if (estimateTotal(items) <= budgetTokens) return items

  // Drop oldest items until under budget (keep at least 1)
  const trimmed = [...items]
  while (trimmed.length > 1) {
    trimmed.shift()
    if (estimateTotal(trimmed) <= budgetTokens) break
  }
  return trimmed
}
