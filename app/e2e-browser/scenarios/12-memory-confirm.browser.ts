/** #419 M6 layer 3: the "Save to memory?" prompt as a person meets it.
 *
 * No turn is sent and no model is involved: a synthetic conversation holding one
 * open `memory.confirm` proposal, and its held payload row, are seeded with `pg`
 * after the app created its schema (legacy plaintext reads are supported; these
 * are synthetic fixtures only). What only this layer can say: the notice is
 * painted and announced without taking focus, Review moves focus into the dialog,
 * Escape decides nothing, and the painted dialog passes axe in both palettes.
 */
import AxeBuilder from '@axe-core/playwright'
import { test, expect } from '../lib/fixtures'
import { open } from '../lib/chat'
import { rowStatus as rowStatusOf, savedMemories, seedProposal } from '../lib/memory-fixtures'

const REQUEST = '3b1f6c1e-2f55-4f0e-9d0f-6a0b9d8f4e11'

const rowStatus = () => rowStatusOf(REQUEST)

for (const theme of ['dark', 'light'] as const) {
  test(`a prepared memory is confirmed, not saved by surprise, in ${theme}`, async ({
    page,
    appUrl,
  }) => {
    await open(page, appUrl, { theme })
    // The user's memory switch must be ON for a proposal to be offered at all.
    await page.getByRole('tab', { name: 'Memory', exact: true }).click()
    const toggle = page
      .getByRole('region', { name: 'What I remember about you' })
      .getByRole('checkbox', { name: 'Memory enabled' })
    await toggle.press('Space')
    await expect(toggle).toBeChecked()
    await expect(toggle).toBeEnabled()

    const id = `e2e-m6-prompt-${theme}`
    await seedProposal(id, REQUEST)
    await page.goto(`${appUrl}/?c=${id}`)

    // ---- the notice: announced, painted, and focus stays where it was -------
    const notice = page.getByRole('status').filter({ hasText: 'Save to memory? 2 items' })
    await expect(notice).toBeVisible()
    const focusedBefore = await page.evaluate(() => document.activeElement?.tagName)
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(focusedBefore)
    expect(await page.evaluate(() => !!document.activeElement?.closest('[role="status"]'))).toBe(
      false,
    )
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // ---- Review moves focus INTO the dialog ----------------------------------
    await notice.getByRole('button', { name: 'Review' }).click()
    const dialog = page.getByRole('dialog', { name: 'Save to memory?' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('The user prefers synthetic examples.')).toBeVisible()
    await expect(dialog.getByText('The user’s team is Aurora.')).toBeVisible()
    await expect
      .poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')))
      .toBe(true)

    // ---- axe, on the painted dialog ------------------------------------------
    const dialogReport = await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
    expect(
      dialogReport.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
    ).toEqual([])

    // ---- Escape decides NOTHING ------------------------------------------------
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(notice).toBeVisible()
    expect(await rowStatus()).toBe('pending')
    expect(await savedMemories()).toBe(0)
    const noticeReport = await new AxeBuilder({ page })
      .include('[data-testid="memory-proposal-notice"]')
      .analyze()
    expect(
      noticeReport.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
    ).toEqual([])

    // ---- "Don't save": by keyboard-reachable button, saves nothing, closes it ---
    await notice.getByRole('button', { name: 'Review' }).click()
    await dialog.getByRole('button', { name: "Don't save" }).click()
    await expect(page.getByText('Nothing was saved.')).toBeVisible()
    await expect(dialog).toHaveCount(0)
    await expect.poll(rowStatus).toBe('applied')
    expect(await savedMemories()).toBe(0)
  })
}
