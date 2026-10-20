/**
 * Scenario 14 — a wake failure leaves an error bubble that stays.
 *
 * The owner met this on the private tier: the box did not wake, the turn ended
 * fail-closed exactly as designed, and the error "showed and disappeared". The
 * server's `error` frame painted a bubble live, but the turn threw before the
 * harness produced a single event, so nothing was written to the conversation
 * blob — and a reload rebuilds the transcript from the blob alone. Under
 * `app/e2e/` the frame is visible on the wire; only a browser can prove the
 * bubble is still on screen after the NEXT frame and after the tab is rebuilt.
 *
 * The wake is refused with a 400 aimed AT the wake ping (`wake: true`). A 4xx
 * other than 408/429 ends the poll on the spot, so this needs no 600s budget and
 * is deterministic; it is the same `SELF_DEPLOYED_WAKE_FAILED` path a budget expiry
 * takes, because both throw out of `runAndSave`'s try.
 *
 * MUTATION: delete the `recordRunFailure` call from `runAndSave`'s catch in
 * `harness-client/turn.server.ts` → the live bubble still shows, and the
 * error assertions after `page.reload()` redden (the seeded row still holds a
 * first message's user bubble, so only the error goes missing; a CONTINUED
 * conversation losing its new message is pinned at the unit layer).
 */
import { test, expect } from '../lib/fixtures'
import { SELF_DEPLOYED_MODEL } from '../lib/env'
import { conversationRows } from '../lib/db'
import {
  chooseTier,
  coldStartNotice,
  composer,
  errorBubbles,
  letTheBoxGoCold,
  open,
  send,
  threadRow,
  userBubbles,
} from '../lib/chat'

const QUESTION = 'does the wake failure survive a reload?'
const WAKE_FAILED = 'the private inference box did not wake'

for (const theme of ['light', 'dark'] as const) {
  test(`a wake failure leaves a persistent error bubble that survives a reload (${theme})`, async ({
    page,
    appUrl,
    backend,
  }) => {
    await open(page, appUrl, { theme })
    await chooseTier(page, 'self_deployed')

    // The wake only runs when nothing says the box is up.
    await letTheBoxGoCold(page)
    await backend.arm({
      kind: 'status',
      status: 400,
      message: 'e2e-browser: the self-hosted box refuses the wake',
      model: SELF_DEPLOYED_MODEL,
      wake: true,
    })

    await send(page, QUESTION)

    // ---- Live: the bubble is there, the spinner is not -----------------------
    await expect(errorBubbles(page).first()).toBeVisible({ timeout: 90_000 })
    await expect(errorBubbles(page)).toHaveCount(1)
    await expect(errorBubbles(page).first()).toContainText(WAKE_FAILED)
    await expect(coldStartNotice(page)).toBeHidden()
    await expect(composer(page)).toBeEditable()

    // The row ended in an error state, not spinning.
    await expect
      .poll(async () => (await conversationRows())[0]?.status, {
        message: 'the row was left at `running` after the wake failed',
      })
      .toBe('error')

    // ---- Reload: the transcript is rebuilt from the row alone ----------------
    await page.reload()
    await threadRow(page, QUESTION.slice(0, 10)).click()

    await expect(userBubbles(page).filter({ hasText: QUESTION })).toHaveCount(1)
    await expect(errorBubbles(page)).toHaveCount(1)
    await expect(errorBubbles(page).first()).toContainText(WAKE_FAILED)
  })
}
