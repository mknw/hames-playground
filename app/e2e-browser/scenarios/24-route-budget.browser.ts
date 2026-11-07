/** #1017, layer 3: the existing generic dialog shows the budgets, repeat-write
 * warning and safe default without any new UI implementation. */
import AxeBuilder from '@axe-core/playwright'
import pg from 'pg'
import { test, expect } from '../lib/fixtures'
import { open } from '../lib/chat'
import { answerCount, seedPaused } from '../lib/blocking-fixtures'
import { BYPASS_USER_ID, TEST_DATABASE_URL } from '../lib/env'
import type { ContextEvent } from '@hames-ai/harness-patterns'

for (const theme of ['dark', 'light'] as const) {
  test(`successful continuation clears its warning live and after reload in ${theme}`, async ({
    page,
    appUrl,
  }) => {
    const id = `e2e-route-recovered-${theme}`
    const requestId = `6c1f6c1e-2f55-4f0e-9d0f-6a0b9d8f4e${theme === 'dark' ? '81' : '82'}`
    await open(page, appUrl, { theme })
    await seedPaused(id, requestId, null, 'Synthetic recovery', {
      kind: 'route-budget',
      question: 'Synthetic work reached its limit',
      options: [
        { id: 'answer', label: 'Answer with what we have', unattended: true },
        { id: 'continue', label: 'Continue with a larger budget' },
      ],
      defaultOption: 'answer',
      summary: { route: 'work', originalBudget: 1, retryBudget: 4 },
    })
    const client = new pg.Client({ connectionString: TEST_DATABASE_URL })
    await client.connect()
    try {
      const { rows } = await client.query(
        'SELECT context FROM conversations WHERE id = $1 AND user_id = $2',
        [id, BYPASS_USER_ID],
      )
      const context = rows[0].context
      const error: ContextEvent = {
        id: 'budget-error',
        ts: 2,
        type: 'error',
        patternId: 'work',
        data: {
          error: 'Synthetic route attempt limit',
          kind: 'budget_exhausted',
          severity: 'recoverable',
        },
      }
      const failed: ContextEvent = {
        id: 'failed-record',
        ts: 3,
        type: 'tool_result',
        patternId: 'orchestrator',
        data: {
          tool: 'work',
          success: false,
          result: null,
          error: 'Synthetic route attempt limit',
          routeRecord: { iteration: 1, budgetErrorId: error.id },
        },
      }
      context.events.splice(1, 0, error, failed)
      await client.query(
        'UPDATE conversations SET context = $2::jsonb WHERE id = $1 AND user_id = $3',
        [id, JSON.stringify(context), BYPASS_USER_ID],
      )
      await page.goto(`${appUrl}/?c=${id}`)
      const warnings = page.locator('[data-role="warning"]')
      await expect(warnings.filter({ hasText: 'Synthetic route attempt limit' })).toBeVisible()
      // Script only the continuation's wire response. Layer 2 proves the real
      // loop/host/persistence path; this layer proves the painted reconciliation.
      await page.route('**/api/events', async (route) => {
        const success: ContextEvent = {
          id: 'success-record',
          ts: 4,
          type: 'tool_result',
          patternId: 'orchestrator',
          data: {
            tool: 'work',
            success: true,
            result: 'Synthetic complete result',
            routeRecord: {
              iteration: 2,
              supersedes: { recordId: failed.id!, budgetErrorId: error.id! },
            },
          },
        }
        context.status = 'done'
        context.events.push(success, {
          id: 'answer',
          ts: 5,
          type: 'assistant_message',
          patternId: 'synth',
          data: { content: 'Synthetic complete result', final: true },
        })
        await client.query(
          "UPDATE conversations SET context = $2::jsonb, status = 'done' WHERE id = $1 AND user_id = $3",
          [id, JSON.stringify(context), BYPASS_USER_ID],
        )
        await route.fulfill({
          contentType: 'text/event-stream',
          body: [
            `event: message\ndata: ${JSON.stringify(success)}\n\n`,
            `event: done\ndata: ${JSON.stringify({ status: 'done', response: 'Synthetic complete result', context })}\n\n`,
          ].join(''),
        })
      })
      await page
        .getByRole('region', { name: 'Waiting for your decision' })
        .getByRole('button', { name: 'Review' })
        .click()
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Continue with a larger budget', exact: true })
        .click()
      await expect(
        page.locator('[data-role="assistant"]').filter({ hasText: 'Synthetic complete result' }),
      ).toBeVisible()
      await expect(warnings).toHaveCount(0)
      await page.reload()
      await expect(
        page.locator('[data-role="assistant"]').filter({ hasText: 'Synthetic complete result' }),
      ).toBeVisible()
      await expect(page.locator('[data-role="warning"]')).toHaveCount(0)
    } finally {
      await client.end()
    }
  })

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
