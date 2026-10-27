/** Run with E2E_PRIVATE_ONLY=1; uses the normal hermetic server and fakes. */
import { test, expect } from '../lib/fixtures'
import { open, send, tierOption, TIER_LABEL, waitForReplies } from '../lib/chat'
import { setStoredTier } from '../lib/db'
import { FAKE_ANTHROPIC_TIER_MODEL } from '../lib/env'

test('private-only server keeps Anthropic visible, greyed, disabled and explained across reloads', async ({
  page,
  appUrl,
  backend,
}) => {
  test.skip(process.env.E2E_PRIVATE_ONLY !== '1', 'Requires the private-only server configuration')
  await setStoredTier('anthropic')
  await open(page, appUrl)
  const publicOption = tierOption(page, TIER_LABEL.anthropic)
  await expect(publicOption).toBeVisible()
  await expect(publicOption).toHaveAttribute('data-disabled', '')
  await expect(publicOption).toHaveCSS('opacity', '0.5')
  await expect(publicOption).toHaveAttribute('title', /private inference only/)
  await expect(page.getByRole('radio', { name: TIER_LABEL.anthropic })).toBeDisabled()
  await expect(page.getByRole('radio', { name: TIER_LABEL.self_deployed })).toBeChecked()
  // A disabled label must not change state even under a forced pointer click.
  await publicOption.click({ force: true })
  await expect(page.getByRole('radio', { name: TIER_LABEL.self_deployed })).toBeChecked()
  await send(page, 'Count graph nodes privately')
  await waitForReplies(page, 1)
  const calls = await backend.calls()
  expect(calls.length).toBeGreaterThan(0)
  expect(calls.some((call) => call.model === FAKE_ANTHROPIC_TIER_MODEL)).toBe(false)
  await page.reload()
  await expect(publicOption).toBeVisible()
  await expect(page.getByRole('radio', { name: TIER_LABEL.anthropic })).toBeDisabled()
  await expect(page.getByRole('radio', { name: TIER_LABEL.self_deployed })).toBeChecked()
})
