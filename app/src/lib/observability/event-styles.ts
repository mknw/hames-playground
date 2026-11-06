/**
 * Per-event and per-pattern presentation tables for the observability
 * timeline — pure lookups, no rendering. Split out of
 * `ObservabilityPanel.tsx` (#226 B5).
 *
 * The colours are consumed through inline `style`, not utility classes, so
 * they cannot be dynamic utilities — but since #1008 round 2 they are not
 * literal hexes either: a label colour has to pass WCAG AA on its row ground
 * in BOTH themes, and no single hex can (a colour light enough for the dark
 * ground is too light for white). Each entry is therefore a `var(--ui-…)`
 * resolved by the theme palette in `uno.config.ts` — the muted dark and
 * light values of every pair live there, and
 * `src/__tests__/lib/observability/event-contrast.test.ts` generates the
 * stylesheet and asserts the 4.5:1 floor per label per theme.
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

import type { EventType } from '@hames-ai/harness-patterns'
import patternColorsJson from '../../../pattern-colors.json'

// ============================================================================
// Pattern Colors (loaded from pattern-colors.json)
// ============================================================================

export interface PatternColorEntry {
  /** Theme-aware: `var(--ui-pat-<id>)`, falling back to the default tone. */
  color: string
  /** The 6% background wash, from pattern-colors.json (theme-agnostic). */
  tint: string
}

const patternColors = patternColorsJson as unknown as Record<string, { tint: string }>
// The id-derived name of pattern-colors.json's `_default` entry — a var the
// palette does not declare would leave every unlisted pattern unstyled.
const DEFAULT_PATTERN_VAR = 'var(--ui-pat-_default)'

export function getPatternColor(patternId: string): PatternColorEntry {
  const entry = patternColors[patternId]
  if (!entry) return { color: DEFAULT_PATTERN_VAR, tint: patternColors._default.tint }
  // A var name composed from the id resolves at paint time; an id the
  // preflight does not declare falls through the var's fallback.
  return {
    color: `var(--ui-pat-${patternId}, ${DEFAULT_PATTERN_VAR})`,
    tint: entry.tint,
  }
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
  // The chat Warning bubble's glyph, in the outline style the rest of this
  // table uses, so the two read as one thing.
  warning: 'i-material-symbols-warning-outline',
  // A failure the loop fed back and went round again on (#437).
  loop_recovery: 'i-material-symbols-replay',
  // A person is asked to decide, and the decision (#433): the same pause and
  // check glyphs as the legacy approval pair they supersede.
  hitl_request: 'i-material-symbols-pause-circle-outline',
  hitl_response: 'i-material-symbols-check-circle-outline',
  // One typed decision the policy layer evaluated (#418): a rule applied to a
  // distribution, which is what the glyph draws.
  decision_made: 'i-material-symbols-rule',
  // What memory recall attached, or why nothing (#419). Placeholder entry —
  // the memory UI slice owns the presentation.
  memory_recalled: 'i-material-symbols-memory-outline',
  memory_written: 'i-material-symbols-memory-outline',
  // A screen or summary model call: its own step, no pattern's output.
  model_call: 'i-material-symbols-bolt-outline',
  // The egress gate let a roster-matched call go (an audit row), or refused one.
  // The refusal uses the egress prompt's own Refuse glyph.
  egress_audit: 'i-material-symbols-fact-check-outline',
  egress_refused: 'i-material-symbols-block',
  egress_blocked: 'i-material-symbols-block',
}

/** A theme-resolving CSS custom property per event type (see the header). */
const varname = (type: EventType): string => `var(--ui-evt-${type.replace(/_/g, '-')})`

export const eventColors: Record<EventType, string> = {
  user_message: varname('user_message'), // blue
  assistant_message: varname('assistant_message'), // green
  tool_call: varname('tool_call'), // violet
  tool_result: varname('tool_result'), // cyan
  controller_action: varname('controller_action'), // amber
  critic_result: varname('critic_result'), // pink
  pattern_enter: varname('pattern_enter'), // slate; overridden per-pattern
  pattern_exit: varname('pattern_exit'), // slate; overridden per-pattern
  approval_request: varname('approval_request'), // orange
  approval_response: varname('approval_response'), // green
  error: varname('error'), // red
  reference_attached: varname('reference_attached'), // plum
  intent_compacted: varname('intent_compacted'), // amber (an LLM reasoning step, like controller_action)
  plan_created: varname('plan_created'), // amber (same family: an LLM reasoning step, no tool call)
  content_sanitized: varname('content_sanitized'), // orange — a control firing on hostile input,
  // deliberately distinct from `error` red (nothing failed) and from the cyan
  // tool_result it annotates (this is not a result)
  warning: varname('warning'), // gold — the chat Warning bubble's hue: a side task
  // failed and the turn ran on a fallback (#420), so neither error red nor the
  // orange of a control firing
  loop_recovery: varname('loop_recovery'), // lime — a failure the loop routed around
  // (#437): something did fail, so not the cyan of a result, and the turn
  // carried on, so not error red
  hitl_request: varname('hitl_request'), // orange — the legacy approval pair's hues (#433)
  hitl_response: varname('hitl_response'), // green
  decision_made: varname('decision_made'), // indigo — a measured judgement (#418): not amber, which is
  // an LLM reasoning step that produced text or a tool call, and not the
  // orange of a control firing on hostile input
  memory_recalled: varname('memory_recalled'), // teal — placeholder entry; #419's UI slice owns the hue
  memory_written: varname('memory_written'), // same placeholder as memory_recalled
  model_call: varname('model_call'), // amber — a model call, the family of controller_action and
  // intent_compacted; what it is NOT is a result, so not tool_result's cyan
  egress_audit: varname('egress_audit'), // orange — a control's record on outgoing data, the
  // content_sanitized family: not error red, and not a result
  egress_refused: varname('egress_refused'), // same family: the egress control firing
  egress_blocked: varname('egress_blocked'),
}
