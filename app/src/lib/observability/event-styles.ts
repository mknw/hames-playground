/**
 * Per-event and per-pattern presentation tables for the observability
 * timeline — pure lookups, no rendering. Split out of
 * `ObservabilityPanel.tsx` (#226 B5).
 *
 * The colours are consumed through inline `style`, not utility classes, so
 * they are literal hexes by necessity (a dynamic class would never be
 * extracted by UnoCSS).
 *
 * The GLYPHS are the opposite case: they are `i-material-symbols-*` utility
 * classes (they used to be emoji), so the literals below have to be extracted
 * — which is what the `@unocss-include` marker in this comment buys. UnoCSS's
 * pipeline rejects plain `.ts` paths without it, and an unextracted icon class
 * renders as an empty span with no error. See the note at the top of
 * `uno.config.ts`.
 *
 * @unocss-include
 */

import type { EventType } from '../harness-patterns'
import patternColorsJson from '../../../pattern-colors.json'

// ============================================================================
// Pattern Colors (loaded from pattern-colors.json)
// ============================================================================

export interface PatternColorEntry {
  color: string
  tint: string
}

const patternColors = patternColorsJson as unknown as Record<string, PatternColorEntry>
const defaultPatternColor: PatternColorEntry = patternColors._default ?? {
  color: '#94a3b8',
  tint: 'rgba(148,163,184,0.06)',
}

export function getPatternColor(patternId: string): PatternColorEntry {
  return patternColors[patternId] ?? defaultPatternColor
}

// ============================================================================
// Event Icons and Colors
// ============================================================================

export const eventIconClasses: Record<EventType, string> = {
  user_message: 'i-material-symbols-chat-outline',
  assistant_message: 'i-material-symbols-smart-toy-outline',
  tool_call: 'i-material-symbols-build-outline',
  tool_result: 'i-material-symbols-download',
  controller_action: 'i-material-symbols-adjust',
  critic_result: 'i-material-symbols-rate-review-outline',
  pattern_enter: 'i-material-symbols-play-arrow',
  pattern_exit: 'i-material-symbols-stop',
  approval_request: 'i-material-symbols-pause-circle-outline',
  approval_response: 'i-material-symbols-check-circle-outline',
  error: 'i-material-symbols-cancel-outline',
  reference_attached: 'i-material-symbols-link',
  // Same glyph as controller_action, as the emoji table had: both are an LLM
  // reasoning step (see the eventColors note below).
  intent_compacted: 'i-material-symbols-adjust',
  plan_created: 'i-material-symbols-map-outline',
  // The same shield SanitizedChip uses for the guard's own chip.
  content_sanitized: 'i-material-symbols-shield-outline',
}

export const eventColors: Record<EventType, string> = {
  user_message: '#60a5fa', // blue-400
  assistant_message: '#34d399', // green-400
  tool_call: '#a78bfa', // violet-400
  tool_result: '#22d3ee', // cyan-400
  controller_action: '#fbbf24', // amber-400
  critic_result: '#f472b6', // pink-400
  pattern_enter: '#94a3b8', // overridden per-pattern
  pattern_exit: '#94a3b8', // overridden per-pattern
  approval_request: '#f97316', // orange-500
  approval_response: '#10b981', // emerald-500
  error: '#ef4444', // red-500
  reference_attached: '#c084fc', // purple-400
  intent_compacted: '#fbbf24', // amber-400 (an LLM reasoning step, like controller_action)
  plan_created: '#fbbf24', // amber-400 (same family: an LLM reasoning step, no tool call)
  content_sanitized: '#fb923c', // orange-400 — a control firing on hostile input,
  // deliberately distinct from `error` red (nothing failed) and from the cyan
  // tool_result it annotates (this is not a result)
}
