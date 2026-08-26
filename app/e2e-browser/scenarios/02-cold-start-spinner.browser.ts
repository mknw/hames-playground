/**
 * Scenario 2 — the cold-start spinner, and its failure twin.
 *
 * THIS IS THE SCENARIO THE LAYER WAS BUILT FOR. The failures that kept reaching
 * the owner were all the same shape: a turn that is fine on the wire and wrong
 * on the screen. `app/e2e/scenarios/08-cold-start-ux` already proves the
 * server emits a `warming` frame during the wait, with a positive estimate,
 * before anything the model said. It cannot prove a spinner appeared, that the
 * progress bar was suppressed in its favour, or that either of them went away —
 * those are browser facts, and until now nothing checked them.
 *
 * Two halves, deliberately in one file because they are one claim with two
 * endings:
 *
 *   - the box is slow, and the wait is VISIBLE then CLEARS;
 *   - the box does not serve, and the turn ends VISIBLY rather than spinning
 *     forever.
 *
 * The second is the exact class the owner hit. It is written to fail loudly if
 * the app ever leaves a spinner up with nothing behind it.
 */
import { test, expect } from '../lib/fixtures'
import { COLD_START_HEADLINE, COLD_START_MS, VERDA_MODEL } from '../lib/env'
import {
  coldStartNotice,
  composer,
  errorBubbles,
  expectFakeAnswer,
  letTheBoxGoCold,
  open,
  progressRange,
  replyTexts,
  send,
  stopButton,
  tierOption,
  waitForReplies,
} from '../lib/chat'

/** The switch's own label for the self-hosted position (`TIER_LABELS.verda`). */
const PRIVATE = 'Private (Verda)'

test('a cold private box shows the warming spinner, suppresses the bar, then clears and answers', async ({
  page,
  appUrl,
  backend,
}) => {
  await open(page, appUrl)
  // The self-hosted position is the deployment default when the endpoint is
  // configured, but a scenario about that tier must not depend on a default it
  // did not set. Clicking it is also what a preview user does.
  await tierOption(page, PRIVATE).click()
  await expect(page.getByRole('radio', { name: PRIVATE })).toBeChecked()

  // TWO calls withheld, not one, and that is what makes the retraction
  // assertion below able to fail — see it for the mutation that survived with
  // `times: 1`. The `model` filter still says "the self-hosted route is the
  // slow one", but since the 2026-08-26 tier widening it no longer separates
  // ROLES: on the private tier every role is self-hosted, so the two withheld
  // calls are simply this turn's first two, whatever they are. The notice now
  // fires from the `router` rather than the controller for the same reason
  // (`clientOverrideFor()` is the hook, so the code did not change).
  await backend.arm({ kind: 'cold-start', ms: COLD_START_MS, model: VERDA_MODEL, times: 2 })

  // The notice fires when nothing says the box is up, and this process has
  // seen self-hosted calls complete (the preflight, and every scenario before
  // this one). Letting the scale-down window lapse is what puts it back in the
  // state a preview user's first message of the morning finds it in.
  await letTheBoxGoCold(page)

  await send(page, 'how many nodes are in the graph?')

  // The wait is on screen, in words, while it is still happening.
  await expect(coldStartNotice(page)).toBeVisible()
  await expect(coldStartNotice(page)).toContainText(COLD_START_HEADLINE)
  await expect(coldStartNotice(page)).toContainText('estimated time to first token')

  // And the progress bar is NOT: it is seeded by the first event of the turn,
  // so leaving it up would park it at 0/N for the whole cold start — which
  // reads as a hung chat rather than as a wait. This is the suppression the
  // notice exists to perform, checked in a browser rather than in jsdom.
  await expect(progressRange(page)).toHaveCount(0)

  // The wait ENDS, and it ends by RETRACTION — which is a different claim from
  // "the notice was gone by the time the turn finished", and the reason this
  // block is not one line.
  //
  // With one call withheld, `toBeHidden` was discharged by teardown: the whole
  // progress shell unmounts when the turn ends (`LiveProgressBar` renders on
  // `props.visible` alone) and `runSend`'s `finally` clears `warming` anyway.
  // An independent review deleted `sink.onWarming(null)` from
  // `turn-stream.ts`'s `clearWarming()` — the exact bug this scenario names,
  // a spinner that sits over the progress bar for the rest of the turn — and
  // the whole suite stayed green. So: two calls are withheld, and the Stop
  // button is asserted still visible at the moment the notice goes away. The
  // turn is provably still running, so nothing but the retraction can have
  // hidden it.
  await expect(coldStartNotice(page)).toBeHidden({ timeout: COLD_START_MS + 60_000 })
  await expect(stopButton(page)).toBeVisible()

  await waitForReplies(page, 1)
  expectFakeAnswer((await replyTexts(page))[0])

  // Evidence the wait was the self-hosted one: the fake withheld calls for the
  // declared model, and only for that model.
  const withheld = (await backend.calls()).filter((call) => call.delayedMs > 0)
  expect(withheld.length).toBe(2)
  for (const call of withheld) expect(call.model).toBe(VERDA_MODEL)
})

test('a private box that will not serve ends the turn visibly, with no spinner left behind', async ({
  page,
  appUrl,
  backend,
}) => {
  await open(page, appUrl)
  await tierOption(page, PRIVATE).click()
  await expect(page.getByRole('radio', { name: PRIVATE })).toBeChecked()

  // Every self-hosted call refused, for the whole turn. A 503 rather than a
  // dropped socket because it is deterministic and fast; `mid-stream` and a
  // refused connect are the other two shapes, and `app/e2e/scenarios/06`
  // already pins that all three end the turn non-silently ON THE WIRE. What is
  // unproven until here is that any of it reaches the screen.
  //
  // Since the 2026-08-26 tier widening that is the WHOLE turn: `router` and
  // `describe` are on the tier too, so a private-tier run has nothing left to
  // fall back on and fails at its first call. That is precisely what a
  // scale-to-zero box that never wakes looks like from the app's side, and it
  // is a strictly harder case than the old one (which still got as far as
  // routing) — the app has to say so with no partial output to show.
  await backend.arm({
    kind: 'status',
    status: 503,
    message: 'e2e-browser: the self-hosted box is not serving',
    model: VERDA_MODEL,
  })

  await send(page, 'how many nodes are in the graph?')

  // THE ASSERTION. Something the user can read says this went wrong.
  await expect(errorBubbles(page).first()).toBeVisible({ timeout: 90_000 })

  // And the wait is not still on screen behind it. Both halves matter: a
  // failure that leaves the spinner up is the shape that reached the owner —
  // the chat looks like it is still working, forever.
  await expect(coldStartNotice(page)).toBeHidden()

  // The composer is usable again, so the user can retry rather than reload.
  await expect(composer(page)).toBeEditable()

  // No answer was fabricated alongside the error.
  const answers = await replyTexts(page)
  expect(answers.filter((text) => text.includes('42 nodes'))).toHaveLength(0)
})
