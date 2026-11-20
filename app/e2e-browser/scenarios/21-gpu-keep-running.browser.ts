/**
 * Scenario 21 — the admin switch: keep the self-deployed GPUs running (#1047,
 * and since #1057 through Modal's control API).
 *
 * The owner's demo case: "connect the modal gpu on demand. and keep it
 * running." The browser-driven keep-warm this suite already has
 * (`PRIVATE_TIER_WARM_WHILE_OPEN`, off here) stops the moment a page is
 * hidden, closed or idle; the switch is the other thing — server-held state in
 * Postgres plus a process-side loop — so what this scenario establishes is
 * the property the demo needs: with the switch ON, the boxes are held up with
 * NO browser paying attention at all, and the switch itself survives a
 * closed tab and a fresh page; with it OFF, the app is exactly what it was.
 *
 * ## What holds the boxes up, and what the wire witnesses
 *
 * Since #1057 the switch drives Modal's AUTOSCALER (`min_containers=1`, per
 * box, asserted every loop tick so a redeploy cannot silently reset it) —
 * that is what "keep it running" means now, and what this scenario counts on
 * the fake's Modal-control records to witness. The wake pings the old switch
 * sent are the FALLBACK, armed only while the control route is unavailable —
 * and this suite configures it (global setup points `MODAL_CONTROL_BASE` at
 * the fake), so the acceptance pinned here is the one #1057 asks for verbatim:
 * **the switch boots both boxes with no request sent to either box.** The
 * model endpoint's recorded calls are the negative witness — flat across the
 * whole ON half, pings and all.
 *
 * ## Why "closed tab", not "hidden tab"
 *
 * The spec's case is "stays warm past the idle cap with the tab hidden".
 * Headless Chromium cannot stage the hidden half faithfully: every page
 * reports `document.visibilityState === 'visible'` there (measured on this
 * suite's browser — a second page, `bringToFront`, none of it changes it), so
 * a "hidden" step would assert nothing while reading as though it had. The
 * closed tab is the STRONGER form of the same inattention and it IS stageable:
 * with the page closed there is provably no browser half at all, which is
 * past the idle cap, past the visibility stop and past every other way a page
 * might have kept the boxes warm itself. The suite also runs with
 * `PRIVATE_TIER_WARM_WHILE_OPEN=0`, so no open page could have contributed
 * anything either.
 */
import { test, expect } from '../lib/fixtures'
import type { Page } from '@playwright/test'
import type { FakeBackend } from '../lib/control'
import { open } from '../lib/chat'

/** The switch's label, as the panel renders it (owner's wording, #1047). */
const KEEP_LABEL = 'Keep the self-deployed GPUs running'

const keepSwitch = (page: Page) => page.getByRole('checkbox', { name: KEEP_LABEL })

/** Wake pings the fake has served — the 27B's keep-warm touch, `wake: true`
 *  in the fake's own classification. The switch's FALLBACK mechanism; the
 *  whole point of #1057 is that this suite's switch never needs one. */
async function wakePings(backend: FakeBackend): Promise<number> {
  return (await backend.calls()).filter((call) => call.outcome === 'wake').length
}

/** The autoscaler assertions the fake recorded: which box, which min_containers. */
async function autoscalerAssertions(backend: FakeBackend) {
  return (await backend.modalCalls())
    .filter((call) => call.route === 'autoscaler')
    .map(({ box, minContainers }) => ({ box, minContainers }))
}

/** Wall-clock sleep in the runner — the page under test may be closed. */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Long enough for the process-side loop to assert the autoscaler several
 *  times: the suite arms it with a 1s tick. */
const UNATTENDED_MS = 12_000

test('on holds the GPUs up through Modal’s autoscaler with no browser at all; off releases them again', async ({
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

  // ---- ON asserts min_containers=1 per box, THROUGH THE AUTOSCALER ---------
  const modelCallsBefore = await backend.calls()
  const pingsBefore = await wakePings(backend)
  // `press('Space')`, not `click()`: the checkbox is the switch's visually
  // hidden input and its LABEL intercepts pointer events over it — the same
  // interaction the memory panel's switch scenarios use. It is also the honest
  // one for a control whose keyboard path is part of the contract.
  await keepSwitch(page).press('Space')
  await expect(keepSwitch(page)).toBeChecked()
  await expect
    .poll(async () => autoscalerAssertions(backend), {
      message: 'switching on did not assert min_containers=1',
    })
    .toContainEqual({ box: 'large', minContainers: 1 })

  // THE acceptance: booted with no request sent — the model endpoint's
  // records are FLAT across the flip, not one ping on either box.
  expect(await backend.calls()).toEqual(modelCallsBefore)
  expect(await wakePings(backend)).toBe(pingsBefore)

  // The panel says what it is doing: running since, at a price per hour.
  await expect(page.getByTestId('gpu-keep-since')).toContainText('Kept running since')
  await expect(page.getByTestId('gpu-keep-since')).toContainText('/hour')

  // ---- The tab is closed: no browser half exists, and the state survives ---
  // (The "hidden tab" variant cannot be staged in this browser — see the
  // module header. Closing is its stronger form.)
  await page.close()
  const closedModelCalls = await backend.calls()
  const closedAssertions = await autoscalerAssertions(backend)
  await sleep(UNATTENDED_MS)
  // The loop kept asserting min_containers=1 with no page open at all.
  expect(await autoscalerAssertions(backend)).not.toEqual(closedAssertions)
  expect(await backend.calls(), 'the loop sent a model request while no page was open').toEqual(
    closedModelCalls,
  )

  // A FRESH page reads the switch ON from the server: it is not browser state.
  const again = await context.newPage()
  await again.goto(`${appUrl}/admin`)
  await expect(keepSwitch(again)).toBeChecked()

  // ---- OFF releases the autoscaler: min_containers=0, and still no request -
  await keepSwitch(again).press('Space')
  await expect(keepSwitch(again)).not.toBeChecked()
  await expect
    .poll(
      async () => (await autoscalerAssertions(backend)).filter((call) => call.minContainers === 0),
      {
        message: 'switching off did not release the autoscaler',
      },
    )
    .toContainEqual({ box: 'large', minContainers: 0 })

  const modelCallsAfterOff = await backend.calls()
  await sleep(UNATTENDED_MS)
  expect(await backend.calls(), 'the loop sent a model request after the switch went off').toEqual(
    modelCallsAfterOff,
  )

  // And the panel observes what the boxes are: cold, the word the header uses.
  await again.reload()
  await expect(again.getByTestId('gpu-warmth')).toContainText('cold')
})
