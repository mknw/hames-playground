/**
 * Scenario 6 — the header strip and the sidebar are visible in BOTH themes.
 *
 * Three elements, in each theme. Not a design review and not a contrast audit
 * (`A11Y-CHECKLIST.md` owns that, properly, per element): this is the crude
 * question nothing else asks — did anything become invisible, and did any icon
 * stop rendering. Both are one-line regressions and neither has a symptom a
 * unit test can see:
 *
 *   - every interface colour is a `ui-*` variable redefined per theme
 *     (#226 B8), so a component can read perfectly in dark and vanish in light
 *     without its markup changing at all;
 *   - `presetIcons` registers two collections, and a class outside them
 *     (`i-mdi-*`, removed in #226 B6) emits NO CSS — the span keeps its box,
 *     paints nothing, and every assertion about roles, text and geometry still
 *     passes. `theme-migration.test.ts` catches those by scanning source; this
 *     is the half that catches a glyph that renders empty for any other reason.
 *
 * The theme is seeded into `localStorage` before the first script runs, because
 * that is the shipped path: `entry-server.tsx` inlines a boot script that reads
 * it and stamps the class before first paint. Clicking the switcher afterwards
 * would measure a repaint instead.
 */
import { test, expect } from '../lib/fixtures'
import { open, sendButton, tierOption } from '../lib/chat'
import { expectGlyphRenders, expectReadable } from '../lib/visible'

const PRIVATE = 'Private (Verda)'

for (const theme of ['dark', 'light'] as const) {
  test(`the header strip and sidebar render visibly in ${theme}`, async ({ page, appUrl }) => {
    await open(page, appUrl, { theme })

    // The theme is the one that was asked for — otherwise the three checks
    // below would both run against whatever the default is and agree.
    await expect(page.locator('html')).toHaveClass(new RegExp(`\\b${theme}\\b`))

    // ---- 1. The header strip's tier switch ---------------------------------
    // The strip is the first thing on the bar and the control a preview user
    // is meant to act on. Its label carries the only text there.
    const tier = tierOption(page, PRIVATE)
    await expect(tier).toBeVisible()
    await expectReadable(tier, `the "${PRIVATE}" tier label in ${theme}`)

    // ---- 2. An icon, on the class the icon migration is about ---------------
    // The theme switcher's own glyph: it lives on the bar, it is icon-ONLY (so
    // an empty span leaves a control with no visible affordance at all), and
    // it is a `material-symbols` class — the collection that is supposed to be
    // registered.
    const themeGlyph = page.locator('button[aria-label^="Theme:"] span').first()
    await expect(themeGlyph).toBeVisible()
    await expectGlyphRenders(themeGlyph, `the theme switcher glyph in ${theme}`)

    // ---- 3. The composer's send button -------------------------------------
    // The sidebar/chat column's primary action, and the one control every
    // scenario in this suite depends on being clickable.
    await expect(sendButton(page)).toBeVisible()
    await expectReadable(sendButton(page), `the Send button label in ${theme}`)
    await expectGlyphRenders(
      sendButton(page).locator('span').first(),
      `the Send button glyph in ${theme}`,
    )
  })
}
