/**
 * Scenario 4 — reload with a turn in flight, and lose nothing.
 *
 * "Reload destroys state" is on the owner's list by name, and it is a claim no
 * layer below this one can even express: `app/e2e/` never has a browser to
 * reload, and a component test's reload is a remount with the store still in
 * memory. Here the tab genuinely goes away — `beforeunload` fires, every open
 * SSE stream is aborted, and every signal in the app is rebuilt from nothing
 * but Postgres.
 *
 * What is asserted, in the order a user would meet it:
 *
 *   1. the conversation is still in the list after the reload;
 *   2. opening it shows the completed turn, rebuilt from persistence;
 *   3. the turn that was in flight when the tab died still lands server-side
 *      and is there when the thread is opened again — a torn-down reader is
 *      not a cancelled run.
 *
 * (3) is the one worth the wall clock. A reload that quietly killed the run
 * would leave a row stuck at `running` forever, which is the same visible
 * symptom as a hung chat and a completely different bug.
 *
 * ## Determinism (#280)
 *
 * This file flaked during #278's fix-round gate. The cause was that "the turn is
 * still in flight" was established with a DURATION and then spent on a reload, a
 * click and a hydrate — three steps whose cost is a property of the machine, not
 * of the app. Turn 2's first call is now PARKED instead, so the window is
 * unbounded and (1)-(3) are checked against a turn that provably has not
 * finished. It is released explicitly, which is also what makes (3) a real claim:
 * the run resumes with nobody reading it.
 */
import { test, expect } from '../lib/fixtures'
import { FAKE_TITLE, VERDA_MODEL } from '../lib/env'
import { expectHeld } from '../lib/control'
import { conversationRows } from '../lib/db'
import {
  open,
  replies,
  send,
  sendButton,
  stopButton,
  threadRow,
  userBubbles,
  waitForReplies,
} from '../lib/chat'

test('a reload mid-turn keeps the conversation, its history, and the run that was in flight', async ({
  page,
  appUrl,
  backend,
}) => {
  await open(page, appUrl)

  // ---- Turn 1: something to lose ----------------------------------------
  await send(page, 'first question')
  await waitForReplies(page, 1)
  await expect(threadRow(page, FAKE_TITLE)).toBeVisible()

  // ---- Turn 2: in flight when the tab dies -------------------------------
  // The turn's first self-hosted BAML call is PARKED, and that is the #280 fix
  // for this file. It used to be a `cold-start` DURATION, which made every
  // assertion after the reload a race: the fake records a call only once it has
  // ANSWERED it, so the `Router` record the reload waited for appeared exactly
  // when its delay had elapsed, and the rest of turn 2 then ran against a
  // reload-plus-hydrate whose cost is a property of the machine. A parked request
  // has no such window — the turn cannot get past it until this test says so.
  //
  // `wake: false` aims past the wake ping, so the park is the HARNESS's own first
  // call whether or not turn 1 left the box inside its scale-down window. Which
  // of those is true is exactly the kind of thing this scenario must not depend
  // on.
  await backend.reset()
  await backend.arm({ kind: 'hold', model: VERDA_MODEL, wake: false })
  await send(page, 'second question')

  // "In flight" as the user sees it: Send has been replaced by Stop.
  await expect(stopButton(page)).toBeVisible()

  // ...and as the SERVER sees it. Stop appears the moment the composer submits,
  // which is before the request has necessarily been handled — the first draft
  // reloaded in that window, the server never started turn 2, and the test still
  // passed because the row was already `done` from turn 1. A PARKED request is
  // strictly better evidence than a recorded one: it says the turn reached this
  // call AND has not got past it, so the turn is running now rather than having
  // been running at some point. `Router` is the first call every turn makes, and
  // the backend was reset a moment ago, so it can only be turn 2's.
  const pinned = await expectHeld(
    backend,
    (held) => held.length === 1,
    'the server never started turn 2, so there was nothing to reload through',
  )
  expect(pinned[0].fn, "the parked call is not the turn's first one").toBe('Router')

  await page.reload()

  // ---- 1. The conversation is still there --------------------------------
  // A reload lands on a fresh chat — the route mints a new session id — so the
  // sidebar is how a user gets back, and its presence is the first thing that
  // would be missing if the row had been lost.
  const row = threadRow(page, FAKE_TITLE)
  await expect(row).toBeVisible()

  // ---- 2. Opening it rebuilds the history --------------------------------
  // Turn 2 is still parked, so `toHaveCount(1)` is a statement about what
  // persistence held rather than a bet that the second reply has not arrived
  // yet. That bet is precisely what used to make this file flake.
  await row.click()
  await expect(userBubbles(page).filter({ hasText: 'first question' })).toHaveCount(1)
  await expect(replies(page)).toHaveCount(1)

  // ---- 3. The run nobody was watching still landed -----------------------
  // Let it go: disarm first, so the calls AFTER the parked one are not parked in
  // turn, then release. `disarm()` rather than `reset()` because the recorded
  // calls are the evidence the poll below reads.
  await backend.disarm()
  expect(await backend.release()).toBe(1)

  // Evidence from the endpoint, not from the row: turn 1 already left the row
  // `done`, so a status check alone cannot tell "turn 2 finished" from "turn 2
  // never ran". `Synthesize` is the last call of a turn and the one whose text
  // becomes the answer, so its arrival is the run completing with nobody
  // reading.
  await expect
    .poll(async () => (await backend.calls()).map((call) => call.fn), {
      timeout: 90_000,
      message: 'the run was abandoned when its reader reloaded away',
    })
    .toContain('Synthesize')

  // And the row is terminal rather than stuck spinning.
  await expect
    .poll(async () => (await conversationRows())[0]?.status, {
      timeout: 60_000,
      message: 'the conversation was left at `running` after its reader reloaded away',
    })
    .toBe('done')

  // And it is readable: reopening the thread shows both turns, in order.
  await page.getByRole('button', { name: 'New chat' }).click()
  await expect(sendButton(page)).toBeVisible()
  await threadRow(page, FAKE_TITLE).click()

  await expect(userBubbles(page)).toHaveCount(2)
  const asked = await userBubbles(page).allInnerTexts()
  expect(asked[0]).toContain('first question')
  expect(asked[1]).toContain('second question')
  await expect(replies(page)).toHaveCount(2)
})
