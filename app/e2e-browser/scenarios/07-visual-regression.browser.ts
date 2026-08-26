/**
 * Scenario 7 — per-theme screenshot comparison over three surfaces.
 *
 * ## The class of bug this exists for
 *
 * Everything else in this repo asserts on something NAMED: a role, a label, a
 * `data-testid`, a recorded call. That is deliberate and it is also the reason a
 * whole family of regressions has been reaching the owner unseen — the ones where
 * every name is still there and the pixels are wrong:
 *
 *  - a glyph on a class `presetIcons` does not register (`i-mdi-*`, #226 B6):
 *    the span keeps its box, paints nothing, and every assertion about roles,
 *    text and geometry still passes. `theme-migration.test.ts` catches those by
 *    SCANNING SOURCE, which only works for the mistake it knows the shape of;
 *  - a colour that reads in dark and disappears in light. Every interface colour
 *    is a `ui-*` variable redefined per theme (#226 B8), so this needs no markup
 *    change at all — and `06-theme-sanity` only checks three elements, one at a
 *    time, against their own composited grounds;
 *  - a layout that collapses: a flex child that stops shrinking, a row that wraps,
 *    a panel that overlaps the composer. Nothing anywhere asks.
 *
 * A screenshot is the only instrument that sees all three, and it is the one this
 * pyramid did not have. Six images — three surfaces × two themes — is small enough
 * that a human actually opens the diff, which is the property that makes it work.
 *
 * ## What a red run means, and what it does not
 *
 * It means SOMETHING MOVED. It does not mean something broke: a deliberate design
 * change reddens this too, and the right response is then to look at the diff
 * image and re-record the baseline. That is the whole contract, and it is why the
 * failure message says so rather than pretending a diff is a defect.
 *
 * `pnpm test:e2e:browser --update-snapshots` re-records. Do it in a commit of its
 * own, with the diff looked at first: a baseline updated in the same commit as the
 * change that moved it is a baseline nobody reviewed.
 *
 * ## Why the baselines are platform-suffixed, and committed
 *
 * Font rasterisation and subpixel antialiasing differ between macOS and Linux, so
 * one image cannot serve both. `playwright.config.ts`'s `snapshotPathTemplate`
 * puts `{platform}` in the filename, so each platform grows its own set the first
 * time it runs there and the two never fight. The consequence is stated plainly:
 * this suite never runs in CI (see `README.md`), so a committed baseline is only
 * ever compared on a machine of the same platform, and a contributor on a
 * different one records their own.
 *
 * ## Two things mutation testing corrected here, and they are the interesting part
 *
 * The first draft allowed 0.2% of the region to differ and masked the volatile
 * regions. Both were wrong, and both were found the way this repo asks — by
 * mutating the source and watching the test stay green.
 *
 * **1. The threshold was blind to the bug the scenario is named after.** Moving
 * the Send button's glyph to the unregistered `i-mdi-*` collection changed **20
 * pixels** — a 14-pixel outline icon is mostly thin strokes — which is 0.006% of
 * the chat view. The 0.2% ratio swallowed it whole. The regressions this catches
 * are small and ABSOLUTE, so the budget has to be too: see {@link
 * MAX_DIFF_PIXELS}.
 *
 * **2. Masking hides content but not the layout shift it causes.** Playwright's
 * `mask` paints a box over an element and leaves it in the flow. The header's warm
 * indicator is a state word whose WIDTH varies — "cold" against "warm 4:58" — so
 * it kept moving the metric row beside it, and produced a **1152-pixel** diff in a
 * run where nothing had changed. The volatile elements are now `display: none`
 * before the shot (`surfaces.ts#hideVolatile`), which closes that channel. Nothing
 * is lost: a masked region asserted nothing about itself either.
 *
 * The general lesson, and the reason it is written here rather than in a commit
 * message: **a tolerance wide enough to absorb an unstable region is wide enough
 * to absorb a real regression of the same size.** Remove the instability instead.
 */
import { test, expect } from '../lib/fixtures'
import { hideVolatile, SURFACES, THEMES } from '../lib/surfaces'

/**
 * How many pixels may differ before the run is red.
 *
 * **Zero**, and both numbers behind that are measured rather than guessed:
 *
 *  - run-to-run noise, with the volatile elements removed from the page, is **0**
 *    pixels across all six surfaces. Headless Chromium on one machine is
 *    deterministic; the antialiasing slack an earlier draft allowed for was a
 *    hypothesis, not an observation.
 *  - the smallest regression worth catching is **20** pixels — measured, by
 *    moving the Send button's glyph to the unregistered `i-mdi-*` collection
 *    (#226 B6's exact bug) and reading the diff. A 14-pixel outline icon is
 *    mostly thin strokes, so it is far smaller than it looks.
 *
 * Twenty is the ceiling any budget has to sit under, which leaves no room for a
 * generous one. So there is none. A font or Chromium update will exceed zero, and
 * that is the correct outcome: something did move, and the contract above is to
 * open the diff and re-record deliberately.
 */
const MAX_DIFF_PIXELS = 0

for (const theme of THEMES) {
  for (const surface of SURFACES) {
    test(`${surface.name} looks unchanged in ${theme}`, async ({ page, appUrl }) => {
      const region = await surface.reach(page, appUrl, theme)
      // Live counters and a ticking countdown, taken OUT of the page rather than
      // masked — see `surfaces.ts#hideVolatile` for the 1152-pixel diff that
      // distinction cost.
      await hideVolatile(page)

      await expect(region, {
        message:
          `${surface.name} in ${theme} no longer matches its committed baseline. Open the ` +
          'diff image the runner just saved under e2e-browser/.runtime/results/ before ' +
          'doing anything else: a red run here means something MOVED, which is either a ' +
          'regression or a design change you meant. If you meant it, re-record with ' +
          '`pnpm test:e2e:browser --update-snapshots` in a commit of its own.',
      }).toHaveScreenshot(`${surface.name}-${theme}.png`, {
        maxDiffPixels: MAX_DIFF_PIXELS,
        // A CSS transition caught halfway is a difference that says nothing about
        // the app. Playwright finishes them and then shoots.
        animations: 'disabled',
        // The composer is focused after a turn, and a blinking caret is a
        // one-in-two coin flip on every run.
        caret: 'hide',
      })
    })
  }
}
