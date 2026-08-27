/**
 * Presentation tables for the observability timeline.
 *
 * The tables are `Record<EventType, …>`, so a new event type is a compile
 * error rather than a blank row — these tests pin the runtime half: that the
 * pattern lookup falls back rather than returning `undefined`, and that no
 * event type is left without an icon or a colour.
 */
import { describe, it, expect } from 'vitest'
import type { EventType } from '~/lib/harness-patterns'
import { eventColors, eventIconClasses, getPatternColor } from '~/lib/observability/event-styles'

describe('getPatternColor', () => {
  it('resolves a known pattern to a colour and a tint', () => {
    const pc = getPatternColor('neo4j-query')
    expect(pc.color).toMatch(/^#|^rgb/)
    expect(pc.tint).toMatch(/^#|^rgba?\(/)
  })

  it('falls back for an unknown pattern instead of returning undefined', () => {
    const pc = getPatternColor('a-pattern-that-does-not-exist')
    expect(pc).toEqual(getPatternColor('_default'))
    expect(pc.color).toBeTruthy()
    expect(pc.tint).toBeTruthy()
  })
})

describe('eventIconClasses / eventColors', () => {
  it('gives every event type both an icon and a colour', () => {
    const types = Object.keys(eventIconClasses) as EventType[]
    expect(types.length).toBeGreaterThan(0)
    for (const type of types) {
      expect(eventIconClasses[type]).toBeTruthy()
      expect(eventColors[type]).toMatch(/^#[0-9a-f]{6}$/i)
    }
    expect(Object.keys(eventColors).sort()).toEqual(types.sort())
  })

  // The table held emoji until the alpha-preview sweep. `material-symbols` and
  // `material-symbols-light` are the only collections registered in
  // `uno.config.ts`, so a glyph from anywhere else — an emoji, or an `i-mdi-*`
  // — emits no CSS and renders as an empty span with no error.
  it('names a registered icon collection for every event type, and no emoji', () => {
    for (const [type, cls] of Object.entries(eventIconClasses)) {
      expect(cls, type).toMatch(/^i-material-symbols(-light)?-[a-z0-9-]+$/)
      expect(cls, type).not.toMatch(/\p{Extended_Pictographic}/u)
    }
  })

  it('keeps content_sanitized visually distinct from error', () => {
    expect(eventColors.content_sanitized).not.toBe(eventColors.error)
  })
})
