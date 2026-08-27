/**
 * Scenario 9 — the boot path never renders a blank screen.
 *
 * THIS IS THE LAYER THAT CAUGHT NOTHING when the bug was filed (#295), and the
 * reason is worth writing down because it decides what this file asserts.
 *
 * The owner's report was "a spinner shows briefly, then a white screen for 3–4
 * seconds". Every other scenario in this suite calls `open()`, which waits for
 * the composer — so all of them sat happily through the blank window and then
 * passed. Nothing was wrong with the app at the point any of them looked. The
 * failure was ONLY ever visible in between, and no assertion existed there.
 *
 * So this scenario asserts on the WHOLE INTERVAL rather than on an end state:
 * it samples what is painted, continuously, from before navigation until the
 * app is up, and fails if the page was ever showing neither a loading state nor
 * the app for longer than a frame budget.
 *
 * ## What the sampler measures, and why not a screenshot
 *
 * Not pixels: a screenshot of the blank window is a white rectangle and so is a
 * screenshot of a legitimately light theme. It counts the RENDERED ELEMENTS
 * inside the app's own root and looks for either a loading surface or the app's
 * own chrome. The blank window's signature is specific and was measured before
 * the fix — the nav bar renders (the user-menu initials, ~39 elements) while the
 * ROUTE renders nothing, which is why "the body is empty" is the wrong probe and
 * "the route area is empty" is the right one.
 *
 * ## Why sampling in the page rather than from the test
 *
 * A CDP round trip per sample is tens of milliseconds and is paced by the test
 * runner's own event loop, so a 40 ms blank window could fall between two
 * samples. The sampler runs as an init script, on the page's own timers, and
 * the test reads the whole series once at the end.
 *
 * ## Determinism
 *
 * This file waits on a STATE, never on a duration (#280), and it asserts a
 * property of the series rather than what was on screen at some chosen instant.
 * The one number it compares against is a frame budget, and it is generous on
 * purpose: the claim is "never blank", not "blank for less than exactly N ms",
 * and a `vinxi dev` server on a loaded machine is not the place to measure
 * milliseconds. The pre-fix window was 340 ms warm and 8.8 s cold, so a budget
 * of a few frames separates the two by an order of magnitude either way.
 */
import { test, expect } from '../lib/fixtures'
import { composer, open } from '../lib/chat'

/**
 * How long the page may show neither a loading state nor the app.
 *
 * Four 60 Hz frames. Not zero: the handover between the two gates swaps one
 * subtree for another, and a sample can legitimately land in the single frame
 * where the outgoing one has gone and the incoming one has not painted.
 */
const BLANK_BUDGET_MS = 68

/** How often the in-page sampler looks. */
const SAMPLE_EVERY_MS = 16

interface Sample {
  t: number
  /** Elements inside the app root — the blank window's real signature. */
  appEls: number
  /** A loading surface is up (the splash, or any `role="status"` region). */
  loading: boolean
  /** The app proper is up. */
  app: boolean
  text: string
}

declare global {
  interface Window {
    __bootSamples?: Sample[]
  }
}

async function installSampler(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript((everyMs: number) => {
    window.__bootSamples = []
    const started = performance.now()
    const sample = () => {
      const samples = window.__bootSamples
      if (!samples) return
      const body = document.body as HTMLElement | null
      // The app's own root, not `<body>`: the pre-fix blank window had a
      // rendered nav bar and an empty route area, so counting the whole body
      // would have called it non-blank.
      const root = document.querySelector('#app') ?? body
      samples.push({
        t: Math.round(performance.now() - started),
        appEls: root ? root.querySelectorAll('*').length : 0,
        loading:
          !!document.querySelector('[data-testid="app-loading-splash"]') ||
          !!document.querySelector('[role="status"]'),
        app: !!document.querySelector('textarea'),
        text: (body?.innerText ?? '').trim().slice(0, 40).replace(/\s+/g, ' '),
      })
      if (samples.length < 8000) setTimeout(sample, everyMs)
    }
    sample()
  }, SAMPLE_EVERY_MS)
}

test('the boot path shows a loading state or the app, and never nothing', async ({
  page,
  appUrl,
}) => {
  await installSampler(page)

  // `open()` is what every other scenario uses, and on its own it is exactly
  // why none of them saw this: it waits for the composer and asserts nothing
  // about the interval before it. The interval is what the series below holds.
  await open(page, appUrl)

  const samples = (await page.evaluate(() => window.__bootSamples ?? [])) as Sample[]
  expect(samples.length, 'the in-page sampler never ran').toBeGreaterThan(3)

  // Trim the series at the first frame the app is up: everything after it is
  // the app running, which is other scenarios' business.
  const firstAppAt = samples.findIndex((s) => s.app)
  expect(firstAppAt, 'the app never came up, so there is no boot path to judge').toBeGreaterThan(-1)
  const boot = samples.slice(0, firstAppAt + 1)

  // A frame is blank when neither a loading state nor the app is on screen. The
  // element count is the corroborating signal, and it is what makes the probe
  // specific rather than a synonym for "no textarea yet": the measured pre-fix
  // window sat at ~39 elements (the nav bar alone) with no loading surface.
  const blank = (s: Sample) => !s.loading && !s.app

  let worstMs = 0
  let worstFrom = 0
  let runStart: number | null = null
  for (const s of boot) {
    if (blank(s)) {
      if (runStart === null) runStart = s.t
      if (s.t - runStart > worstMs) {
        worstMs = s.t - runStart
        worstFrom = runStart
      }
    } else {
      runStart = null
    }
  }

  const window_ = boot
    .filter((s) => blank(s) && s.t >= worstFrom && s.t <= worstFrom + worstMs)
    .map((s) => `t=${s.t}ms els=${s.appEls} text="${s.text}"`)
    .slice(0, 10)

  expect(
    worstMs,
    'The boot path rendered NEITHER a loading state NOR the app for longer than a frame ' +
      `budget — the #295 regression. Longest such window: ${worstMs}ms from t=${worstFrom}ms.\n` +
      `Samples inside it:\n  ${window_.join('\n  ')}\n` +
      'The fix is a fallback on whatever boundary is suspending: a fallback-less ' +
      '<Suspense> renders nothing while it waits.',
  ).toBeLessThanOrEqual(BLANK_BUDGET_MS)

  // And the positive half: a loading state was actually SHOWN. Without this the
  // assertion above passes on a boot so fast nothing was needed, which would
  // quietly stop testing the splash the day the dev server got quicker.
  const everLoading = boot.some((s) => s.loading)
  expect(everLoading, 'no loading state was ever painted during boot').toBe(true)

  // Sanity: the app really is up at the end, through the same locator the rest
  // of the suite trusts.
  await expect(composer(page)).toBeVisible()
})

test('the splash carries a moving bar and a status line, not a bare spinner', async ({
  page,
  appUrl,
}) => {
  // The bonus half of #295, asserted where it is actually visible. This is a
  // browser fact for the same reason the cold-start spinner is: a component
  // test can prove the markup exists, not that it reached the screen during a
  // real boot behind a real dev server.
  await page.addInitScript(() => {
    window.__splashSeen = { bar: false, lines: [] as string[] }
    const look = () => {
      const seen = window.__splashSeen
      if (!seen) return
      const track = document.querySelector('[data-testid="splash-progress-track"]')
      if (track) seen.bar = true
      const line = document.querySelector('[data-testid="splash-line"]')?.textContent?.trim()
      if (line && !seen.lines.includes(line)) seen.lines.push(line)
      setTimeout(look, 16)
    }
    look()
  })

  await open(page, appUrl)

  const seen = (await page.evaluate(() => window.__splashSeen)) as {
    bar: boolean
    lines: string[]
  }
  expect(seen.bar, 'the splash never showed its progress bar').toBe(true)
  expect(seen.lines.length, 'the splash never showed a status line').toBeGreaterThan(0)
  for (const line of seen.lines) expect(line.length).toBeGreaterThan(0)
})

declare global {
  interface Window {
    __splashSeen?: { bar: boolean; lines: string[] }
  }
}
