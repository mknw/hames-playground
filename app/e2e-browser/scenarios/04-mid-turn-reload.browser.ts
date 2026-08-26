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
 */
import { test, expect } from '../lib/fixtures'
import { COLD_START_MS, FAKE_TITLE, VERDA_MODEL } from '../lib/env'
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
  // TWO self-hosted calls withheld, so the turn is provably still running when
  // the reload happens rather than racing it.
  //
  // Two rather than one because of what the evidence below actually is. The
  // fake records a call AFTER serving it, so the `Router` record the poll waits
  // for only appears once that call's delay has ELAPSED — and since the
  // 2026-08-26 tier widening the router is itself self-hosted, i.e. it is the
  // first call the fault hits. With one withheld call the reload therefore
  // landed after the only delay in the turn, and the rest of turn 2 raced it to
  // completion: the reopened thread showed two replies where the scenario means
  // to see one. Withholding the next call as well leaves a full
  // `COLD_START_MS` of in-flight turn on the far side of the poll.
  await backend.reset()
  await backend.arm({ kind: 'cold-start', ms: COLD_START_MS, model: VERDA_MODEL, times: 2 })
  await send(page, 'second question')

  // "In flight" as the user sees it: Send has been replaced by Stop.
  await expect(stopButton(page)).toBeVisible()

  // ...and as the SERVER sees it. Stop appears the moment the composer
  // submits, which is before the request has necessarily been handled — the
  // first draft reloaded in that window, the server never started turn 2, and
  // the test still passed because the row was already `done` from turn 1. So
  // the reload waits for evidence the turn is actually running: `Router` is
  // the first call every turn makes, and the backend was reset a moment ago,
  // so this call can only be turn 2's. See the arm above for why proving the
  // turn STARTED is not on its own enough to prove it is still running.
  await expect
    .poll(async () => (await backend.calls()).map((call) => call.fn), {
      message: 'the server never started turn 2, so there was nothing to reload through',
    })
    .toContain('Router')

  await page.reload()

  // ---- 1. The conversation is still there --------------------------------
  // A reload lands on a fresh chat — the route mints a new session id — so the
  // sidebar is how a user gets back, and its presence is the first thing that
  // would be missing if the row had been lost.
  const row = threadRow(page, FAKE_TITLE)
  await expect(row).toBeVisible()

  // ---- 2. Opening it rebuilds the history --------------------------------
  await row.click()
  await expect(userBubbles(page).filter({ hasText: 'first question' })).toHaveCount(1)
  await expect(replies(page)).toHaveCount(1)

  // ---- 3. The run nobody was watching still landed -----------------------
  // Evidence from the endpoint, not from the row: turn 1 already left the row
  // `done`, so a status check alone cannot tell "turn 2 finished" from "turn 2
  // never ran". `Synthesize` is the last call of a turn and the one whose text
  // becomes the answer, so its arrival is the run completing with nobody
  // reading.
  await expect
    .poll(async () => (await backend.calls()).map((call) => call.fn), {
      timeout: COLD_START_MS + 90_000,
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
