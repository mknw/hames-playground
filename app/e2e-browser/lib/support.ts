/**
 * Reaching a support-panel tab (#933; the panel is collapsed by default since
 * #1046).
 *
 * A fresh browser context boots the panel collapsed to its icons-only rail,
 * and the rail's icon for a tab does both things at once: it expands the
 * panel AND selects that tab. Once anything has expanded the panel the choice
 * persists (`support-panel.collapsed` = 'false'), so later navigations in the
 * same context meet the tab strip instead. This helper walks whichever door is
 * standing there, so a scenario does not have to track the panel's state to
 * get to a tab — the same way a person just clicks what they can see.
 *
 * Locator discipline as `chat.ts` states it: a role and label for the tab
 * trigger, a `data-testid` the rail already carries for its own tests.
 */
import { expect, type Page } from '@playwright/test'

/**
 * The tab triggers' accessible names by rail id — the two spellings differ
 * (`SUPPORT_RAIL_TABS` labels its entry 'Neo4j' while the tab trigger reads
 * 'Org.graph'), and a scenario asserting on a tab afterwards keeps using the
 * trigger's name, so the mapping lives next to the click rather than in each
 * caller's head.
 */
const TAB_NAME_BY_RAIL_ID = {
  'neo4j-graph': 'Org.graph',
  memory: 'Memory',
  stats: 'Context manager',
  data: 'Data',
  sandbox: 'Sandbox',
} as const

/** Open the support panel on `tab`, whether the panel boots collapsed (the
 *  default) or is already standing expanded from an earlier action. */
export async function openSupportTab<TabId extends keyof typeof TAB_NAME_BY_RAIL_ID>(
  page: Page,
  tab: TabId,
): Promise<void> {
  const name = TAB_NAME_BY_RAIL_ID[tab]
  const rail = page.getByTestId('support-rail')
  const railIcon = page.getByTestId(`support-rail-${tab}`)
  const trigger = page.getByRole('tab', { name, exact: true })
  const tablist = page.getByRole('tablist')

  // Wait for the app to be INTERACTIVE before deciding anything. The rail is
  // in the server-rendered HTML but the tab strip is not — it mounts at
  // hydration — so a tab strip on screen means the page is not just painted
  // but hydrated, and a click will reach a handler. Deciding earlier than
  // this is the trap: right after a navigation neither door has painted, so
  // an instant `isVisible` reads "no rail" from a page that has drawn
  // nothing, and the fallback click on the tab waits for the strip to mount
  // and then retries forever on a tab whose click point is out of bounds
  // (see below).
  await expect(tablist).toHaveCount(1)

  // The RAIL is the branch to test, not the tab — the two do not read the
  // same way while the panel is collapsed. The rail mounts exactly while the
  // panel is collapsed, so it is an honest signal. A collapsed panel's tab
  // trigger is NOT: the 0-width panel clips it but leaves it a non-empty box
  // outside the panel's bounds, so Playwright calls it "visible" while its
  // click point sits past the viewport edge, over the rail or the chat
  // column — a click that retries until the test's budget dies. Rail first,
  // then.
  if (await rail.isVisible()) {
    await railIcon.click()
    // The rail unmounts exactly when the panel has width — the honest proof
    // the click expanded anything.
    await expect(rail).toHaveCount(0)
  } else {
    await trigger.click()
  }
  // The observable end: the panel is standing expanded (no rail) with the
  // tab strip showing this tab.
  await expect(rail).toHaveCount(0)
  await expect(trigger).toBeVisible()
}
