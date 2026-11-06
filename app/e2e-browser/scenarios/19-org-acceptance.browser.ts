/** Org-knowledge hook, slice 5 layer 3 (`docs/plan/org-knowledge-hook.md`): the
 * acceptance card and the Org.graph tab as a person meets them.
 *
 * A real turn through the real dev server: the hook's gate (the fake adds for
 * this message alone), the draft (one new Project), the validator, the held
 * proposal, written to the dev-only in-memory org graph
 * (`src/lib/org-graph/dev-memory-org-graph.server.ts`). What only this layer can
 * say: the card is painted under the reply; Discard paints nothing; Add paints
 * the added node in the "added" colour on the canvas, with the legend word.
 *
 * Discard runs first, against the empty graph: once Heron is accepted, the same
 * message only reinforces it, and an all-reinforce draft raises nothing (LD-6).
 */
import { test, expect } from '../lib/fixtures'
import { newChat, open, send, waitForReplies } from '../lib/chat'
import { FAKE_ORG_MESSAGE } from '../../e2e/lib/fake-llm'

/** The proposal arrives after the reply, on the card's poll (2s, 8s, 30s). */
const CARD_TIMEOUT_MS = 45_000

/** Pixels on the Org.graph canvases painted in the "added" colour (#d9822b,
 *  `ADDED_COLOUR` in `SupportPanel.tsx`, toned down from #ff6600 by #1008).
 *  Cytoscape draws on 2D canvases, so the page can read them back;
 *  antialiasing is why it is a tolerance, not an equality. */
async function addedPixels(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(() => {
    // The Cytoscape canvases are the only canvases the app draws, and the tab
    // mounts its canvas only while it is the active tab (`lazyMount`).
    let n = 0
    for (const canvas of document.querySelectorAll('canvas')) {
      const ctx = (canvas as HTMLCanvasElement).getContext('2d')
      if (!ctx || canvas.width === 0 || canvas.height === 0) continue
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
      for (let i = 0; i < data.length; i += 4) {
        const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]]
        if (a > 200 && r > 195 && r < 240 && g > 110 && g < 150 && b > 15 && b < 75) n++
      }
    }
    return n
  })
}

test('a proposal is added to Org.graph only on Add, and the added node is painted', async ({
  page,
  appUrl,
}) => {
  await open(page, appUrl)
  const card = page.getByTestId('org-proposal-card')
  const orgTab = page.getByRole('tab', { name: 'Org.graph', exact: true })

  // ---- Discard: nothing written, nothing drawn ------------------------------
  await send(page, FAKE_ORG_MESSAGE)
  await waitForReplies(page, 1)
  await expect(card).toBeVisible({ timeout: CARD_TIMEOUT_MS })
  await expect(card.getByRole('heading', { name: 'Add to Org.graph?' })).toBeVisible()
  await expect(card.getByText('Heron', { exact: false })).toBeVisible()
  await card.getByRole('button', { name: 'Discard' }).click()
  await expect(
    page.getByRole('status').filter({ hasText: 'Nothing was added to Org.graph.' }),
  ).toBeVisible()
  await expect(card).toHaveCount(0)
  await orgTab.click()
  await expect(page.getByTestId('graph-legend-added')).toHaveCount(0)
  expect(await addedPixels(page)).toBe(0)

  // ---- Add: written, painted in the added colour, named in the legend -------
  await newChat(page)
  await send(page, FAKE_ORG_MESSAGE)
  await waitForReplies(page, 1)
  await expect(card).toBeVisible({ timeout: CARD_TIMEOUT_MS })
  await card.getByRole('button', { name: 'Add to Org.graph' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Added 1 to Org.graph.' })).toBeVisible()
  await orgTab.click()
  await expect(page.getByTestId('graph-legend-added')).toHaveText('added')
  await expect.poll(() => addedPixels(page), { timeout: 10_000 }).toBeGreaterThan(0)
})
