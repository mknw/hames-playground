/** Boundary guards slice 10, layer 3: the dialog an outgoing request is held
 * in, as a person meets it — both palettes, keyboard only.
 *
 * No turn is sent: a synthetic conversation that waits on one `egress-release`
 * request, with its held payload row (`lib/blocking-fixtures.ts`). What only
 * this layer can say: the band and the four buttons render with their glyphs
 * (an icon class that emits no CSS renders nothing, which jsdom cannot see),
 * focus opens on Refuse and Tab walks the buttons in the owner's order, a
 * match in the request is highlighted, and axe finds nothing serious.
 */
import AxeBuilder from '@axe-core/playwright'
import { test, expect } from '../lib/fixtures'
import { open } from '../lib/chat'
import { answerCount, seedPaused } from '../lib/blocking-fixtures'

const EGRESS = {
  kind: 'egress-release',
  question: 'Send this request to an outside service?',
  options: [
    { id: 'refuse', label: 'Refuse', unattended: true },
    { id: 'accept', label: 'Accept', tone: 'danger' },
    { id: 'refuse-all', label: 'Refuse all similar actions' },
    { id: 'interrupt', label: 'Interrupt', stopsRun: true },
  ],
  defaultOption: 'refuse',
  summary: { category: 'personal', closes: true },
}
const PAYLOAD = {
  tool: 'fetch',
  args: { url: 'https://redirect.example/?to=https://collector.test/x' },
  lines: ['url: https://redirect.example/?to=https://collector.test/x', 'note: Ravi Example'],
  hosts: ['redirect.example', 'collector.test'],
  spans: ['Ravi Example'],
}

const serious = (r: { violations: { impact?: string | null }[] }) =>
  r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')

for (const theme of ['dark', 'light'] as const) {
  test(`an outgoing request held for the person opens on Refuse, in ${theme}`, async ({
    page,
    appUrl,
  }) => {
    const request = `5d2e7b0a-1c3f-4e5a-8b9c-0d1e2f3a4b5${theme === 'dark' ? '1' : '2'}`
    const id = `e2e-bg10-egress-${theme}`
    await open(page, appUrl, { theme })
    await seedPaused(id, request, PAYLOAD, 'Synthetic lookup', EGRESS)
    await page.goto(`${appUrl}/?c=${id}`)

    const card = page.getByRole('region', { name: 'Waiting for your decision' })
    await card.getByRole('button', { name: 'Review' }).focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Send this request to an outside service?' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByTestId('hitl-blocking-dialog-warning')).toContainText(
      'Check before sending',
    )
    await expect(dialog).toContainText(
      'The assistant wants to send this request to redirect.example and collector.test.',
    )
    await expect(dialog.getByTestId('hitl-blocking-flagged')).toHaveText('Ravi Example')

    // ---- focus on Refuse; Tab in the owner's order ---------------------------
    const order = ['Refuse', 'Accept', 'Refuse all similar actions', 'Interrupt']
    await expect(dialog.getByRole('button', { name: order[0], exact: true })).toBeFocused()
    for (const name of order.slice(1)) {
      await page.keyboard.press('Tab')
      await expect(dialog.getByRole('button', { name, exact: true })).toBeFocused()
    }

    // ---- every glyph is drawn: its class emitted a mask image ------------
    for (const name of order) {
      const mask = await dialog
        .getByRole('button', { name, exact: true })
        .locator('[class^="i-material-symbols"]')
        .evaluate((el) => {
          const style = getComputedStyle(el)
          return style.maskImage || style.getPropertyValue('-webkit-mask-image')
        })
      expect(mask, name).toContain('url(')
    }
    expect(serious(await new AxeBuilder({ page }).include('[role="dialog"]').analyze())).toEqual([])

    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(await answerCount(request)).toBe(0)
  })
}

// N8-09. MUTATIONS: truncate a row, default Accept, or put the actions inside
// the scroller → the last marker, initial state, or keyboard path turns red.
test('a long N8 checklist stays readable and keyboard-operable', async ({ page, appUrl }) => {
  const request = '5d2e7b0a-1c3f-4e5a-8b9c-0d1e2f3a4b59'
  const id = 'e2e-n8-long-checklist'
  const rows = Array.from({ length: 24 }, (_, index) => ({
    index,
    callKey: `synthetic-key-${index}`,
    digest: `digest-${index}`,
    tool: 'synthetic_search',
    args: { query: `${'x'.repeat(2000)}LAST-${index}` },
    hosts: ['example.test'],
    lines: [`query ${index}`],
    spans: [],
  }))
  const options = [
    {
      id: 'continue',
      label: 'Continue with selected requests',
      unattended: true,
      flags: rows.map((r) => ({
        id: `accept:${r.callKey}`,
        label: `Request ${r.index + 1}`,
        default: false,
      })),
    },
    { id: 'refuse-all', label: 'Refuse all similar actions' },
    { id: 'interrupt', label: 'Interrupt', stopsRun: true },
  ]
  await open(page, appUrl, { theme: 'dark' })
  await seedPaused(
    id,
    request,
    { v: 1, mode: 'parallel', members: rows, rows },
    'Synthetic long checklist',
    {
      kind: 'egress-batch-release',
      question: 'Review requests to outside services',
      options,
      defaultOption: 'continue',
      summary: { count: rows.length },
    },
  )
  await page.goto(`${appUrl}/?c=${id}`)
  await page
    .getByRole('region', { name: 'Waiting for your decision' })
    .getByRole('button', { name: 'Review' })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Review requests to outside services' })
  await expect(dialog).toBeVisible()
  await expect(
    dialog.getByRole('button', { name: 'Continue with selected requests' }),
  ).toBeFocused()
  await expect(dialog.locator('[data-testid^="hitl-batch-row-"]')).toHaveCount(24)
  await expect(dialog.getByTestId('hitl-batch-args-23')).toContainText('LAST-23')
  await expect(dialog.getByTestId('hitl-batch-row-23')).toContainText('Refuse')
  await dialog.getByRole('button', { name: 'Request 24' }).focus()
  await page.keyboard.press('Enter')
  await expect(dialog.getByTestId('hitl-batch-row-23')).toBeFocused()
  expect(await dialog.getByTestId('hitl-batch-row-23').ariaSnapshot()).toContain(
    'Request 24: synthetic_search',
  )
  const lastChoice = dialog.getByTestId('hitl-batch-choice-23').getByRole('checkbox')
  const choiceRoot = dialog.getByTestId('hitl-batch-choice-23')
  const unfocusedRing = await choiceRoot.evaluate((node) => getComputedStyle(node).boxShadow)
  await expect(lastChoice).not.toBeChecked()
  await page.keyboard.press('Tab')
  await expect(dialog.getByText('Decoded and normalized view').last()).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(lastChoice).toBeFocused()
  const focusedRing = await choiceRoot.evaluate((node) => getComputedStyle(node).boxShadow)
  expect(focusedRing).not.toBe(unfocusedRing)
  expect(focusedRing).toMatch(/rgba?\(/)
  await page.keyboard.press('Space')
  await expect(dialog.getByTestId('hitl-batch-row-23')).toContainText('Accept')
  await expect(dialog.getByTestId('hitl-batch-row-0')).toContainText('Refuse')
  expect(serious(await new AxeBuilder({ page }).include('[role="dialog"]').analyze())).toEqual([])
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  expect(await answerCount(request)).toBe(0)
})
