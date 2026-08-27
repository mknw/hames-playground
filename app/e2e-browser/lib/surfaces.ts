/**
 * The three surfaces the visual and accessibility passes both drive.
 *
 * One module rather than two lists, because the value of both passes is that
 * they look at the SAME thing: a screenshot diff says "this changed", an axe
 * violation says "this is unusable", and reading them side by side is what turns
 * either into a decision. Two lists would drift, and the first time they did, one
 * pass would be silently covering less than its name claims.
 *
 * Three, deliberately, and the choice is about what has actually broken here:
 *
 *  - **the header strip**, which carries the tier switch a preview user is meant
 *    to act on, and whose whole palette is `ui-*` variables redefined per theme
 *    (#226 B8) — so a component can read in dark and vanish in light with no
 *    markup change at all;
 *  - **the sidebar with rows in it**, because an empty sidebar renders almost
 *    nothing; the row is where the icons, the status glyphs and the truncation
 *    live, and `i-mdi-*` (#226 B6) is a class that emits no CSS and leaves a span
 *    with its box and no glyph;
 *  - **one whole chat view** after a completed turn, which is the only one of the
 *    three that includes the composer, a user bubble and an answer at once — i.e.
 *    the layout a person spends the entire session looking at.
 *
 * What is NOT here is listed in `README.md`'s "What is NOT covered". The short
 * version: the graph canvas, the Data Stash, the terminal, the observability
 * panel and the dashboard. Six baseline images already need a human to look at a
 * diff; a set large enough to be skimmed instead of read is worse than a smaller
 * one that is actually read.
 */
import { expect, type Locator, type Page } from '@playwright/test'
import { open, replies, send, threadRow, waitForIdle, waitForReplies } from './chat'
import { FAKE_TITLE, TURN_TIMEOUT_MS } from './env'

/** A surface: how to get the app into the state, and what to look at. */
export interface Surface {
  /** Used in the test title and in the baseline image's filename. */
  readonly name: string
  /** Drive the app into the state, then hand back the region of interest.
   *  Returning the PAGE means "the whole viewport". */
  readonly reach: (page: Page, appUrl: string, theme: 'dark' | 'light') => Promise<Locator | Page>
}

/**
 * Elements whose content legitimately changes between two identical runs.
 *
 * REMOVED from the page before a screenshot (`display: none`), not masked. That
 * is the second thing the mutation testing on scenario 7 corrected, and the
 * reason is layout: Playwright's `mask` paints a box over an element and leaves
 * it in the flow, so an element whose WIDTH varies still moves everything beside
 * it. The header's warm indicator is exactly that — "cold" and "warm 4:58" are
 * different widths — and it shifted the whole metric row, producing a 1152-pixel
 * diff in a run where nothing had changed. Masking the content while leaving the
 * layout channel open is a false sense of a stable baseline.
 *
 * Nothing is lost by removing rather than masking: a masked region asserts nothing
 * about itself either. And these are removed from the VISUAL pass only — axe
 * still walks them, because a live counter is exactly as accessible as a static
 * one.
 *
 * Selectors rather than `Locator`s so the scenario can build one stylesheet out of
 * them; `page` stays out of it entirely.
 */
export const VOLATILE_SELECTORS = [
  // The header's live figures: active people, today's tokens and turns, and a
  // rolling p50 that changes with every call this process makes.
  '[data-testid="preview-header-metrics"]',
  // The warm indicator: a state word whose WIDTH varies, plus a countdown that
  // ticks once a second.
  '[data-testid="verda-warmth"]',
  // Wall-clock times on every bubble ("11:03 PM"): a run either side of a minute
  // boundary differs, and it is the only thing that differs.
  '[data-testid="message-time"]',
  // The sidebar row's RELATIVE time ("just now", "3m ago").
  '[data-testid="thread-time"]',
] as const

/**
 * Take the volatile elements out of the page, and wait until they are gone.
 *
 * `!important` because several of them carry attributify display utilities, and
 * the wait is on the elements rather than on the style tag: injecting CSS is
 * synchronous but the reflow it causes is not, and a screenshot taken during that
 * reflow is its own source of a diff.
 *
 * `toBeHidden` rather than `toHaveCount(0)`: `display: none` leaves the element in
 * the DOM. It also passes for a selector that matches nothing at all, which is
 * what several of these are on any given surface — there is no `thread-time` on
 * the header strip, and no `verda-warmth` on a deployment with no endpoint.
 */
export async function hideVolatile(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `${VOLATILE_SELECTORS.join(', ')} { display: none !important; }`,
  })
  for (const selector of VOLATILE_SELECTORS) {
    await expect(page.locator(selector).first()).toBeHidden()
  }
}

/**
 * One completed turn, so the sidebar has a row and the transcript has an answer.
 *
 * The fake endpoint's replies are fixed strings, so "after a turn" is a
 * reproducible visual state rather than a sampled one — which is the only reason
 * a screenshot baseline can exist for this layer at all.
 */
async function oneCompletedTurn(
  page: Page,
  appUrl: string,
  theme: 'dark' | 'light',
): Promise<void> {
  await open(page, appUrl, { theme })
  await send(page, 'how many nodes are in the graph?')
  await waitForReplies(page, 1)
  await waitForIdle(page)
  // The title arrives on the same stream as the answer but AFTER it, and it is
  // what the sidebar row is named. Waiting for the row rather than for the reply
  // is what stops a baseline being captured against a row that still says
  // "how many nodes…" on one run and "E2E Fake Conversation" on the next.
  await expect(threadRow(page, FAKE_TITLE)).toBeVisible({ timeout: TURN_TIMEOUT_MS })
  // And the answer is settled text, not a stream mid-flight.
  await expect(replies(page).first()).toContainText('42 nodes')
}

export const SURFACES: readonly Surface[] = [
  {
    name: 'header-strip',
    // No turn needed: the strip is chrome and renders before anything else. Its
    // live figures are removed before the shot (see VOLATILE_SELECTORS), so a
    // turn would change nothing here except the wall clock.
    reach: async (page, appUrl, theme) => {
      await open(page, appUrl, { theme })
      const strip = page.getByTestId('app-header-strip')
      await expect(strip).toBeVisible()
      return strip
    },
  },
  {
    name: 'sidebar-with-rows',
    reach: async (page, appUrl, theme) => {
      await oneCompletedTurn(page, appUrl, theme)
      const sidebar = page.getByTestId('chat-sidebar')
      await expect(sidebar).toBeVisible()
      return sidebar
    },
  },
  {
    name: 'chat-view',
    // The chat COLUMN, not the whole viewport, and that is a decision worth
    // stating. The viewport also holds the observability panel, whose content is
    // volatile in a way masking cannot fix: every pattern instance carries a
    // random id suffix (`router-pab3iw`), and the event counts and cost figures
    // move with the run. Masking it would leave a screenshot of two magenta
    // rectangles asserting nothing about the panel and nothing about the chat.
    // The panel is on the "NOT covered" list in `README.md` for the same reason
    // the graph canvas is; a stable identifier for a pattern instance would be
    // the prerequisite for adding it here.
    reach: async (page, appUrl, theme) => {
      await oneCompletedTurn(page, appUrl, theme)
      const column = page.getByTestId('chat-column')
      await expect(column).toBeVisible()
      return column
    },
  },
]

/** The two themes, both of them, every time. A single-theme pass would miss the
 *  exact class of bug the `ui-*` migration introduced. */
export const THEMES = ['dark', 'light'] as const
