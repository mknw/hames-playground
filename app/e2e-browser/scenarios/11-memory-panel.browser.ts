/** M7 layer 3: actual painted controls, both palettes, dialog focus and axe.
 * No turn is sent: synthetic rows and the real owner-scoped RPCs need no model.
 */
import pg from 'pg'
import { readFile } from 'node:fs/promises'
import AxeBuilder from '@axe-core/playwright'
import { test, expect } from '../lib/fixtures'
import { open } from '../lib/chat'
import { BYPASS_USER_ID, TEST_DATABASE_URL } from '../lib/env'

for (const theme of ['dark', 'light'] as const) {
  test(`personal memory can be inspected, exported and forgotten in ${theme}`, async ({
    page,
    appUrl,
  }) => {
    await open(page, appUrl, { theme })
    await page.getByRole('tab', { name: 'Memory', exact: true }).click()
    const panel = page.getByRole('region', { name: 'What I remember about you' })
    await expect(panel.getByText('No saved memories.')).toBeVisible()
    const toggle = panel.getByRole('checkbox', { name: 'Memory enabled' })
    await expect(toggle).not.toBeChecked()
    await toggle.press('Space')
    await expect(toggle).toBeChecked()
    await expect(toggle).toBeEnabled()

    // Legacy plaintext read compatibility is supported; these are synthetic
    // fixtures only, inserted after the app created its real schema.
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL })
    await client.connect()
    try {
      const vector = JSON.stringify(Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)))
      for (const [id, content, merged] of [
        ['m7-first', 'I prefer synthetic examples', 3],
        ['m7-second', 'I prefer concise replies', 1],
      ] as const) {
        await client.query(
          `INSERT INTO memories (id, user_id, kind, tier, content, evidence, embedding, embed_space, compacted_from)
          VALUES ($1, $2, 'preference', 'verda', $3, $3, $4::vector, 'synthetic', $5)`,
          [id, BYPASS_USER_ID, content, vector, merged],
        )
      }
    } finally {
      await client.end()
    }
    await page.reload()
    await page.getByRole('tab', { name: 'Memory', exact: true }).click()
    await expect(panel.getByText('I prefer synthetic examples', { exact: true })).toBeVisible()
    await expect(panel.getByText('Merged from 3')).toBeVisible()
    await expect(panel.getByText('Merged from 1', { exact: true })).toHaveCount(0)
    await expect(panel.getByText(/Forget deletes rows/)).toBeVisible()
    const downloadPromise = page.waitForEvent('download')
    await panel.getByRole('button', { name: 'Export my memories (Art. 15)' }).click()
    const download = await downloadPromise
    const exported = JSON.parse(await readFile((await download.path())!, 'utf8'))
    expect(exported.memories).toHaveLength(2)
    expect(exported.memories[0]).toHaveProperty('embedding')
    await expect(panel.getByRole('button', { name: 'Export my memories (Art. 15)' })).toBeEnabled()
    await panel
      .getByRole('button', { name: 'Forget I prefer synthetic examples', exact: true })
      .click()
    await expect(panel.getByText('I prefer synthetic examples', { exact: true })).toHaveCount(0)
    await panel.getByRole('button', { name: 'Forget everything', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Forget everything?' })
    await expect(dialog).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(panel.getByText('I prefer concise replies', { exact: true })).toBeVisible()
    await toggle.press('Space')
    const switchDialog = page.getByRole('dialog', {
      name: 'Turn memory off and forget everything?',
    })
    await expect(switchDialog).toBeVisible()
    await switchDialog.getByRole('button', { name: 'Cancel' }).click()
    await expect(switchDialog).toHaveCount(0)
    await expect(toggle).toBeChecked()
    await expect(panel.getByText('I prefer concise replies', { exact: true })).toBeVisible()
    await toggle.press('Space')
    await switchDialog.getByRole('button', { name: 'Confirm forget everything' }).click()
    await expect(switchDialog).toHaveCount(0)
    await expect(panel.getByText('No saved memories.')).toBeVisible()
    await expect(toggle).not.toBeChecked()
    await toggle.press('Space')
    await expect(toggle).toBeChecked()
    await expect(toggle).toBeEnabled()
    const reseed = new pg.Client({ connectionString: TEST_DATABASE_URL })
    await reseed.connect()
    try {
      await reseed.query(
        `INSERT INTO memories (id, user_id, kind, tier, content, evidence, embedding, embed_space)
         VALUES ('m7-third', $1, 'preference', 'verda', 'Synthetic again', 'Synthetic again', $2::vector, 'synthetic')`,
        [BYPASS_USER_ID, JSON.stringify(Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)))],
      )
    } finally {
      await reseed.end()
    }
    await page.reload()
    await page.getByRole('tab', { name: 'Memory', exact: true }).click()
    await expect(panel.getByText('Synthetic again', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Forget everything', exact: true }).click()
    await dialog.getByRole('button', { name: 'Confirm forget everything' }).click()
    await expect(dialog).toHaveCount(0)
    await expect(panel.getByText('No saved memories.')).toBeVisible()
    await expect(toggle).not.toBeChecked()
    await page.reload()
    await page.getByRole('tab', { name: 'Memory', exact: true }).click()
    await expect(panel.getByText('No saved memories.')).toBeVisible()
    await expect(toggle).not.toBeChecked()
    const report = await new AxeBuilder({ page })
      .include('section[aria-label="What I remember about you"]')
      .analyze()
    expect(
      report.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
    ).toEqual([])
  })
}
