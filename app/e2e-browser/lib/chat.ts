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

/** One position of the header's inference-tier switch. */
export function tierOption(page: Page, label: string): Locator {
  return page.locator('[data-scope="segment-group"][data-part="item"]').filter({ hasText: label })
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
