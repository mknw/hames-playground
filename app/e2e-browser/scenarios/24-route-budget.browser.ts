/** #1017, layer 3: the existing generic dialog shows the budgets, repeat-write
 * warning and safe default without any new UI implementation. */
import AxeBuilder from '@axe-core/playwright'
import { test, expect } from '../lib/fixtures'
import { open } from '../lib/chat'
import { answerCount, seedPaused } from '../lib/blocking-fixtures'

for (const theme of ['dark', 'light'] as const) {
  test(`route exhaustion offers answer and continue with the restart warning in ${theme}`, async ({
    page,
    appUrl,
  }) => {
    const id = `e2e-route-budget-${theme}`
    const requestId = `7c1f6c1e-2f55-4f0e-9d0f-6a0b9d8f4e${theme === 'dark' ? '81' : '82'}`
    await open(page, appUrl, { theme })
    await seedPaused(id, requestId, null, 'Synthetic bounded work', {
      kind: 'route-budget',
      question: 'office-data reached its attempt limit. How should we finish?',
      options: [
        { id: 'answer', label: 'Answer with what we have', unattended: true },
        { id: 'continue', label: 'Continue with a larger budget' },
      ],
      defaultOption: 'answer',
      summary: {
        route: 'office-data',
        originalBudget: 6,
        retryBudget: 9,
        continuation:
          'Continuing re-runs the route from scratch and may repeat file writes in the sandbox. One extra dispatch is available per turn.',
      },
    })
    await page.goto(`${appUrl}/?c=${id}`)
    const card = page.getByRole('region', { name: 'Waiting for your decision' })
    await card.getByRole('button', { name: 'Review' }).focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', {
      name: 'office-data reached its attempt limit. How should we finish?',
    })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('may repeat file writes in the sandbox')
    await expect(dialog).toContainText('6')
    await expect(dialog).toContainText('9')
    await expect(
      dialog.getByRole('button', { name: 'Answer with what we have', exact: true }),
    ).toBeFocused()
    await expect(
      dialog.getByRole('button', { name: 'Continue with a larger budget', exact: true }),
    ).toBeEnabled()
    const scan = await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
    expect(
      scan.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
    ).toEqual([])
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(await answerCount(requestId)).toBe(0)
  })
}
