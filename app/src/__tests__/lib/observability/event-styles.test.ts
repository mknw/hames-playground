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
import { eventColors, eventIcons, getPatternColor } from '~/lib/observability/event-styles'

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

describe('eventIcons / eventColors', () => {
  it('gives every event type both an icon and a colour', () => {
    const types = Object.keys(eventIcons) as EventType[]
    expect(types.length).toBeGreaterThan(0)
    for (const type of types) {
      expect(eventIcons[type]).toBeTruthy()
      expect(eventColors[type]).toMatch(/^#[0-9a-f]{6}$/i)
    }
    expect(Object.keys(eventColors).sort()).toEqual(types.sort())
  })

  it('keeps content_sanitized visually distinct from error', () => {
    expect(eventColors.content_sanitized).not.toBe(eventColors.error)
  })
})
