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
 * status, and status must stay readable on top of agent identity. #1008 left
 * these as they were: they are status colours, not neon chrome, and the run
 * state must stay legible whatever the palette around them does:
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

/** Family token → hex. Tuned for the #0f1115 background (#1008: the same five
 *  hues at lower brightness, matching the toned-down graph data colours). */
export const AGENT_ACCENTS = {
  /** general-purpose — the house indigo */
  indigo: '#7d84e0',
  /** code execution */
  amber: '#d9a844',
  /** sandboxed compute, any flavour */
  orange: '#d98a52',
  /** knowledge work: research + retrieval */
  violet: '#9484d6',
  /** third-party integrations */
  blue: '#5f94d6',
} as const

/** Removed agents and rows whose agent no longer resolves. */
export const AGENT_ACCENT_FALLBACK = '#9aa1ab'

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
