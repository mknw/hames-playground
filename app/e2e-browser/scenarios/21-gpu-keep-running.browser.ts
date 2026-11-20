/**
 * Scenario 21 — the admin switch: keep the self-deployed GPUs running (#1047).
 *
 * The owner's demo case: "connect the modal gpu on demand. and keep it
 * running." The browser-driven keep-warm this suite already has
 * (`PRIVATE_TIER_WARM_WHILE_OPEN`, off here) stops the moment a page is
 * hidden, closed or idle; the switch is the other thing — server-held state in
 * Postgres plus a process-side loop — so what this scenario establishes is the
 * property the demo needs: with the switch ON, the boxes are kept warm with NO
 * browser paying attention at all, and the switch itself survives a closed tab
 * and a fresh page; with it OFF, the app is exactly what it was — nothing
 * pings, and the box scales down.
 *
 * ## What is asserted on, and why the wire
 *
 * The wake ping (the 1-token completion `ensureLargeAwake` sends) is the one
 * request the whole keep-warm machinery puts on the large box's wire, and the
 * fake records it with `wake: true` — so "the box is being kept warm" is a
 * COUNT of recorded pings, not a colour on a screen and not a duration. This
 * suite's scale-down window is 2s and the keep-warm floor is 5s
 * (`KEEP_WARM_MIN_INTERVAL_MS`), so the strip's word would flicker between
 * pings here for reasons that are the suite's own configuration, not the
 * product; the wire is the honest witness for the ON half. For the OFF half
 * the panel's own word is honest again: with no pings at all, the box is
 * observably cold.
 *
 * ## Why "closed tab", not "hidden tab"
 *
 * The spec's case is "stays warm past the idle cap with the tab hidden".
 * Headless Chromium cannot stage the hidden half faithfully: every page
 * reports `document.visibilityState === 'visible'` there (measured on this
 * suite's browser — a second page, `bringToFront`, none of it changes it), so
 * a "hidden" step would assert nothing while reading as though it had. The
 * closed tab is the STRONGER form of the same inattention and it IS stageable:
 * with the page closed there is provably no browser half at all, which is past
 * the idle cap, past the visibility stop and past every other way a page
 * might have kept the boxes warm itself. The suite also runs with
 * `PRIVATE_TIER_WARM_WHILE_OPEN=0`, so no open page could have contributed a
 * ping either — every wake counted below came from the server loop.
 */
import { test, expect } from '../lib/fixtures'
import type { Page } from '@playwright/test'
import type { FakeBackend } from '../lib/control'
import { open } from '../lib/chat'

/** The switch's label, as the panel renders it (owner's wording, #1047). */
const KEEP_LABEL = 'Keep the self-deployed GPUs running'

const keepSwitch = (page: Page) => page.getByRole('checkbox', { name: KEEP_LABEL })

/** Wake pings the fake has served — the 27B's keep-warm touch, `wake: true`
 *  in the fake's own classification. */
async function wakePings(backend: FakeBackend): Promise<number> {
  return (await backend.calls()).filter((call) => call.outcome === 'wake').length
}

/** Wall-clock sleep in the runner — the page under test may be closed. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Long enough for the process-side loop to touch the large box several
 *  times: the suite arms it with a 1s tick, and the wake's own freshness
 *  floor is 5s, so ~12s is several keep-warm windows of it. */
const UNATTENDED_MS = 12_000

test('on keeps the GPUs warm with no browser at all; off scales down again', async ({
  page,
  appUrl,
  backend,
}) => {
  const context = page.context()
  await open(page, appUrl)
  await page.goto(`${appUrl}/admin`)

  // ---- The panel is the admin's, and today's state is off -------------------
  await expect(keepSwitch(page)).toBeVisible()
  await expect(keepSwitch(page)).not.toBeChecked()

  // ---- ON wakes the boxes NOW, through the one shared wake -----------------
  const before = await wakePings(backend)
  // `press('Space')`, not `click()`: the checkbox is the switch's visually
  // hidden input and its LABEL intercepts pointer events over it — the same
  // interaction the memory panel's switch scenarios use. It is also the honest
  // one for a control whose keyboard path is part of the contract.
  await keepSwitch(page).press('Space')
  await expect(keepSwitch(page)).toBeChecked()
  await expect
    .poll(async () => wakePings(backend), { message: 'switching on did not wake the 27B' })
    .toBeGreaterThan(before)

  // The panel says what it is doing: running since, at a price per hour.
  await expect(page.getByTestId('gpu-keep-since')).toContainText('Kept running since')
  await expect(page.getByTestId('gpu-keep-since')).toContainText('/hour')

  // ---- The tab is closed: no browser half exists, and the state survives ---
  // (The "hidden tab" variant cannot be staged in this browser — see the
  //  module header. Closing is its stronger form.)
  await page.close()
  const closedStart = await wakePings(backend)
  await sleep(UNATTENDED_MS)
  expect(
    await wakePings(backend),
    'the boxes were not kept warm with no page open at all',
  ).toBeGreaterThanOrEqual(closedStart + 2)

  // A FRESH page reads the switch ON from the server: it is not browser state.
  const again = await context.newPage()
  await again.goto(`${appUrl}/admin`)
  await expect(keepSwitch(again)).toBeChecked()

  // ---- OFF is today's behaviour again: no pings, the box scales down -------
  await keepSwitch(again).press('Space')
  await expect(keepSwitch(again)).not.toBeChecked()

  const afterOff = await wakePings(backend)
  await sleep(UNATTENDED_MS)
  expect(await wakePings(backend), 'the loop kept pinging after the switch went off').toBe(afterOff)

  // And the panel observes what the boxes are: cold, the word the header uses.
  await again.reload()
  await expect(again.getByTestId('gpu-warmth')).toContainText('cold')
})
