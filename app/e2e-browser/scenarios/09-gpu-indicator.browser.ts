/**
 * Scenario 9 — the header's GPU indicator: what it says, and starting the box
 * from it.
 *
 * The strip is the one surface in the app that reports on the DEPLOYMENT rather
 * than on a conversation, and the reason it needs a browser is the reason this
 * layer exists: it shipped computing the right thing and showing the wrong one.
 * The countdown was gated on `warmthKey() === 'warm'` while `verdaWarmth()` also
 * computes one for `running`, and the strip re-read the server on a single
 * 15-second interval, so the `cold` → `warm` flip a user's own message causes
 * landed long after they had stopped looking. Both were invisible below here:
 * the unit suite renders the component against a fixture it wrote itself, and
 * `app/e2e/` has no DOM at all.
 *
 * ## What is asserted HERE, and what deliberately is not
 *
 * Everything below is a fact this test ESTABLISHES rather than a window it hopes
 * to land inside (#280): the box's requests are PARKED by the `hold` fault and
 * released by name, so "the wake is out" and "the wake has answered" are states
 * the test moves between rather than durations it waits out.
 *
 * The COUNTDOWN's own rendering — that `warm` and `running` show one and
 * `starting` / `cold` / `unknown` do not — is pinned in
 * `src/__tests__/components/ark-ui/PreviewHeaderStrip.test.tsx` and not here, on
 * purpose. This suite runs with `VERDA_SCALEDOWN_SECONDS: 2` (see
 * `lib/env.ts` for why it cannot simply be raised), so a warm window here is two
 * seconds wide and any assertion about a number inside it would be a race
 * against the suite's own configuration — exactly the shape of the two flakes
 * #280 removed. What this layer owns is the part jsdom cannot see: that the
 * indicator is a real, hoverable, keyboard-reachable control, that pressing it
 * puts a request on the wire, and that the wire request is the SHARED wake.
 */
import { test, expect } from '../lib/fixtures'
import { COLD_START_HEADLINE, IGNITE_LABEL, VERDA_MODEL } from '../lib/env'
import { expectHeld } from '../lib/control'
import { chooseTier, letTheBoxGoCold, open } from '../lib/chat'

/** The indicator, whichever element it currently is — a `<div>` that reports, or
 *  the `<button>` a cold box turns it into. */
const indicator = (page: import('@playwright/test').Page) =>
  page.locator('[data-testid="verda-warmth"]')

test('a cold box offers to start, and pressing it sends the shared wake', async ({
  page,
  appUrl,
  backend,
}) => {
  await open(page, appUrl)
  // The private position is the deployment default here, but a scenario about
  // the private box must not depend on a default it did not set.
  await chooseTier(page, 'verda')

  // Park every request to the 27B, so the wake this test presses for is a state
  // it controls rather than one it races.
  await backend.arm({ kind: 'hold', model: VERDA_MODEL })
  await letTheBoxGoCold(page)

  // ---- It reports the state, and only the state, at rest -------------------
  await expect(indicator(page)).toContainText('cold')
  await expect(indicator(page)).not.toContainText(IGNITE_LABEL)

  // ---- Under the pointer it offers the action ------------------------------
  // The swap is the affordance: a word that only ever said "cold" gives a user
  // nothing to press, and this is the one place in the app where the box's
  // state is actionable rather than merely reported.
  await indicator(page).hover()
  await expect(indicator(page)).toContainText(IGNITE_LABEL)

  // A real control, not a clickable div — which is what makes it reachable
  // without a pointer at all. Asserted through the accessible name rather than
  // the tag, because the name is what a screen-reader user actually gets, and
  // it is the ACTION rather than the state.
  await expect(page.getByRole('button', { name: IGNITE_LABEL })).toBeVisible()

  // ---- Pressing it starts the box -----------------------------------------
  await page.getByRole('button', { name: IGNITE_LABEL }).click()

  // The request is on the wire and PARKED, so the pending state below is a fact
  // rather than a deadline. `wake: true` is the load-bearing half: it is the
  // shared `ensureVerdaAwake` ping, not a second wake path this button opened
  // for itself — which is what makes a click during a turn's own wake join it
  // instead of queueing a second cold start on a single-replica deployment.
  const parked = await expectHeld(
    backend,
    (held) => held.length === 1,
    'pressing the indicator put no request on the wire, so nothing was started',
  )
  expect(
    parked[0].wake,
    'the parked request is not the wake ping — the button opened a second wake path',
  ).toBe(true)

  // ---- And says so while it is happening ----------------------------------
  // The server still answers `cold` for the whole ping (nothing has completed
  // yet), so without a pending state of its own the control a user just pressed
  // would sit reading "cold" for the minutes a real start takes.
  await expect(indicator(page)).toContainText(COLD_START_HEADLINE)

  // ---- The box answers, and the strip stops offering to start it ----------
  // Deliberately the negative claim rather than "it now says warm": the warm
  // window is two seconds wide in this suite, so the positive one would be a
  // race (see the module docstring). That the button is GONE is true for as long
  // as the box is up and is established by the release below.
  expect(await backend.release(1)).toBe(1)
  await expect(page.getByRole('button', { name: IGNITE_LABEL })).toHaveCount(0)
})

test('pressing the indicator is reachable from the keyboard', async ({ page, appUrl, backend }) => {
  // The control is a glyph and a word in a top bar; if it were a `<div onClick>`
  // it would look identical and be unreachable without a pointer. Focus is also
  // the second trigger for the label swap, so this covers both.
  await open(page, appUrl)
  await chooseTier(page, 'verda')
  await backend.arm({ kind: 'hold', model: VERDA_MODEL })
  await letTheBoxGoCold(page)

  await expect(indicator(page)).toContainText('cold')

  const button = page.getByRole('button', { name: IGNITE_LABEL })
  await button.focus()
  await expect(indicator(page)).toContainText(IGNITE_LABEL)

  await page.keyboard.press('Enter')
  await expectHeld(
    backend,
    (held) => held.length === 1 && held[0].wake,
    'the indicator did not start the box when operated from the keyboard',
  )
  await backend.release(1)
})
