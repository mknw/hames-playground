/**
 * Agent accent palette — token resolution and the reserved-colour contract.
 */
import { describe, it, expect } from 'vitest'
import {
  AGENT_ACCENTS,
  AGENT_ACCENT_FALLBACK,
  accentColor,
} from '../../lib/agent-palette'

/** Spent by the sidebar on run status; see completionBorderColor / railDot. */
const RESERVED = ['#22d3ee', '#4ade80', '#f87171']

describe('accentColor', () => {
  it('resolves every declared family token', () => {
    for (const [token, hex] of Object.entries(AGENT_ACCENTS)) {
      expect(accentColor(token)).toBe(hex)
    }
  })

  it('falls back to neutral zinc for absent or unknown tokens', () => {
    // A conversation whose agent was deregistered still has to render.
    expect(accentColor(undefined)).toBe(AGENT_ACCENT_FALLBACK)
    expect(accentColor('')).toBe(AGENT_ACCENT_FALLBACK)
    expect(accentColor('chartreuse')).toBe(AGENT_ACCENT_FALLBACK)
  })

  it('does not resolve inherited Object properties as tokens', () => {
    expect(accentColor('toString')).toBe(AGENT_ACCENT_FALLBACK)
    expect(accentColor('constructor')).toBe(AGENT_ACCENT_FALLBACK)
  })
})

describe('palette contract', () => {
  it('never spends a colour reserved for run status', () => {
    const used = Object.values(AGENT_ACCENTS) as string[]
    for (const reserved of RESERVED) {
      expect(used).not.toContain(reserved)
    }
    expect(used).not.toContain(AGENT_ACCENT_FALLBACK)
  })

  it('assigns a distinct hex per family', () => {
    const used = Object.values(AGENT_ACCENTS)
    expect(new Set(used).size).toBe(used.length)
  })
})
