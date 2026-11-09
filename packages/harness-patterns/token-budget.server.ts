/**
 * Token Budget Estimation & History Trimming - Server Only
 *
 * Estimates prompt token counts and trims oldest history entries
 * when the prompt would exceed a model's context window.
 */

import { assertServerOnImport } from './assert.server'

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

/**
 * Replace the oldest items that have a compact form with it, one at a time,
 * until the serialized whole fits the same budget {@link trimToFit} spends
 * against (#1032: a route call's complete trace falls back to its compact
 * record). Items with no compact form are kept as they are. When every compact
 * form is in and it still does not fit, the caller's `trimToFit` drops whole
 * items next, as it always has.
 *
 * @returns the items, and the indices that were replaced, oldest first
 */
export function degradeToFit<T>(
  items: T[],
  compactOf: (item: T, index: number) => T | undefined,
  serializer: (items: T[]) => string,
  basePromptChars: number,
  contextWindowTokens: number,
): { items: T[]; degraded: number[] } {
  const budgetTokens = contextWindowTokens - OUTPUT_RESERVE
  const fits = (arr: T[]) =>
    budgetTokens <= 0 ||
    estimateTokens(serializer(arr)) + Math.ceil(basePromptChars / CHARS_PER_TOKEN) <= budgetTokens
  const out = [...items]
  const degraded: number[] = []
  for (let i = 0; i < out.length && !fits(out); i++) {
    const compact = compactOf(items[i], i)
    if (compact === undefined) continue
    out[i] = compact
    degraded.push(i)
  }
  return { items: out, degraded }
}
