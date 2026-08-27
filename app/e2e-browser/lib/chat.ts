/**
 * What a user can see and do, named once.
 *
 * Every locator here is a ROLE, a LABEL or a `data-testid` the components
 * already carry for their own tests — never a class, a colour or a DOM shape.
 * That is not tidiness: this layer exists because component tests can pass
 * against markup no human could use, and a suite that reached for
 * `.flex.gap-3 > div:nth-child(2)` would reintroduce exactly that. If a
 * scenario cannot find something by its accessible name, the finding is about
 * the app's accessibility, not about the selector.
 *
 * The one shape-ish selector is `[data-role="assistant"]:not([data-progress])`,
 * and it is load-bearing: `LiveProgressBar` renders itself as an assistant-row
 * so it lands where the next bubble will, and stamps `data-progress` to say it
 * is not one. Counting it as a reply would make "the answer arrived" true while
 * the spinner was still up — the exact confusion this layer is here to catch.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { FAKE_ANSWER_MARK, GO_COLD_MS, TURN_TIMEOUT_MS } from './env'
import { storedTier } from './db'

/** The first bubble the app paints before any turn. Excluded from replies —
 *  it is chrome, not an answer. */
const WELCOME_PREFIX = "Hello! I'm your knowledge assistant"

export function composer(page: Page): Locator {
  return page.getByPlaceholder('Type your message')
}

export function sendButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Send message' })
}

export function stopButton(page: Page): Locator {
  return page.getByRole('button', { name: 'Stop generating' })
}

/** Assistant bubbles, excluding the progress row (see the header). */
export function assistantBubbles(page: Page): Locator {
  return page.locator('[data-role="assistant"]:not([data-progress])')
}

/** Assistant bubbles that are actual answers — the welcome message dropped. */
export function replies(page: Page): Locator {
  return assistantBubbles(page).filter({ hasNotText: WELCOME_PREFIX })
}

export function userBubbles(page: Page): Locator {
  return page.locator('[data-role="user"]')
}

/** The red bubble a failed turn is supposed to leave in the transcript. */
export function errorBubbles(page: Page): Locator {
  return page.locator('[data-role="error"]')
}

/** The cold-start notice: spinner + headline + counting-down estimate. */
export function coldStartNotice(page: Page): Locator {
  return page.locator('[data-testid="cold-start-notice"]')
}

/** The shared shell the notice and the bar swap inside. */
export function progressShell(page: Page): Locator {
  return page.locator('[data-testid="progress-shell"]')
}

/** The linear progress bar's filled range — present only in the NON-warming
 *  variant, which is what makes "the bar was suppressed" checkable. */
export function progressRange(page: Page): Locator {
  return progressShell(page).locator('[data-part="range"]')
}

/**
 * The tier switch's two positions, by the label a user reads.
 *
 * Mirrors `TIER_LABELS` in `src/lib/tier-presentation.ts` rather than importing
 * it, for this file's usual reason: a scenario asserting on an accessible name
 * should go red if the app renames it.
 */
export const TIER_LABEL = {
  verda: 'Private (Verda)',
  anthropic: 'Anthropic',
} as const

export type Tier = keyof typeof TIER_LABEL

/** One position of the conversation's inference-tier switch, which sits beside
 *  the agent selector. */
export function tierOption(page: Page, label: string): Locator {
  return page.locator('[data-scope="segment-group"][data-part="item"]').filter({ hasText: label })
}

/**
 * Put the OPEN CONVERSATION on a tier through its switch, and wait until the
 * SERVER has it — not just the widget.
 *
 * Three things had to be got right here, and each of them was a way the browser
 * suite could go red with nothing wrong in the app (#280).
 *
 * **1. `toBeChecked()` is not evidence.** Ark's segment group owns its selection
 * and moves it the instant the click lands, while the server action that persists
 * the choice is still in flight. A scenario that clicked and immediately sent
 * therefore raced the write: the turn resolved whatever was still stored, ran on
 * the tier the test thought it was leaving, and the failure blamed the app's
 * routing. So this also waits on Postgres, because there is no DOM evidence of
 * the write landing — the switch looks identical before and after.
 *
 * What it waits for is the SEED row (`user_prefs`), and that is a deliberate
 * choice rather than a leftover: a conversation with no row yet — every scenario
 * that clicks before its first message — resolves through exactly that row, and
 * `chooseConversationTier` writes the conversation's own column FIRST, so the
 * seed's arrival implies the conversation's. One wait covers both cases.
 *
 * **2. Clicking the tier you are already on writes nothing.** The switch's
 * handler returns early when the clicked value equals the current one, so no
 * action fires and no row appears. That is not an edge case: every scenario
 * starts with `wipeUserRows()` having deleted the seed, and the private tier is
 * the DEFAULT when the endpoint is configured — so `chooseTier(page, 'verda')`
 * on a fresh page is exactly that no-op. This therefore always goes VIA the
 * other position, unconditionally rather than conditionally: a branch on "is a
 * row already there" would make the wait's behaviour depend on the state it is
 * trying to establish.
 *
 * **3. The switch is disabled while an action is in flight** (`disabled={busy()}`),
 * so a click sent during one is silently dropped. Each click waits for the control
 * to be enabled first.
 *
 * The cost is one extra round trip. What it buys is that every scenario after this
 * line is running on the tier it asked for, provably.
 */
export async function chooseTier(page: Page, tier: Tier): Promise<void> {
  const other: Tier = tier === 'verda' ? 'anthropic' : 'verda'

  await clickTier(page, other)
  // The FIRST click's persistence is deliberately not asserted: when the page
  // already sits on `other`, it is the no-op of point 2 and there is nothing to
  // wait for. What matters is that the switch has settled before the next click.
  await expect(page.getByRole('radio', { name: TIER_LABEL[other] })).toBeChecked()

  await clickTier(page, tier)
  await expect(page.getByRole('radio', { name: TIER_LABEL[tier] })).toBeChecked()
  await expect
    .poll(async () => storedTier(), {
      message:
        `the tier switch never persisted \`${tier}\` — the next turn would run on ` +
        'whatever tier was already stored, and this scenario would blame the routing',
    })
    .toBe(tier)
}

/** One click on the switch, after waiting for it to be accepting clicks. */
async function clickTier(page: Page, tier: Tier): Promise<void> {
  const label = TIER_LABEL[tier]
  // `tierOption` targets the visible item (the hidden radio cannot be clicked),
  // and Playwright's own actionability check does not see the item as disabled —
  // the `disabled` attribute lands on the input. So the wait is explicit.
  await expect(page.getByRole('radio', { name: label })).toBeEnabled()
  await tierOption(page, label).click()
}

/** Start a fresh conversation, the way a user does. */
export async function newChat(page: Page): Promise<void> {
  await page.getByRole('button', { name: '+ New Chat' }).click()
  await expect(composer(page)).toBeEnabled()
}

/**
 * Every sidebar conversation row, newest-created first — the order
 * `listConversations` returns and the sidebar preserves.
 *
 * By index rather than by title, which sounds worse than it is: the fake
 * endpoint answers the title generator with one fixed string, so every row in
 * this suite reads "E2E Fake Conversation" and a title locator cannot tell two
 * conversations apart. Creation order can, and it is a property the app
 * documents (#105) rather than an accident of this fake.
 */
export function threadRows(page: Page): Locator {
  return page.locator('[data-testid="thread-row"]')
}

/**
 * The tier glyph on one sidebar row, as a tier name.
 *
 * Read from `data-tier` rather than from the icon class: the class is what the
 * app happens to draw with, the attribute is the claim. The glyph is always
 * visible — unlike the delete and retitle actions above it — so this needs no
 * hover, and asking for it without one is part of the assertion.
 */
export async function rowTier(row: Locator): Promise<string | null> {
  return row.locator('[role="img"][data-tier]').getAttribute('data-tier')
}

/** A sidebar conversation row, by the title a user reads on it. */
export function threadRow(page: Page, title: string): Locator {
  return page
    .locator('[data-placeholder], button')
    .filter({ hasText: title })
    .filter({ hasNotText: 'Send message' })
    .first()
}

/**
 * Type a message and press Send.
 *
 * Deliberately the button rather than the Enter key: both are shipped
 * affordances, and the button is the one a first-time user finds. The Enter
 * path has its own component test.
 */
export async function send(page: Page, message: string): Promise<void> {
  await composer(page).fill(message)
  await expect(sendButton(page)).toBeEnabled()
  await sendButton(page).click()
}

/**
 * Wait until the transcript holds `count` answers.
 *
 * Waits on the RENDERED transcript rather than on a network idle or a server
 * status, because "the reply appeared on screen" is the claim. A turn that
 * completes server-side and never paints is the failure class this layer was
 * built for, and a network-level wait would call it a pass.
 */
export async function waitForReplies(page: Page, count: number): Promise<void> {
  await expect(replies(page)).toHaveCount(count, { timeout: TURN_TIMEOUT_MS })
}

/** The turn is over as far as the composer is concerned: Send is back. */
export async function waitForIdle(page: Page): Promise<void> {
  await expect(sendButton(page)).toBeVisible({ timeout: TURN_TIMEOUT_MS })
}

/** Every answer in the transcript, in order, as a user would read them. */
export async function replyTexts(page: Page): Promise<string[]> {
  return (await replies(page).allInnerTexts()).map((t) => t.trim())
}

/** Assert an answer is the fake's, not a real provider's. */
export function expectFakeAnswer(text: string): void {
  expect(text, "the answer did not carry the fake endpoint's marker").toContain(FAKE_ANSWER_MARK)
}

/**
 * Wait until the app considers the self-hosted box cold again.
 *
 * A real wall-clock wait, and it has to be: warmth is "a call completed inside
 * the scale-down window", so the only way to leave that window is for time to
 * pass. The window is two seconds here (`VERDA_SCALEDOWN_SECONDS` in global
 * setup), which is what makes waiting for it affordable — see that constant for
 * why the shipped 180 would make the cold-start notice untestable.
 */
export async function letTheBoxGoCold(page: Page): Promise<void> {
  await page.waitForTimeout(GO_COLD_MS)
}

/**
 * Open the app on a clean slate.
 *
 * `localStorage` is seeded BEFORE the first script runs (`addInitScript`), not
 * clicked afterwards: the theme is applied by an inline boot script in
 * `entry-server.tsx` to avoid a flash, so a theme chosen after load would
 * measure a repaint rather than the shipped path.
 */
export async function open(
  page: Page,
  appUrl: string,
  options: { theme?: 'light' | 'dark' } = {},
): Promise<void> {
  if (options.theme) {
    await page.addInitScript((theme) => {
      window.localStorage.setItem('theme', theme)
    }, options.theme)
  }
  await page.goto(appUrl)
  await expect(composer(page)).toBeVisible()
}
