/**
 * Scenario 9 — a conversation gets a URL, and a link someone else can open.
 *
 * Two features, one scenario, because they are one flow from the chair: the
 * conversation acquires an address, the owner turns that into a share link, and
 * a second browser opens it.
 *
 * What only THIS layer can say (`kg-test-pyramid` rule 3): the transcript is
 * PAINTED for the visitor, and the controls a visitor must not have are not on
 * the page. Both were true on the wire in every layer below and neither is a
 * claim any of them makes — the route composition, the auth gate's public-route
 * exemption and the top bar's own hiding all have to line up before a person
 * sees a readable page, and a component test cannot see three modules disagree.
 *
 * ## The one thing this layer CANNOT assert, said plainly
 *
 * The second context here has its own cookie jar, but this suite runs the dev
 * server with `VITE_DEV_BYPASS_AUTH=true` (`lib/env.ts`), and the bypass is a
 * build-time constant rather than a cookie — so the app authenticates every
 * context, including this one. "A visitor with no session sees it" is therefore
 * NOT proved here. It is proved structurally, one layer down:
 * `src/__tests__/lib/harness-client/public-share-surface.test.ts` pins that the
 * public read module imports nothing from `auth/` and exports exactly one
 * function, and `src/__tests__/components/AuthProvider.test.tsx` pins that a
 * null session on `/s/…` renders the page instead of redirecting. What a fresh
 * context still buys here is real: no `localStorage`, no in-memory app state,
 * no thread list — the page has to stand up from the URL alone.
 */
import { test, expect } from '../lib/fixtures'
import { FAKE_TITLE } from '../lib/env'
import { expectFakeAnswer, open, replyTexts, send, threadRow, waitForReplies } from '../lib/chat'

const QUESTION = 'how many nodes are in the graph?'

test('an owner shares a conversation and a second browser reads it, until it is unshared', async ({
  page,
  appUrl,
  browser,
}) => {
  await open(page, appUrl)
  await send(page, QUESTION)
  await waitForReplies(page, 1)
  const [answer] = await replyTexts(page)
  expectFakeAnswer(answer)

  // ---- 1. The conversation now has an address -----------------------------
  // The row exists, so the chat that started at a bare `/` has been given its
  // id in the URL. That is what makes it bookmarkable at all, and what the
  // share link is built beside.
  await expect
    .poll(() => new URL(page.url()).searchParams.get('c'), {
      message: 'the conversation never appeared in the URL, so nothing could be bookmarked',
    })
    .not.toBeNull()
  const conversationId = new URL(page.url()).searchParams.get('c')!

  // A reload of that URL restores the same conversation rather than a blank
  // one — the claim a bookmark actually makes.
  await page.reload()
  await expect(page.locator('[data-role="user"]').filter({ hasText: QUESTION })).toHaveCount(1)
  await waitForReplies(page, 1)

  // ---- 2. Share it --------------------------------------------------------
  const shareButton = page.getByRole('button', { name: 'Share conversation' })
  await expect(shareButton).toBeVisible()
  await shareButton.click()

  // The confirmation comes BEFORE the link. A dialog that opened straight onto
  // a live link would have shared the conversation without being asked.
  await expect(page.getByText('is this ok?')).toBeVisible()
  await expect(page.locator('[data-testid="share-conversation-link"]')).toHaveCount(0)

  await page.getByRole('button', { name: 'Yes, create link' }).click()

  const linkField = page.locator('[data-testid="share-conversation-link"]')
  await expect(linkField).toBeVisible()
  const shareLink = await linkField.inputValue()
  // The token is not the conversation id — the property that lets the id sit in
  // a URL, a bookmark and a browser history without granting anyone access.
  expect(shareLink).toContain('/s/')
  expect(shareLink).not.toContain(conversationId)

  // ---- 3. A second browser opens it ---------------------------------------
  const visitorContext = await browser.newContext()
  const visitor = await visitorContext.newPage()
  try {
    await visitor.goto(shareLink)

    // The transcript is on screen — both turns, as bubbles, not as a payload.
    await expect(visitor.locator('[data-role="user"]').filter({ hasText: QUESTION })).toHaveCount(1)
    const visitorAnswers = await visitor.locator('[data-role="assistant"]').allInnerTexts()
    expect(visitorAnswers.join('\n')).toContain(answer)

    // And it says what it is. A visitor cannot infer "read-only" from an absent
    // text box.
    await expect(visitor.locator('[data-testid="shared-conversation-banner"]')).toContainText(
      'read-only',
    )
    await expect(visitor.getByText(FAKE_TITLE).first()).toBeVisible()

    // The controls a visitor must not have are ABSENT, not disabled. Located by
    // the accessible names a person would use, per this suite's rule.
    await expect(visitor.getByPlaceholder('Type your message')).toHaveCount(0)
    await expect(visitor.getByRole('button', { name: 'Send message' })).toHaveCount(0)
    await expect(visitor.getByRole('button', { name: 'New chat' })).toHaveCount(0)
    await expect(visitor.getByRole('button', { name: 'Share conversation' })).toHaveCount(0)
    await expect(visitor.getByText('Agent:')).toHaveCount(0)
    // The top bar's session-shaped controls go too: another user's metrics and
    // a user menu are promises this page cannot keep.
    await expect(visitor.getByRole('link', { name: 'Metrics dashboard' })).toHaveCount(0)

    // ---- 4. Unshare, and the same link stops working ----------------------
    await page.getByRole('button', { name: 'Stop sharing' }).click()
    await expect(page.locator('[data-testid="share-conversation-link"]')).toHaveCount(0)

    await visitor.reload()
    await expect(visitor.locator('[data-testid="shared-conversation-missing"]')).toBeVisible()
    // Nothing on the page admits there is a conversation behind the link.
    await expect(visitor.locator('body')).not.toContainText(QUESTION)
    await expect(visitor.locator('body')).not.toContainText('no longer shared')
  } finally {
    await visitorContext.close()
  }

  // The owner's own view is untouched by all of this.
  await expect(threadRow(page, FAKE_TITLE)).toBeVisible()
  await waitForReplies(page, 1)
})
