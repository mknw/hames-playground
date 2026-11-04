/**
 * Scenario 20 — the header fits a phone-width viewport (#936).
 *
 * The preview status strip is a row of fixed-minimum-width metrics, about 500px
 * of them, and at 390px it pushed `scrollWidth` past the viewport on EVERY page:
 * the whole app scrolled sideways on a phone. Nothing below this layer can see
 * that — jsdom does no layout, so a component test of the strip measures zero
 * widths and passes whatever the CSS says.
 *
 * What is asserted is what a person at 390px meets: the page does not scroll
 * sideways, the warm indicator is on screen, and the metrics are still
 * reachable (they scroll inside their own block rather than off the page).
 * Every wait is on a state, never a duration (#280).
 */
import { test, expect } from '../lib/fixtures'
import { open } from '../lib/chat'

test.use({ viewport: { width: 390, height: 844 } })

test('at 390px the header does not push the page into a horizontal scroll', async ({
  page,
  appUrl,
}) => {
  await open(page, appUrl)
  // The strip renders nothing until its first poll lands; measuring before
  // that would pass against an empty header.
  const metrics = page.getByTestId('preview-header-metrics')
  await expect(metrics).toBeVisible()

  const widths = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth,
    viewport: window.innerWidth,
    nav: (document.querySelector('[data-testid="app-header-strip"]') as HTMLElement).scrollWidth,
  }))
  expect(widths.nav, 'the header is wider than the viewport').toBeLessThanOrEqual(widths.viewport)
  expect(widths.page, 'the page scrolls sideways').toBeLessThanOrEqual(widths.viewport)

  // The indicator is the strip's one actionable part, so it is the part that
  // must stay in view while the metrics give way.
  const indicator = await page.getByTestId('large-warmth').boundingBox()
  expect(indicator).not.toBeNull()
  expect(indicator!.x).toBeGreaterThanOrEqual(0)
  expect(indicator!.x + indicator!.width).toBeLessThanOrEqual(widths.viewport)

  // Given way, not thrown away: the metrics scroll within their own block, and
  // that block can take keyboard focus so the scroll is not pointer-only.
  await expect(metrics).toHaveAttribute('tabindex', '0')
  await expect(metrics.getByText('active')).toBeAttached()
})
