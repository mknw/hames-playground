/**
 * Scenario 25 — a reload does not lose a wake or a running turn (#1045).
 *
 * The owner's words: "Then the 'starting GPU' spinning wheel should be shown
 * after Ctrl+R refresh event. We're not just 'not giving anything'." The
 * observed case was a turn twenty minutes into a wake that was retrying with
 * no replica; the owner reloaded, and the page showed no spinner, no starting
 * state and no running turn — the first sign of anything was the final error.
 *
 * Everything this file asserts is SERVER state re-derived by a fresh page, so
 * every claim here is exactly the thing a reload used to erase:
 *
 *   - the header's `starting` word AND its spinning wheel, while a server-side
 *     wake is in flight — whether the turn or the start button put it there —
 *     until it succeeds or fails;
 *   - a conversation whose turn is still running shows the wait (the
 *     waiting-for-the-GPU phase when that is what the turn is doing), reads as
 *     running, and shows the outcome when it ends.
 *
 * ## Determinism
 *
 * The #280 rules, unchanged: the 27B's requests are PARKED by the `hold` fault
 * and released by name, so "the wake is out" and "the turn is still running"
 * are states the test moves between rather than durations it waits out. A
 * reload is a real tab teardown (`beforeunload`, every signal rebuilt), which
 * is the whole point — the state that survives it has to live on the server.
 */
import { test, expect } from '../lib/fixtures'
import { COLD_START_HEADLINE, IGNITE_LABEL, LARGE_LLM_MODEL } from '../lib/env'
import { expectHeld } from '../lib/control'
import { conversationRows } from '../lib/db'
import {
  chooseTier,
  coldStartNotice,
  composer,
  expectFakeAnswer,
  letTheBoxGoCold,
  open,
  replyTexts,
  send,
  stopButton,
  userBubbles,
  waitForReplies,
} from '../lib/chat'

/** The indicator, whichever element it currently is — a `<div>` that reports,
 *  or the `<button>` a cold box turns it into. */
const indicator = (page: import('@playwright/test').Page) =>
  page.locator('[data-testid="large-warmth"]')

test('a reload does not lose a server-side wake: the header still shows starting and its spinner', async ({
  page,
  appUrl,
  backend,
}) => {
  await open(page, appUrl)
  await chooseTier(page, 'self_deployed')

  // Park every 27B request, so the wake this test presses for is a state it
  // controls rather than one it races. The control plane fake reports no
  // replicas, which is the scaled-down observation the `cold` below reads on.
  await backend.arm({ kind: 'hold', model: LARGE_LLM_MODEL })
  await letTheBoxGoCold(page)
  await expect(indicator(page)).toContainText('cold')

  // ---- Start the box; the wake is on the wire and parked --------------------
  await page.getByRole('button', { name: IGNITE_LABEL }).click()
  const parked = await expectHeld(
    backend,
    (held) => held.length === 1,
    'pressing the indicator put no request on the wire, so nothing was started',
  )
  expect(parked[0].wake, 'the parked request is not the wake ping').toBe(true)
  await expect(indicator(page)).toContainText(COLD_START_HEADLINE)

  // ---- The tab goes away; the wake does not ---------------------------------
  await page.reload()

  // The word the strip showed before the reload is back, from server state
  // this time: the wake is in flight on the server, and a fresh tab reads it.
  await expect(indicator(page)).toContainText(COLD_START_HEADLINE)
  // And it is the SPINNING wheel, not the hourglass a bare `starting` state
  // wears — the thing the owner asked for by name.
  await expect(indicator(page).locator('[data-testid="warmth-spinner"]')).toBeVisible()
  // A wake in flight is not a state a second start can act on, so the
  // indicator is not the start button while it runs.
  await expect(page.getByRole('button', { name: IGNITE_LABEL })).toHaveCount(0)

  // ---- The wake settles, and the word goes with it --------------------------
  // Until it succeeds or fails — the release makes it succeed, and the word
  // leaving is the claim either way: nothing may say "starting GPU" about a
  // box whose wake has ended.
  expect(await backend.release(1)).toBe(1)
  await expect(indicator(page)).not.toContainText(COLD_START_HEADLINE)
})

test('a reload mid-wake keeps the conversation visibly waiting on the GPU, then shows the outcome', async ({
  page,
  appUrl,
  backend,
}) => {
  await open(page, appUrl)
  await chooseTier(page, 'self_deployed')

  // The turn's wake is the first request on the wire and parks here, so the
  // turn is provably in its waiting-for-the-GPU phase for as long as this test
  // says so.
  await backend.arm({ kind: 'hold', model: LARGE_LLM_MODEL })
  await letTheBoxGoCold(page)

  const QUESTION = 'are you still there after the reload?'
  await send(page, QUESTION)
  await expectHeld(
    backend,
    (held) => held.length === 1 && held[0].wake,
    'the turn never reached the wake, so there is no wait to survive the reload',
  )
  await expect(coldStartNotice(page)).toBeVisible()
  await expect(stopButton(page)).toBeVisible()

  // ---- The tab goes away; the turn, its lease and the wake stay -------------
  await page.reload()

  // The URL carries the conversation (the run's first frame — the warming one —
  // is what recorded it), so the reloaded page is the same thread.
  await expect(userBubbles(page).filter({ hasText: QUESTION })).toHaveCount(1)

  // The waiting-for-the-GPU phase is back on screen, re-derived from the
  // server: the conversation's turn is live and the box's wake is in flight.
  await expect(coldStartNotice(page)).toBeVisible()
  await expect(coldStartNotice(page)).toContainText(COLD_START_HEADLINE)
  // And the turn reads as running: the composer is held, Stop is offered.
  await expect(stopButton(page)).toBeVisible()
  await expect(composer(page)).not.toBeEditable()

  // ---- The outcome, when it ends ---------------------------------------------
  // Let the wake answer and the harness run through. The reloaded tab has no
  // stream, so the answer reaching the transcript is the adoption path: the
  // page polled the server's lease and read back what the turn saved.
  await backend.disarm()
  expect(await backend.release()).toBe(1)

  await waitForReplies(page, 1)
  expectFakeAnswer((await replyTexts(page))[0])
  await expect(composer(page)).toBeEditable()
  await expect(coldStartNotice(page)).toBeHidden()
  await expect
    .poll(async () => (await conversationRows())[0]?.status, {
      timeout: 60_000,
      message: 'the conversation was left at `running` after its turn ended',
    })
    .toBe('done')
})
