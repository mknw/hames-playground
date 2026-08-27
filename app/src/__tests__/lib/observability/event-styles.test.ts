/**
 * Presentation tables for the observability timeline.
 *
 * The tables are `Record<EventType, …>`, so a new event type is a compile
 * error rather than a blank row — these tests pin the runtime half: that the
 * pattern lookup falls back rather than returning `undefined`, and that no
 * event type is left without an icon or a colour.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
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

/**
 * The `@unocss-include` marker is the only reason the icon literals above reach
 * the stylesheet. `event-styles.ts` is a plain `.ts`, which UnoCSS's pipeline
 * does not scan, so the marker in its doc comment is what opts the file in.
 *
 * WHAT MAKES IT WORTH A TEST is that nothing else notices it go. Verified by
 * mutation in the #294 review: with the marker stripped, `pnpm build` still
 * exits 0 and `event-styles.test.ts` + `ObservabilityPanel.test.tsx` stay green
 * (90/90), while SEVEN event glyphs — `controller_action`, `intent_compacted`,
 * `error`, `approval_response`, `tool_result`, `reference_attached`,
 * `plan_created` — stop emitting CSS and render as empty spans with no error.
 * (The other glyphs survive only because the same literals also appear in
 * `.tsx` files, which UnoCSS does scan.)
 *
 * This is a source scan: it pins the string shape and cannot see CSS. That is
 * the half that is cheap to lose — the same idiom as `uno-fonts.test.ts` and
 * `client-output-caps.test.ts`.
 */
describe('event-styles.ts opts itself into UnoCSS extraction', () => {
  it('keeps the @unocss-include marker', () => {
    // vitest runs from app/ (every pnpm command does — CLAUDE.md). This file
    // runs under jsdom, where `import.meta.url` is not a file: URL, so the
    // cwd-relative form is the one that works here.
    const source = readFileSync(
      path.resolve(process.cwd(), 'src/lib/observability/event-styles.ts'),
      'utf-8',
    )
    // Guard against a vacuous pin: if the icon literals ever leave this file the
    // marker stops mattering, and this test has to be re-aimed rather than pass
    // on a file with nothing left to extract.
    expect(source, 'the icon literals have left event-styles.ts — re-aim this pin').toMatch(
      /i-material-symbols/,
    )
    expect(
      source,
      'event-styles.ts is a plain .ts: without @unocss-include UnoCSS never scans it and its icon classes emit no CSS',
    ).toContain('@unocss-include')
  })
})
