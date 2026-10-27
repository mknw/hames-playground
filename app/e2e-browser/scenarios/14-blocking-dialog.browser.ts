/** Decision-loop-agent slice 9, layer 3: the blocking dialog as a person meets
 * it — both palettes, keyboard only.
 *
 * No turn is sent: a synthetic conversation that waits on one blocking request,
 * with its held payload row (`lib/blocking-fixtures.ts`). What only this layer
 * can say: the card's Review opens the dialog by keyboard with focus on the
 * SAFE action, the held payload is shown line for line with a bidi control made
 * visible and markup inert, Escape decides nothing, the focused control stays
 * on screen in a small viewport (as at 200% zoom), and axe finds nothing
 * serious. The warning band arrives with a kind that has one (slice 10).
 */
import AxeBuilder from '@axe-core/playwright'
import { test, expect } from '../lib/fixtures'
import { open } from '../lib/chat'
import { answerCount, seedPaused, seedPausedMany } from '../lib/blocking-fixtures'

const HOSTILE = '<img src=x onerror="window.__pwned=1">'
const PAYLOAD = `MATCH (n) // inspect only\nDETACH DELETE n\ninvoice‮fdp.exe ${HOSTILE}`

const serious = (r: { violations: { impact?: string | null }[] }) =>
  r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')

for (const theme of ['dark', 'light'] as const) {
  test(`a paused conversation's decision opens by keyboard on the safe action, in ${theme}`, async ({
    page,
    appUrl,
  }) => {
    const request = `7c1f6c1e-2f55-4f0e-9d0f-6a0b9d8f4e1${theme === 'dark' ? '1' : '2'}`
    const id = `e2e-s9-blocking-${theme}`
    await open(page, appUrl, { theme })
    await seedPaused(id, request, PAYLOAD, `Edit ${HOSTILE}`)
    await page.goto(`${appUrl}/?c=${id}`)

    const card = page.getByRole('region', { name: 'Waiting for your decision' })
    await expect(card).toBeVisible()
    await expect(card).toContainText('One decision needed')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // ---- Review by keyboard; focus lands on the safe action -----------------
    await card.getByRole('button', { name: 'Review' }).focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Change the knowledge graph?' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Reject' })).toBeFocused()

    // ---- the payload, losslessly and inertly --------------------------------
    const payload = dialog.getByTestId('hitl-blocking-payload')
    await expect(payload).toContainText('invoice⟨U+202E⟩fdp.exe')
    expect((await payload.innerText()).split('\n').slice(0, 2)).toEqual([
      'MATCH (n) // inspect only',
      'DETACH DELETE n',
    ])
    await expect(dialog.locator('img')).toHaveCount(0)
    expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined()
    expect(serious(await new AxeBuilder({ page }).include('[role="dialog"]').analyze())).toEqual([])

    // ---- Escape decides nothing ---------------------------------------------
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(card).toBeVisible()
    expect(await answerCount(request)).toBe(0)
  })
}

test('in a small viewport (as at 200% zoom) the focused control is on screen', async ({
  page,
  appUrl,
}) => {
  const request = '7c1f6c1e-2f55-4f0e-9d0f-6a0b9d8f4e13'
  const id = 'e2e-s9-blocking-zoom'
  await open(page, appUrl, { theme: 'dark' })
  const long = Array.from({ length: 80 }, (_, i) => `SET n.p${i} = ${i}`).join('\n')
  await seedPaused(id, request, long)
  await page.setViewportSize({ width: 640, height: 400 })
  await page.goto(`${appUrl}/?c=${id}`)
  await page
    .getByRole('region', { name: 'Waiting for your decision' })
    .getByRole('button', { name: 'Review' })
    .click()
  const reject = page.getByRole('dialog').getByRole('button', { name: 'Reject' })
  await expect(reject).toBeFocused()
  await expect(reject).toBeInViewport()
})

// #803 review B2 and B3: two decisions, answered one after another.
test('the next decision’s safe action takes focus, and a double-click answers nothing unseen', async ({
  page,
  appUrl,
}) => {
  const first = '7c1f6c1e-2f55-4f0e-9d0f-6a0b9d8f4e21'
  const second = '7c1f6c1e-2f55-4f0e-9d0f-6a0b9d8f4e22'
  const id = 'e2e-s9-blocking-two'
  await open(page, appUrl, { theme: 'dark' })
  await seedPausedMany(id, [
    { requestId: first, payload: 'SET n.a = 1' },
    { requestId: second, payload: 'SET n.b = 2' },
  ])
  await page.goto(`${appUrl}/?c=${id}`)
  const card = page.getByRole('region', { name: 'Waiting for your decision' })
  await expect(card).toContainText('2 decisions needed')
  await card.getByRole('button', { name: 'Review' }).focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog')
  await expect(dialog).toContainText('Decision 1 of 2')

  // B3: a double-click on the first decision's button answers only the first.
  await dialog.getByRole('button', { name: 'Approve this change' }).dblclick()
  await expect(dialog).toContainText('Decision 2 of 2')
  await expect(dialog).toContainText('SET n.b = 2')

  // B2: focus is on the second decision's safe action, not the page body.
  await expect(dialog.getByRole('button', { name: 'Reject' })).toBeFocused()
  expect(await answerCount(first)).toBe(0)
  expect(await answerCount(second)).toBe(0)
})
