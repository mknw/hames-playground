/**
 * Agent accent palette.
 *
 * Colour encodes an agent *family*, not an individual agent: the icon glyph
 * already separates agents within a family, so a small set of far-apart hues
 * beats one-hue-per-agent (which, with the reserved colours below excluded,
 * forces near-neighbours that read identically at 14px). A new sandbox
 * flavour inherits `sandbox` rather than needing a novel hue.
 *
 * RESERVED — never assign these to an agent. The sidebar spends them on run
 * status, and status must stay readable on top of agent identity:
 *   cyan  #22d3ee  live run / selected row
 *   green #4ade80  completed  (completionBorderColor)
 *   red   #f87171  errored    (completionBorderColor)
 * Agent accent lands on the *glyph*; status colour lands on the row border,
 * rail dot and badge — different surfaces, so the two coexist.
 *
 * Plain `.ts` with no server imports: both `registry.server.ts` and the
 * client components resolve through this one module. Values are applied via
 * inline `style` / a CSS custom property, never as utility classes — so
 * nothing here depends on UnoCSS extraction.
 */

/** Accent token stored on `AgentConfig.accent` and sent over the wire. */
export type AgentAccent = keyof typeof AGENT_ACCENTS

/** Family token → hex. Tuned for the #0a0a0f background. */
export const AGENT_ACCENTS = {
  /** general-purpose — the house indigo */
  indigo: '#818cf8',
  /** code execution / code-mode */
  amber: '#fbbf24',
  /** sandboxed compute, any flavour */
  orange: '#fb923c',
  /** knowledge work: research + retrieval */
  violet: '#a78bfa',
  /** third-party integrations */
  blue: '#60a5fa',
} as const

/** Removed agents and rows whose agent no longer resolves. */
export const AGENT_ACCENT_FALLBACK = '#a1a1aa'

/**
 * Resolve an accent token to a hex colour. Unknown or absent tokens fall back
 * to neutral zinc — a conversation whose agent was deregistered still renders,
 * it just stops claiming a family.
 */
export function accentColor(accent?: string): string {
  // hasOwnProperty, not `in`: the token arrives off the wire, and `in` would
  // happily resolve 'toString' / 'constructor' against the prototype chain.
  if (accent && Object.prototype.hasOwnProperty.call(AGENT_ACCENTS, accent)) {
    return AGENT_ACCENTS[accent as AgentAccent]
  }
  return AGENT_ACCENT_FALLBACK
}
