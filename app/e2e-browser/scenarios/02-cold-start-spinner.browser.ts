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
 *
 * ## Determinism (#280)
 *
 * This file flaked once during #278's review, and the cause was structural rather
 * than incidental: every claim it makes is about a turn that is STILL RUNNING, and
 * it established that with a duration — `cold-start`, N milliseconds — so each
 * assertion was racing the fake's clock. Nothing here waits on a duration any
 * more. The requests are PARKED (`hold`) and released by name, so "the turn is
 * waiting on the box", "the notice retracted while the turn was still running"
 * and "Stop is still visible" are facts this test established rather than windows
 * it hoped to land inside. `e2e/lib/fake-llm.ts`'s `hold` section is the writeup.
 *
 * The failure half had a second, quieter non-determinism: which request the 503
 * hit depended on whether the first half had left the box warm. See its `arm`.
 */
import { test, expect } from '../lib/fixtures'
import { COLD_START_HEADLINE, VERDA_MODEL } from '../lib/env'
import { expectHeld } from '../lib/control'
import {
  chooseTier,
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
  waitForReplies,
} from '../lib/chat'

test('a cold private box shows the warming spinner, suppresses the bar, then clears and answers', async ({
  page,
  appUrl,
  backend,
}) => {
  await open(page, appUrl)
  // The self-hosted position is the deployment default when the endpoint is
  // configured, but a scenario about that tier must not depend on a default it
  // did not set. Clicking it is also what a preview user does — and `chooseTier`
  // waits for the SERVER to have the choice, not just the widget, without which
  // the turn below could still run on the tier this click is leaving.
  await chooseTier(page, 'verda')

  // PARKED, not delayed — and that is the whole #280 fix for this file. Every
  // self-hosted request is held open until this test releases it, so each claim
  // below is made while the turn PROVABLY cannot advance instead of inside a
  // window bounded by a duration. The two flakes this replaces are written up on
  // `e2e/lib/fake-llm.ts`'s `hold` section; what they had in common is that the
  // assertions and the fake's clock were racing, and the loser was whichever
  // machine happened to be busier.
  //
  // The `model` filter still says "the self-hosted route is the slow one". Since
  // the 2026-08-26 tier widening it no longer separates ROLES — on the private
  // tier every role is self-hosted — but it does still separate the 27B from the
  // 4B `describe` model, which is why the withheld-call assertion at the end can
  // still count.
  await backend.arm({ kind: 'hold', model: VERDA_MODEL })

  // The notice fires when nothing says the box is up, and this process has
  // seen self-hosted calls complete (the preflight, and every scenario before
  // this one). Letting the scale-down window lapse is what puts it back in the
  // state a preview user's first message of the morning finds it in.
  await letTheBoxGoCold(page)

  await send(page, 'how many nodes are in the graph?')

  // ---- The turn is waiting on the box, and that is a FACT, not a deadline ----
  // Wake-then-run makes the ping the first request on the wire, so the parked
  // request being the ping is also the check that `letTheBoxGoCold` took: a BAML
  // call here would mean the app thought the box was warm and skipped the wake,
  // in which case this scenario is no longer about a cold start at all.
  const waiting = await expectHeld(
    backend,
    (held) => held.length === 1,
    'no self-hosted request was parked, so the turn never reached the box',
  )
  expect(
    waiting[0].wake,
    'the parked request is not the wake ping — the app believed the box was warm, ' +
      'so this run is not exercising a cold start',
  ).toBe(true)

  // The wait is on screen, in words, while it is still happening.
  await expect(coldStartNotice(page)).toBeVisible()
  await expect(coldStartNotice(page)).toContainText(COLD_START_HEADLINE)
  await expect(coldStartNotice(page)).toContainText('estimated time to first token')

  // And the progress bar is NOT: it is seeded by the first event of the turn,
  // so leaving it up would park it at 0/N for the whole cold start — which
  // reads as a hung chat rather than as a wait. This is the suppression the
  // notice exists to perform, checked in a browser rather than in jsdom.
  await expect(progressRange(page)).toHaveCount(0)

  // ---- The wait ENDS, and it ends by RETRACTION ----------------------------
  // Which is a different claim from "the notice was gone by the time the turn
  // finished", and the reason this block is not one line. An independent review
  // deleted `sink.onWarming(null)` from `turn-stream.ts`'s `clearWarming()` — the
  // exact bug this scenario names, a spinner that sits over the progress bar for
  // the rest of the turn — and the whole suite stayed green, because the progress
  // shell unmounts when the turn ends (`LiveProgressBar` renders on
  // `props.visible` alone) and `runSend`'s `finally` clears `warming` anyway.
  //
  // So: release ONLY the wake. The box is now up and the harness starts, and its
  // first call parks in turn — which pins the turn open for as long as this test
  // wants. Nothing but the retraction can hide the notice now, and Stop being
  // visible is checked in the same pinned state rather than a moment later.
  expect(await backend.release(1)).toBe(1)
  await expectHeld(
    backend,
    (held) => held.length === 1 && !held[0].wake,
    'the harness made no self-hosted call after the box woke, so the turn is not ' +
      'pinned and the retraction below would be racing its completion',
  )

  await expect(coldStartNotice(page)).toBeHidden()
  await expect(stopButton(page)).toBeVisible()

  // ---- And then it answers -------------------------------------------------
  await backend.disarm()
  await backend.release()

  await waitForReplies(page, 1)
  expectFakeAnswer((await replyTexts(page))[0])

  // Evidence the wait was the self-hosted one: exactly the two requests this
  // test parked were withheld, and both named the declared model.
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
  await chooseTier(page, 'verda')

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
  // `wake: false` is what makes this half deterministic (#280). Without it the
  // 503 lands on whichever request comes first, and WHICH that is depends on
  // whether the test above left the box inside its scale-down window — so the
  // same file exercised the wake-failure path or the harness-failure path
  // depending on how long a teardown took. Aiming past the ping fixes the path:
  // the box always wakes, and the harness's first call is always the one refused.
  // The wake-failure twin (`VERDA_WAKE_FAILED` reaching the transcript) is
  // `app/e2e/scenarios/06`'s, on the wire.
  await backend.arm({
    kind: 'status',
    status: 503,
    message: 'e2e-browser: the self-hosted box is not serving',
    model: VERDA_MODEL,
    wake: false,
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
