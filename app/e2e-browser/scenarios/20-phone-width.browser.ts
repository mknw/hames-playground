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
 * reachable — the last one can be scrolled into view from the keyboard, inside
 * the metrics' own block rather than by scrolling the page.
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

  // Given way, not thrown away: the metrics scroll within their own block. A
  // block that merely CLIPS them (`overflow: hidden`) passes everything above,
  // so this half proves a person can reach the last metric — from the keyboard,
  // which is the path the block's tab stop promises. Not by setting
  // `scrollLeft`: a script can scroll an `overflow: hidden` box too, so that
  // would not tell clipped from scrollable.
  const overflow = await metrics.evaluate((el) => ({
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
  }))
  expect(overflow.scrollWidth, 'the metrics fit, so nothing here is tested').toBeGreaterThan(
    overflow.clientWidth,
  )
  const last = metrics.locator(':scope > div').last()
  const offscreen = await last.boundingBox()
  expect(offscreen!.x + offscreen!.width).toBeGreaterThan(widths.viewport)

  await metrics.focus()
  await expect(metrics).toBeFocused()
  // A keyboard scroll moves a fixed step per press; press until the block
  // reports it is at its end, bounded so a block that never moves fails here
  // rather than spinning.
  for (let i = 0; i < 40; i++) {
    const atEnd = await metrics.evaluate((el) => el.scrollLeft + el.clientWidth >= el.scrollWidth)
    if (atEnd) break
    await page.keyboard.press('ArrowRight')
  }
  await expect
    .poll(async () => {
      const box = await last.boundingBox()
      return box !== null && box.x + box.width <= widths.viewport
    }, 'the last metric cannot be scrolled into view')
    .toBe(true)
})
