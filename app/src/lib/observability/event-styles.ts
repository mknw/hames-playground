/**
 * Per-event and per-pattern presentation tables for the observability
 * timeline — pure lookups, no rendering. Split out of
 * `ObservabilityPanel.tsx` (#226 B5); the values are unchanged.
 *
 * The colours are consumed through inline `style`, not utility classes, so
 * they are literal hexes by necessity (a dynamic class would never be
 * extracted by UnoCSS).
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

export const eventIcons: Record<EventType, string> = {
  user_message: '💬',
  assistant_message: '🤖',
  tool_call: '🔧',
  tool_result: '📥',
  controller_action: '🎯',
  critic_result: '📝',
  pattern_enter: '▶',
  pattern_exit: '■',
  approval_request: '⏸️',
  approval_response: '✅',
  error: '❌',
  reference_attached: '🔗',
  intent_compacted: '🎯',
  plan_created: '🗺️',
  content_sanitized: '🛡️',
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
