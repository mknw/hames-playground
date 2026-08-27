/**
 * Scenario 10 — pinning a conversation moves it to the top, and the pinned
 * state is legible without hover.
 *
 * The ordering rule itself is SQL and is pinned at layer 1
 * (`conversations.test.ts`); the toggle's pressed state and its refusal hint
 * are pinned in jsdom (`ChatSidebar.render.test.tsx`). What neither layer can
 * see is the half this scenario exists for: the pin is a **hover-revealed**
 * control, painted at `opacity: 0` until the row is hovered, and a pinned row
 * that only shows its pin under the cursor is a state the user cannot read.
 * Nothing about that is visible to a test that queries the DOM — the element
 * is present, correctly labelled and `aria-pressed="true"` at zero opacity.
 *
 * The two conversations are told apart by what a click LOADS rather than by an
 * id or a row index: both carry the same fake-generated title, so the honest
 * question is "which conversation does the top row open?" — which is also the
 * question the user is asking when they pin one.
 */
import { test, expect } from '../lib/fixtures'
import { open, send, waitForReplies, userBubbles } from '../lib/chat'
import { expectGlyphRenders } from '../lib/visible'

const FIRST = 'what is the oldest conversation about'
const SECOND = 'what is the newest conversation about'

/** Every row's pin toggle, in the order the rows are painted. */
const pins = (page: import('@playwright/test').Page) => page.getByTestId('pin-toggle')

/** The opacity the browser actually resolved — the one property that decides
 *  whether a present, correctly-labelled control is on screen or not. */
const opacityOf = (locator: import('@playwright/test').Locator) =>
  locator.evaluate((el) => getComputedStyle(el).opacity)

/** Open the conversation the sidebar is showing at `index` and report which of
 *  the two questions it holds. */
async function openRow(page: import('@playwright/test').Page, index: number): Promise<void> {
  // The row is the pin's parent wrapper's button sibling; clicking the row's
  // own text is what a user does, so the click goes through the title.
  await page.getByRole('button', { name: 'E2E Fake Conversation' }).nth(index).click()
}

test('a pinned conversation leads the sidebar, reads as pinned without hover, and unpins back', async ({
  page,
  appUrl,
}) => {
  await open(page, appUrl)

  // Two conversations, oldest first. Each is one persisted row.
  await send(page, FIRST)
  await waitForReplies(page, 1)
  await page.getByRole('button', { name: 'New chat' }).click()
  await send(page, SECOND)
  await waitForReplies(page, 1)
  await expect(pins(page)).toHaveCount(2)

  // The "before": newest-created leads, and nothing is pinned.
  await expect(pins(page).nth(0)).toHaveAttribute('aria-pressed', 'false')
  await expect(pins(page).nth(1)).toHaveAttribute('aria-pressed', 'false')
  await openRow(page, 0)
  await expect(userBubbles(page).filter({ hasText: SECOND })).toHaveCount(1)

  // ---- Pin the older conversation, which is the bottom row ----------------
  await pins(page).nth(1).click()
  await expect(pins(page).nth(0)).toHaveAttribute('aria-pressed', 'true')
  await expect(pins(page).nth(1)).toHaveAttribute('aria-pressed', 'false')

  // It is the same conversation that was at the bottom a moment ago — the row
  // moved, rather than the pressed state landing on a different thread.
  await openRow(page, 0)
  await expect(userBubbles(page).filter({ hasText: FIRST })).toHaveCount(1)

  // ---- The state is readable with the cursor nowhere near the list --------
  // Park the pointer off the sidebar first: every one of these controls is
  // revealed on row hover, so measuring under the cursor would pass on the
  // regression this check exists for.
  await page.mouse.move(0, 0)
  await expect(pins(page).nth(0)).toBeVisible()
  expect(await opacityOf(pins(page).nth(0)), 'the pinned row hides its pin until hover').toBe('1')
  // ...and the affordance on an UNpinned row is still hover-only, so "always
  // visible" has not been achieved by simply showing all three actions always.
  expect(await opacityOf(pins(page).nth(1)), 'the unpinned pin control is not hover-revealed').toBe(
    '0',
  )
  // The filled keep glyph actually paints — an unregistered icon class leaves a
  // correctly sized, correctly labelled span that draws nothing.
  await expectGlyphRenders(pins(page).nth(0).locator('span').first(), 'the pinned row’s glyph')

  // ---- Unpin, and the list goes back --------------------------------------
  await pins(page).nth(0).click()
  await expect(pins(page).nth(0)).toHaveAttribute('aria-pressed', 'false')
  await expect(pins(page).nth(1)).toHaveAttribute('aria-pressed', 'false')
  await openRow(page, 0)
  await expect(userBubbles(page).filter({ hasText: SECOND })).toHaveCount(1)
})
