/** #433 S8 layer 3 (#589 F9): the toast, the header inbox and erasure, as a
 * person meets them — both palettes, keyboard only where it matters.
 *
 * No turn is sent and no model is involved: synthetic conversations holding an
 * open `memory.confirm` proposal and its held payload row (see
 * `lib/memory-fixtures.ts`). What only this layer can say: the badge has an
 * accessible name, the keyboard alone opens the menu and selects a row, the
 * selection crosses the route and the dialog opens with focus inside it, hostile
 * text stays inert, Escape decides nothing, the toast is announced without
 * taking focus and opens the SAME single dialog, and erasing memory removes the
 * card, the toast and the badge without a reload.
 */
import AxeBuilder from '@axe-core/playwright'
import type { Locator, Page } from '@playwright/test'
import { test, expect } from '../lib/fixtures'
import { open } from '../lib/chat'
import { rowStatus, savedMemories, seedMemory, seedProposal } from '../lib/memory-fixtures'

const HOSTILE = '<img src=x onerror="window.__pwned=1">'
const ITEMS = [
  { content: `The user likes ${HOSTILE}`, evidence: `I like ${HOSTILE}` },
  { content: 'The user’s team is Aurora.', evidence: 'my team is Aurora', kind: 'semantic' },
]

async function enableMemory(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Memory', exact: true }).click()
  const toggle = page
    .getByRole('region', { name: 'What I remember about you' })
    .getByRole('checkbox', { name: 'Memory enabled' })
  await toggle.press('Space')
  await expect(toggle).toBeChecked()
  await expect(toggle).toBeEnabled()
}

/** The proposal row appeared after the page loaded: nudge the chat's window-focus
 *  read until it has seen it (the first read may still be in flight). */
async function arrive(page: Page, toast: Locator): Promise<void> {
  await expect
    .poll(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')))
      return toast.count()
    })
    .toBe(1)
}

const serious = (r: { violations: { impact?: string | null }[] }) =>
  r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')

for (const theme of ['dark', 'light'] as const) {
  test(`the header inbox leads to the dialog by keyboard, inertly, in ${theme}`, async ({
    page,
    appUrl,
  }) => {
    const request = `5a1f6c1e-2f55-4f0e-9d0f-6a0b9d8f4e1${theme === 'dark' ? '1' : '2'}`
    const id = `e2e-s8-inbox-${theme}`
    await open(page, appUrl, { theme })
    await enableMemory(page)
    // the proposal lives in conversation B; the person is looking at the start page (A)
    await seedProposal(id, request, ITEMS, `Trip ${HOSTILE}`)
    await page.goto(`${appUrl}/`)

    const trigger = page.getByRole('button', { name: 'Waiting on you: 1' })
    await expect(trigger).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // ---- keyboard alone opens the menu; hostile text is inert ---------------
    await trigger.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByTestId('hitl-inbox-menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByText(`Trip ${HOSTILE}`)).toBeVisible()
    await expect(menu.locator('img')).toHaveCount(0)
    expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined()
    expect(
      serious(await new AxeBuilder({ page }).include('[data-testid="hitl-inbox-menu"]').analyze()),
    ).toEqual([])

    // ---- Escape decides nothing ------------------------------------------------
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(trigger).toBeVisible()
    expect(await rowStatus(request)).toBe('pending')

    // ---- select the row by keyboard: navigate, open the dialog, focus inside ---
    await trigger.focus()
    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(page).toHaveURL(new RegExp(`[?&]c=${id}`))
    const dialog = page.getByRole('dialog', { name: 'Save to memory?' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByText('The user’s team is Aurora.')).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expect
      .poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')))
      .toBe(true)
    await expect(dialog.locator('img')).toHaveCount(0)
    expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined()
    expect(serious(await new AxeBuilder({ page }).include('[role="dialog"]').analyze())).toEqual([])

    // ---- Escape decides nothing; the badge is unchanged ------------------------
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Waiting on you: 1' })).toBeVisible()
    expect(await rowStatus(request)).toBe('pending')
    expect(await savedMemories()).toBe(0)
  })

  test(`the toast is announced without taking focus and opens the one dialog, in ${theme}`, async ({
    page,
    appUrl,
  }) => {
    const request = `6b1f6c1e-2f55-4f0e-9d0f-6a0b9d8f4e1${theme === 'dark' ? '1' : '2'}`
    const id = `e2e-s8-toast-${theme}`
    await open(page, appUrl, { theme })
    await enableMemory(page)
    // the conversation is open with nothing pending; the proposal ARRIVES afterwards
    await seedProposal(id, request, ITEMS, null, 'conversation')
    await page.goto(`${appUrl}/?c=${id}`)
    // the chat's first read must have COMPLETED before the proposal arrives
    await page.waitForLoadState('networkidle')
    await expect(page.getByTestId('memory-proposal-notice')).toHaveCount(0)
    await seedProposal(id, request, ITEMS, null, 'payload')
    const focusedBefore = await page.evaluate(() => document.activeElement?.tagName)
    const toast = page.getByTestId('memory-proposal-toast')
    await arrive(page, toast)
    await expect(toast).toBeVisible()
    await expect(toast).toContainText('Save to memory?')
    // announced politely, and focus did not move
    expect(await toast.evaluate((el) => !!el.closest('[aria-live="polite"]'))).toBe(true)
    await page.waitForTimeout(300)
    expect(await page.evaluate(() => document.activeElement?.tagName)).toBe(focusedBefore)
    expect(
      await page.evaluate(() => !!document.activeElement?.closest('[data-scope="toast"]')),
    ).toBe(false)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    expect(
      serious(
        await new AxeBuilder({ page }).include('[data-testid="memory-proposal-toast"]').analyze(),
      ),
    ).toEqual([])

    // ---- Review by keyboard: the same single dialog --------------------------------
    await toast.getByRole('button', { name: 'Review' }).focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Save to memory?' })
    await expect(dialog).toBeVisible()
    await expect(page.getByRole('dialog')).toHaveCount(1)
    await expect
      .poll(() => page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')))
      .toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    expect(await rowStatus(request)).toBe('pending')
  })

  test(`erasing memory removes the card, the toast and the badge without a reload, in ${theme}`, async ({
    page,
    appUrl,
  }) => {
    const request = `7c1f6c1e-2f55-4f0e-9d0f-6a0b9d8f4e1${theme === 'dark' ? '1' : '2'}`
    const id = `e2e-s8-erase-${theme}`
    await open(page, appUrl, { theme })
    await enableMemory(page)
    await seedMemory(`m-s8-${theme}`, 'I prefer synthetic examples')
    await seedProposal(id, request, ITEMS, null, 'conversation')
    await page.goto(`${appUrl}/?c=${id}`)
    await page.waitForLoadState('networkidle')
    await seedProposal(id, request, ITEMS, null, 'payload')
    await arrive(page, page.getByTestId('memory-proposal-toast'))
    await expect(page.getByTestId('memory-proposal-toast')).toBeVisible()
    await expect(page.getByTestId('memory-proposal-notice')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Waiting on you: 1' })).toBeVisible()

    await page.getByRole('tab', { name: 'Memory', exact: true }).click()
    const panel = page.getByRole('region', { name: 'What I remember about you' })
    await expect(panel.getByText('I prefer synthetic examples', { exact: true })).toBeVisible()
    await panel.getByRole('button', { name: 'Forget everything' }).click()
    await page.getByRole('button', { name: 'Confirm forget everything' }).click()

    // no reload: the surfaces go on their own, and with them the proposal's text
    await expect(page.getByTestId('memory-proposal-notice')).toHaveCount(0, { timeout: 5_000 })
    await expect(page.getByTestId('memory-proposal-toast')).toHaveCount(0, { timeout: 5_000 })
    await expect(page.getByRole('button', { name: /Waiting on you/ })).toHaveCount(0, {
      timeout: 5_000,
    })
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByText('The user’s team is Aurora.')).toHaveCount(0)
    expect(await savedMemories()).toBe(0)
  })

  for (const withMemory of [false, true]) {
    test(`switching memory off removes the card, the toast and the badge without a reload${withMemory ? ' (via the confirm dialog)' : ' (directly)'}, in ${theme}`, async ({
      page,
      appUrl,
    }) => {
      const tag = `${theme}-${withMemory ? 'c' : 'd'}`
      const request = `8d1f6c1e-2f55-4f0e-9d0f-6a0b9d8f4e${withMemory ? '1' : '2'}${theme === 'dark' ? '1' : '2'}`
      const id = `e2e-s8-off-${tag}`
      await open(page, appUrl, { theme })
      await enableMemory(page)
      if (withMemory) await seedMemory(`m-s8-off-${tag}`, 'I prefer synthetic examples')
      await seedProposal(id, request, ITEMS, null, 'conversation')
      await page.goto(`${appUrl}/?c=${id}`)
      await page.waitForLoadState('networkidle')
      await seedProposal(id, request, ITEMS, null, 'payload')
      await arrive(page, page.getByTestId('memory-proposal-toast'))
      await expect(page.getByTestId('memory-proposal-notice')).toBeVisible()
      await expect(page.getByRole('button', { name: 'Waiting on you: 1' })).toBeVisible()

      await page.getByRole('tab', { name: 'Memory', exact: true }).click()
      const panel = page.getByRole('region', { name: 'What I remember about you' })
      await panel.getByRole('checkbox', { name: 'Memory enabled' }).press('Space')
      if (withMemory) {
        await page.getByRole('button', { name: 'Confirm forget everything' }).click()
      } else {
        // nothing to forget: no confirm dialog stands between the switch and the erase
        await expect(page.getByRole('dialog')).toHaveCount(0)
      }

      await expect(page.getByTestId('memory-proposal-notice')).toHaveCount(0, { timeout: 5_000 })
      await expect(page.getByTestId('memory-proposal-toast')).toHaveCount(0, { timeout: 5_000 })
      await expect(page.getByRole('button', { name: /Waiting on you/ })).toHaveCount(0, {
        timeout: 5_000,
      })
      await expect(page.getByText('The user’s team is Aurora.')).toHaveCount(0)
      expect(await savedMemories()).toBe(0)
    })
  }
}
