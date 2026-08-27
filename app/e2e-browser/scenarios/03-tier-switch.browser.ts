/**
 * Scenario 3 — clicking a conversation's switch changes where its NEXT call
 * lands, and only that conversation's.
 *
 * The claim is deliberately about the wire, not about the widget. A segment
 * group that moves under the cursor proves nothing: the failure worth catching
 * is the one where the control shows one tier and the turn runs on another,
 * which is the state `PreviewHeaderStrip` remounts itself to avoid. So each
 * position is checked twice — the header reflects it, AND the fake endpoint
 * recorded the matching `model` on the calls the switch is supposed to move.
 *
 * The second test is the one the per-conversation move exists for: two chats
 * open at once, on different tiers, neither dragging the other. It is here
 * rather than in `app/e2e/` because that layer can set a tier directly — only a
 * browser can prove the CONTROL is per-conversation, i.e. that flipping one and
 * flipping back in the other does not converge them onto one setting.
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
import {
  chooseTier,
  newChat,
  open,
  rowTier,
  send,
  threadRows,
  TIER_LABEL,
  waitForReplies,
} from '../lib/chat'
import type { FakeCall } from '../lib/control'

const PRIVATE = TIER_LABEL.verda
const ANTHROPIC = TIER_LABEL.anthropic

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

test('the switch moves the next turn to the other endpoint, and shows the position it moved to', async ({
  page,
  appUrl,
  backend,
}) => {
  await open(page, appUrl)

  // ---- Anthropic position ------------------------------------------------
  // `chooseTier` clicks AND waits for the persisted row. Both waits are needed
  // and they are different claims — see its docstring. Without the second one,
  // the send below races the server action the click fired, so the turn ran on
  // whichever tier was still stored and this scenario reported it as the app
  // routing to the wrong endpoint (#280).
  await chooseTier(page, 'anthropic')
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
  await chooseTier(page, 'verda')
  await expect(page.getByRole('radio', { name: ANTHROPIC })).not.toBeChecked()

  await send(page, 'second question')
  await waitForReplies(page, 2)

  const onVerda = SWITCHED(await backend.calls())
  expect(onVerda.length, 'no switched-role call was served at all').toBeGreaterThan(0)
  for (const call of onVerda) {
    expect(call.model, `${call.fn} did not take the self-hosted route`).toBe(VERDA_MODEL)
  }

  // The switch is a setting, not a fork: both turns are in ONE conversation, so
  // a mid-thread flip changes where the next turn runs and nothing else.
  await expect(page.locator('[data-role="user"]')).toHaveCount(2)

  // And the position survives a reload, because it lives on the server rather
  // than in this tab — which is the whole reason it is a server action.
  await page.reload()
  await expect(page.getByRole('radio', { name: PRIVATE })).toBeChecked()
})

test('flips one conversation without moving its neighbour, and says so on every row', async ({
  page,
  appUrl,
  backend,
}) => {
  // The motivation for the move, in one scenario: start an Anthropic chat while
  // a private one is waiting on a cold box.
  await open(page, appUrl)

  await chooseTier(page, 'verda')
  await send(page, 'the private one')
  await waitForReplies(page, 1)
  // WINDOWED PER TURN, and this is why the window has to be closed here rather
  // than sliced off the end afterwards: each turn makes TWO switched calls
  // (`LoopController` and `Synthesize`), so the last two calls of the run are
  // both the second chat's and a comparison over them can only ever see one
  // endpoint. Reading each turn's own window instead is also the stronger
  // assertion — it says which endpoint served WHICH chat, not merely that two
  // were used somewhere.
  const onPrivate = SWITCHED(await backend.calls())

  await backend.reset()
  await newChat(page)
  await chooseTier(page, 'anthropic')
  await send(page, 'the anthropic one')
  await waitForReplies(page, 1)
  const onAnthropic = SWITCHED(await backend.calls())

  // Newest-created first, so row 0 is the Anthropic chat and row 1 the private
  // one. Addressed by position because the fake endpoint gives every
  // conversation the same generated title — see `threadRows`.
  await expect(threadRows(page)).toHaveCount(2)
  const newer = threadRows(page).nth(0)
  const older = threadRows(page).nth(1)

  // The sidebar says which is which without hovering anything — the glyph is
  // always visible, unlike the delete and retitle actions above it.
  expect(await rowTier(older)).toBe('verda')
  expect(await rowTier(newer)).toBe('anthropic')

  // Back to the first thread: it kept its own tier, even though the LAST thing
  // the user clicked said Anthropic. Before the move this was one setting and
  // the two would have agreed.
  await older.click()
  await expect(page.getByRole('radio', { name: PRIVATE })).toBeChecked()

  // Not a claim about the widget alone: the second conversation's turn really
  // was served by the other endpoint while the first one's row said verda. Each
  // window is checked whole — every switched call in it, not a set over both —
  // so a single call landing on the wrong endpoint is a red result and names the
  // chat it belonged to.
  expect(onPrivate.length, 'the private chat served no switched-role call at all').toBeGreaterThan(
    0,
  )
  for (const call of onPrivate) {
    expect(call.model, `${call.fn} in the private chat did not take the self-hosted route`).toBe(
      VERDA_MODEL,
    )
  }

  expect(
    onAnthropic.length,
    'the anthropic chat served no switched-role call at all',
  ).toBeGreaterThan(0)
  for (const call of onAnthropic) {
    expect(call.model, `${call.fn} in the anthropic chat did not take the Anthropic route`).toBe(
      FAKE_ANTHROPIC_TIER_MODEL,
    )
  }
})
