/**
 * Scenario 3 — clicking the header switch changes where the NEXT call lands.
 *
 * The claim is deliberately about the wire, not about the widget. A segment
 * group that moves under the cursor proves nothing: the failure worth catching
 * is the one where the control shows one tier and the turn runs on another,
 * which is the state `PreviewHeaderStrip` remounts itself to avoid. So each
 * position is checked twice — the header reflects it, AND the fake endpoint
 * recorded the matching `model` on the calls the switch is supposed to move.
 *
 * `app/e2e/scenarios/05-tier-switch` is the authority on the MAPPING — which
 * roles a tier decision moves. It used to prove that `router` / `describe` /
 * `screen` never moved; since the 2026-08-26 owner decision every role is on
 * the tier, and it proves the opposite for `router` and `describe`. What is
 * unproven until here, and unchanged by that, is that a CLICK reaches the
 * mapping at all: the preference is written by a server action from the
 * browser, and nothing below this layer sends that click.
 */
import { test, expect } from '../lib/fixtures'
import { FAKE_ANTHROPIC_TIER_MODEL, VERDA_MODEL } from '../lib/env'
import { open, send, tierOption, waitForReplies } from '../lib/chat'
import type { FakeCall } from '../lib/control'

const PRIVATE = 'Private (Verda)'
const ANTHROPIC = 'Anthropic'

/** The two calls this scenario asserts on. `LoopController` is this chain's
 *  controller role and `Synthesize` its `compactExecution` role.
 *
 *  The filter was originally needed: it kept the roles that stayed on Anthropic
 *  in BOTH positions out of the comparison. Since the tier widening there are
 *  none, so it is now a NARROWING rather than a correction — kept because these
 *  two are separate call sites each spreading their own `clientOverrideFor(role)`
 *  and each turn is guaranteed to make both, whereas the side roles a turn
 *  happens to make vary with the chain and would make a red result ambiguous
 *  about what moved. Widening it to every call is a strictly stronger assertion
 *  today and belongs to the layer that owns the mapping (`app/e2e/`), not to the
 *  one that owns the click. */
const SWITCHED = (calls: FakeCall[]) =>
  calls.filter((call) => call.fn === 'LoopController' || call.fn === 'Synthesize')

test('the header switch moves the next turn to the other endpoint, and shows the position it moved to', async ({
  page,
  appUrl,
  backend,
}) => {
  await open(page, appUrl)

  // ---- Anthropic position ------------------------------------------------
  await tierOption(page, ANTHROPIC).click()
  await expect(page.getByRole('radio', { name: ANTHROPIC })).toBeChecked()
  await expect(page.getByRole('radio', { name: PRIVATE })).not.toBeChecked()

  await send(page, 'first question')
  await waitForReplies(page, 1)

  const onAnthropic = SWITCHED(await backend.calls())
  expect(onAnthropic.length, 'no switched-role call was served at all').toBeGreaterThan(0)
  for (const call of onAnthropic) {
    expect(call.model, `${call.fn} did not take the Anthropic route`).toBe(
      FAKE_ANTHROPIC_TIER_MODEL,
    )
  }

  // ---- Self-hosted position ----------------------------------------------
  await backend.reset()
  await tierOption(page, PRIVATE).click()
  await expect(page.getByRole('radio', { name: PRIVATE })).toBeChecked()
  await expect(page.getByRole('radio', { name: ANTHROPIC })).not.toBeChecked()

  await send(page, 'second question')
  await waitForReplies(page, 2)

  const onVerda = SWITCHED(await backend.calls())
  expect(onVerda.length, 'no switched-role call was served at all').toBeGreaterThan(0)
  for (const call of onVerda) {
    expect(call.model, `${call.fn} did not take the self-hosted route`).toBe(VERDA_MODEL)
  }

  // The switch is a preference, not a fork: both turns are in ONE conversation.
  await expect(page.locator('[data-role="user"]')).toHaveCount(2)

  // And the position survives a reload, because it lives on the server rather
  // than in this tab — which is the whole reason it is a server action.
  await page.reload()
  await expect(page.getByRole('radio', { name: PRIVATE })).toBeChecked()
})
